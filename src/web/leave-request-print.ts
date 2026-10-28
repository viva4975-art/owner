import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { ABSENCE_COLORS } from '../domain/time/absence-colors.js';
import {
  ABSENCE_LABEL,
  type AbsenceKind,
  type AbsenceRow,
  absenceDays,
  applicationDate,
  leaveBalance,
  leaveDaysOf,
  listAbsences,
} from '../services/absences.js';
import { EMPLOYMENT_TYPES } from '../services/employees.js';
import { dateDe } from './layout.js';

/*
 * Gedruckte Urlaubsanträge (Ahmed 28.10.): je Antrag eine A4-Seite, fertig ausgefüllt zum Unterschreiben.
 * Unterschriftsdatum = erfasstes Antragsdatum, sonst 5 Tage vor Beginn.
 */

/** Arten, für die es einen Antrag gibt (Krankheit wird gemeldet, nicht beantragt) */
export const REQUEST_KINDS: AbsenceKind[] = ['urlaub', 'unbezahlt', 'sonstiges'];

const TITLE: Partial<Record<AbsenceKind, string>> = {
  urlaub: 'Urlaubsantrag',
  unbezahlt: 'Antrag auf unbezahlte Freistellung',
  sonstiges: 'Antrag auf Freistellung',
};

const LEGAL: Partial<Record<AbsenceKind, string>> = {
  urlaub:
    'Urlaub nach Bundesurlaubsgesetz (§ 7 BUrlG). Der Urlaub gilt erst mit Genehmigung als gewährt. Arbeitstage = Tage, an denen laut Einsatzplanung gearbeitet würde (ohne Feiertage).',
  unbezahlt:
    'Während der unbezahlten Freistellung ruht die Vergütung. Dauert sie länger als einen Monat, endet die Mitgliedschaft in der Sozialversicherung (§ 7 Abs. 3 SGB IV) – Abmeldung im Lohnprogramm.',
  sonstiges: 'Bezahlte Freistellung aus persönlichem Anlass (z. B. § 616 BGB bzw. laut Arbeitsvertrag).',
};

const esc = (s: string | null | undefined) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
const num = (n: number) => String(n).replace('.', ',');
const box = (on: boolean) => `<span class="bx">${on ? '✕' : ''}</span>`;

/** Anträge (beantragt/genehmigt) im Zeitraum für die angegebenen Mitarbeitenden. */
export async function requestsOf(sql: Sql, from: string, to: string, employeeIds: Set<string> | null) {
  const rows = await listAbsences(sql, { status: ['beantragt', 'genehmigt'], from, to });
  return rows
    .filter((a) => REQUEST_KINDS.includes(a.kind) && (!employeeIds || employeeIds.has(a.employee_id)))
    .sort(
      (a, b) =>
        a.employee_name.localeCompare(b.employee_name, 'de') || a.start_date.localeCompare(b.start_date),
    );
}

const CSS = `@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Inter,system-ui,Arial,sans-serif;color:#1c1917;margin:0;font-size:13px}
.bar{text-align:center;padding:10px;background:#f4f3f1}.bar button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#7D1435;color:#fff;cursor:pointer}
@media print{.bar{display:none}}
.pg{page-break-after:always;max-width:182mm;margin:0 auto;padding:6mm 0}.pg:last-child{page-break-after:auto}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #7D1435;padding-bottom:8px;margin-bottom:16px}
.hd img{height:46px}.hd .co{text-align:right;font-size:11.5px;color:#44403c;line-height:1.5}
h1{font-size:22px;margin:0 0 4px;padding-left:10px;border-left:6px solid var(--k)}
.sub{color:#57534e;margin:0 0 18px;padding-left:16px}
table.f{width:100%;border-collapse:collapse;margin-bottom:16px}table.f td{border:1px solid #d6d3d1;padding:7px 10px;vertical-align:top}
table.f td.l{width:38%;background:#f5f5f4;color:#44403c;font-size:12px}
.sec{font-weight:700;color:#7D1435;margin:18px 0 8px;font-size:14px}
.pill{display:inline-block;padding:2px 10px;border-radius:10px;color:#fff;font-weight:700;background:var(--k)}
.bx{display:inline-block;width:14px;height:14px;border:1.4px solid #1c1917;vertical-align:-2px;margin-right:6px;text-align:center;line-height:12px;font-size:12px;font-weight:700}
.chk{display:flex;gap:28px;margin:6px 0 4px}
.sig{display:flex;gap:36px;margin-top:22px}.sig>div{flex:1}
.sig .dt{height:20px}.sig .ln{border-bottom:1px solid #444;height:46px}.sig .lb{font-size:11px;color:#57534e;margin-top:3px}
.sig .lb.me{background:#fff3a0;display:inline-block;padding:0 4px}
.legal{font-size:10px;color:#78716c;margin-top:22px;line-height:1.5}`;

export async function leaveRequestsHtml(
  sql: Sql,
  rows: AbsenceRow[],
  emp: Map<string, { personnel_no: string; employment_type: string; weekly_hours: string | number | null }>,
  co: { name: string; street: string; postal_code: string; city: string } | undefined,
): Promise<string> {
  const pages: string[] = [];
  for (const a of rows) {
    const e = emp.get(a.employee_id);
    const col = ABSENCE_COLORS[a.kind];
    const isLeave = a.kind === 'urlaub';
    const days = isLeave
      ? await leaveDaysOf(sql, a.employee_id, a.start_date, a.end_date, a.half_day)
      : absenceDays(a);
    let konto = '';
    if (isLeave) {
      const y = Number(a.start_date.slice(0, 4));
      const bal = await leaveBalance(sql, a.employee_id, y);
      konto = `<div class="sec">Urlaubskonto ${y}</div><table class="f"><tbody>
<tr><td class="l">Urlaubsanspruch ${y}</td><td>${num(bal.entitlement)} Tage${bal.carried ? ` (darin Rest Vorjahr ${num(bal.carried)})` : ''}</td></tr>
<tr><td class="l">Dieser Antrag</td><td>${num(days)} Arbeitstage</td></tr>
<tr><td class="l">Resturlaub nach diesem Antrag</td><td><b>${num(bal.rest)} Tage</b> <span style="color:#78716c;font-size:11px">(Stand ${dateDe(todayBerlin())})</span></td></tr>
</tbody></table>`;
    }
    const signDate = applicationDate(a);
    const city = co?.city ?? '';
    pages.push(`<div class="pg" style="--k:${col.solid}">
<div class="hd"><img src="/static/logo-transparent.png" alt="Viva-Deluxe"><div class="co"><b>${esc(co?.name)}</b><br>${esc(co?.street)}<br>${esc(co?.postal_code)} ${esc(co?.city)}</div></div>
<h1>${esc(TITLE[a.kind] ?? 'Antrag')}</h1>
<p class="sub">an die Personalabteilung</p>
<table class="f"><tbody>
<tr><td class="l">Name, Vorname</td><td><b>${esc(a.employee_name)}</b></td></tr>
<tr><td class="l">Personalnummer</td><td>${esc(e?.personnel_no ?? a.personnel_no)}</td></tr>
<tr><td class="l">Beschäftigung</td><td>${esc(EMPLOYMENT_TYPES[e?.employment_type as keyof typeof EMPLOYMENT_TYPES] ?? '')}${e?.weekly_hours ? ` · ${num(Number(e.weekly_hours))} Std./Woche` : ''}</td></tr>
</tbody></table>
<div class="sec">Ich beantrage</div>
<table class="f"><tbody>
<tr><td class="l">Art</td><td><span class="pill">${esc(ABSENCE_LABEL[a.kind])}</span></td></tr>
<tr><td class="l">Zeitraum</td><td>vom <b>${dateDe(a.start_date)}</b> bis <b>${dateDe(a.end_date)}</b>${a.half_day ? ' (halber Tag)' : ''}</td></tr>
<tr><td class="l">Anzahl Arbeitstage</td><td>${num(days)}</td></tr>
${a.note ? `<tr><td class="l">Bemerkung</td><td>${esc(a.note)}</td></tr>` : ''}
</tbody></table>
${konto}
<div class="sig"><div><div class="dt">${esc(city)}${city ? ', ' : ''}${dateDe(signDate)}</div><div class="ln"></div><div class="lb me">Datum, Unterschrift Mitarbeiter/in – ${esc(a.employee_name)}</div></div><div></div></div>
<div class="sec" style="margin-top:28px">Entscheidung des Arbeitgebers</div>
<div class="chk"><span>${box(a.status === 'genehmigt')}genehmigt</span><span>${box(false)}abgelehnt</span></div>
<div class="sig"><div><div class="dt"></div><div class="ln"></div><div class="lb">Datum, Unterschrift Arbeitgeber</div></div><div><div class="dt"></div><div class="ln"></div><div class="lb">Vertretung (falls nötig)</div></div></div>
<div class="legal">${LEGAL[a.kind] ?? ''}</div>
</div>`);
  }
  return pages.join('');
}

export function leaveRequestsPage(title: string, body: string) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button></div>${body || '<p style="text-align:center;padding:40px;color:#57534e">Keine Anträge für diesen Filter.</p>'}</body></html>`;
}
