import { addMonths } from '../services/cost-centers.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { SiteOptions } from './site-options.js';
import {
  ABSENCE_LABEL,
  type AbsenceKind,
  addAbsenceDay,
  listAbsenceHours,
  listAbsences,
  saveAbsenceHours,
} from '../services/absences.js';
import { BusinessError } from '../services/errors.js';
import { leaveRequestsHtml, leaveRequestsPage, requestsOf } from './leave-request-print.js';
import { EMPLOYMENT_TYPES, listEmployees } from '../services/employees.js';
import { renderTablePdf } from '../pdf/table.js';
import { ABSENCE_COLORS, absenceCss, rgb01 } from '../domain/time/absence-colors.js';
import { hm } from '../services/time.js';
import {
  ABSENCE_SHORT,
  type SheetSignature,
  type Timesheet,
  dayShort,
  latestSignature,
  monthLabel,
  monthRange,
  signaturesOfMonth,
  timesheet,
  sheetForSite,
} from '../services/timesheet.js';
import {
  SURCHARGES,
  HOUR_TYPES,
  type HourType,
  WAGE_TYPES,
  WAGE_TYPE_LABEL,
  getPayrollSettings,
  payrollCorrections,
  payrollCsv,
  payrollLexwareAscii,
  recordPayrollExport,
  payrollMonth,
  savePayrollSettings,
} from '../services/payroll.js';
import { encodeCp1252 } from '../services/datev.js';
import type { Context } from 'hono';
import type { AppEnv, Ctx } from './app.js';
import { arr, str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';
import { Icon } from './icons.js';
import type { WageType } from '../services/payroll.js';

const UUID = '[0-9a-f-]{36}';
const esc = (s: string | null | undefined) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
const h = (m: number) => (m ? hm(m) : '');
const monthOf = (q: string | undefined) => (q && /^\d{4}-\d{2}$/.test(q) ? q : todayBerlin().slice(0, 7));
const shiftMonth = (m: string, by: number) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
};

/** Tabelle des Stundenzettels als HTML (gleich für Bildschirm, Druck und Handy-Ansicht im Büro). */
export function sheetTableHtml(s: Timesheet): string {
  const body = s.rows
    .map((r) => {
      const abs = r.absence
        ? `<span class="ts-ab ts-ab-${r.absence}">${esc(ABSENCE_SHORT[r.absence])}</span>${r.absenceMinutes ? ` ${h(r.absenceMinutes)}` : ''}${r.absence && !r.absencePaid && r.absenceMinutes && r.absence !== 'unbezahlt' ? ' (unbezahlt)' : ''}`
        : '';
      const rowCls = r.absence ? `ts-abs-${r.absence}` : r.holiday ? 'ts-hol' : '';
      const st =
        r.status === 'beantragt'
          ? '<span class="ts-warn">Nachtrag in Prüfung</span>'
          : r.status === 'laeuft'
            ? '<span class="ts-warn">läuft</span>'
            : r.late
              ? '<span class="ts-warn">nach 7 Tagen erfasst</span>'
              : '';
      return `<tr${rowCls ? ` class="${rowCls}"` : ''}><td>${dayShort(r.date)} ${dateDe(r.date).slice(0, 6)}</td><td>${esc(r.site)}${r.holiday ? `<div class="ts-sub">${esc(r.holiday)}</div>` : ''}</td>
<td>${r.planFrom ? `${r.planFrom}–${r.planTo}` : ''}</td><td class="r">${h(r.planMinutes)}</td>
<td>${r.start ?? ''}</td><td>${r.end ?? ''}</td><td>${r.breakFrom ? `${r.breakFrom}–${r.breakTo}` : ''}</td><td class="r">${r.breakMinutes ? r.breakMinutes : ''}</td>
<td class="r"><b>${h(r.workMinutes)}</b></td><td>${abs}</td><td>${st}${r.note ? `<div class="ts-sub">${esc(r.note)}</div>` : ''}</td></tr>`;
    })
    .join('');
  const t = s.totals;
  return `<table class="ts"><thead><tr><th>Tag</th><th>Objekt</th><th>Plan</th><th class="r">Std.</th><th>Beginn</th><th>Ende</th><th>Pause von–bis</th><th class="r">Min.</th><th class="r">Arbeitszeit</th><th>Abwesenheit</th><th>Hinweis</th></tr></thead>
<tbody>${body || '<tr><td colspan="11" class="ts-empty">Keine Einsätze, Zeiten oder Abwesenheiten in diesem Monat.</td></tr>'}</tbody></table>
<table class="ts-sum"><tbody>
<tr><td>Plan (Einsätze)</td><td class="r">${hm(t.plan)}</td><td>Gearbeitet (netto)</td><td class="r"><b>${hm(t.work)}</b></td><td>Pausen</td><td class="r">${hm(t.breaks)}</td></tr>
<tr><td><span class="ts-ab ts-ab-urlaub">Urlaub</span></td><td class="r">${hm(t.vacation)}</td><td><span class="ts-ab ts-ab-krank">Krank</span></td><td class="r">${hm(t.sick)}</td><td><span class="ts-ab ts-ab-sonstiges">Sonstige bezahlt</span></td><td class="r">${hm(t.otherPaid)}</td></tr>
<tr><td><span class="ts-ab ts-ab-unbezahlt">Unbezahlt</span></td><td class="r">${hm(t.unpaid)}</td><td><b>Bezahlte Stunden gesamt</b></td><td class="r"><b>${hm(t.paid)}</b></td><td>Differenz zum Soll</td><td class="r">${t.diff > 0 ? '+' : ''}${hm(t.diff)}</td></tr>
</tbody></table>`;
}

export const SHEET_CSS = `
.ts{width:100%;border-collapse:collapse;font-size:12.5px;color:#1c1917}.ts th,.ts td{border:1px solid #cfc9c4;padding:5px 7px;text-align:left;vertical-align:top}
.ts th{background:#f3e8eb;font-weight:700;font-size:11.5px;color:#4a0d22}.ts .r{text-align:right;font-variant-numeric:tabular-nums}
.ts tbody tr:nth-child(even) td{background:#faf8f7}.ts-hol td{background:#e8f0fa!important}.ts-sub{font-size:11px;color:#57534e}
.ts-warn{color:#b45309;font-weight:600;font-size:11.5px}.ts-empty{text-align:center;color:#57534e;padding:18px}
.ts-sum{margin-top:12px;border-collapse:collapse;font-size:12.5px;min-width:60%;border:1.5px solid #7D1435}.ts-sum td{padding:5px 10px;border:1px solid #cfc9c4}
.ts-sum .r{text-align:right;font-variant-numeric:tabular-nums}
.ts-ab{display:inline-block;padding:1px 7px;border-radius:9px;font-weight:700;font-size:11px;color:#fff;white-space:nowrap}
${absenceCss(
  (k) => `.ts-ab-${k}`,
  (c) => `background:${c.solid}`,
)}
${absenceCss(
  (k) => `.ts tbody tr.ts-abs-${k} td`,
  (c) => `background:${c.tint}!important`,
)}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}`;

function signatureBlock(s: Timesheet, sig: SheetSignature | undefined, imgUrl: string | null) {
  const signedText = sig
    ? `Unterschrieben in der App am ${sig.signed_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' })}${sig.sheet_hash !== s.hash ? ' – <b style="color:#b91c1c">danach geändert, neue Unterschrift nötig</b>' : ''}`
    : '';
  return `<div class="sig-row"><div class="sig"><div class="sig-box">${sig && imgUrl ? `<img src="${imgUrl}" alt="Unterschrift">` : ''}</div>
<div class="sig-l">Datum, Unterschrift Mitarbeiter/in${signedText ? `<br><small>${signedText}</small>` : ''}</div></div>
<div class="sig"><div class="sig-box"></div><div class="sig-l">Datum, Unterschrift Arbeitgeber</div></div></div>`;
}

const PRINT_CSS = `@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Inter,system-ui,Arial,sans-serif;color:#1c1917;margin:0}
.sheet{page-break-after:always;padding:0}.sheet:last-child{page-break-after:auto}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #7D1435;padding-bottom:6px;margin-bottom:8px}
.hd h1{margin:0 0 3px;font-size:19px;color:#7D1435}.hd .logo{height:42px;margin-bottom:4px}.hd .m{font-size:12px;color:#292524;line-height:1.5}.hd .r{text-align:right}
.sig-row{display:flex;gap:40px;margin-top:22px}.sig{flex:1}.sig-box{height:54px;border-bottom:1px solid #444;display:flex;align-items:flex-end}.sig-box img{max-height:52px}
.sig-l{font-size:11px;color:#57534e;margin-top:3px}.legal{font-size:10px;color:#78716c;margin-top:10px}
.bar{text-align:center;padding:10px;background:#f4f3f1}.bar button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#7D1435;color:#fff;cursor:pointer}
@media print{.bar{display:none}}${SHEET_CSS}`;

export function registerTimesheetRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql } = deps;

  const company = async () => {
    const [co] = await sql<{ name: string; street: string; postal_code: string; city: string }[]>`
      select legal_name as name, street, postal_code, city from app.company where id = 1`;
    return co;
  };

  const sheetSection = async (s: Timesheet & { onlySite?: string }) => {
    const co = await company();
    const sig = s.onlySite ? undefined : await latestSignature(sql, s.employee.id, s.month);
    const sigHtml = s.onlySite
      ? `<div class="legal">Auszug nur mit den Zeiten im Objekt „${esc(s.onlySite)}“. Der vollständige Stundenliste des Monats (mit Unterschrift) liegt in der Personalakte.</div>`
      : signatureBlock(
          s,
          sig,
          sig ? `/personal/${s.employee.id}/stundenzettel/unterschrift/${sig.id}.png` : null,
        );
    return `<div class="sheet"><div class="hd"><div><h1>Stundenliste ${esc(monthLabel(s.month))}${s.onlySite ? ` – Objekt ${esc(s.onlySite)}` : ''}</h1>
<div class="m"><b>${esc(s.employee.name)}</b> · Personalnr. ${esc(s.employee.personnel_no)}${s.employee.weekly_hours ? ` · ${String(Number(s.employee.weekly_hours)).replace('.', ',')} Std./Woche` : ''}<br>Zeitraum ${dateDe(s.from)} – ${dateDe(s.to)}</div></div>
<div class="m r"><img src="/static/logo-transparent.png" alt="Viva-Deluxe" class="logo"><br><b>${esc(co?.name)}</b> · ${esc(co?.street)} · ${esc(co?.postal_code)} ${esc(co?.city)}</div></div>
${sheetTableHtml(s)}${sigHtml}
<div class="legal">Aufzeichnung nach § 17 MiLoG (Beginn, Ende und Dauer der täglichen Arbeitszeit; Aufbewahrung mindestens 2 Jahre). Pausen nach § 4 ArbZG. Erstellt am ${dateDe(todayBerlin())}.</div></div>`;
  };

  const printHtml = (title: string, sections: string[]) =>
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button></div>${sections.join('')}</body></html>`;

  // ------------------------------------------------------------ je Mitarbeiter (Reiter)
  app.get(`/personal/:id{${UUID}}/stundenzettel`, (c) =>
    shells.employee!(c, 'stundenzettel', async (e) => {
      const month = monthOf(c.req.query('monat'));
      const full = await timesheet(sql, e.id, month);
      const siteNames = [...new Set(full.rows.map((r) => r.site).filter((x): x is string => !!x))].sort();
      const only = c.req.query('objekt') ?? '';
      const s = only && siteNames.includes(only) ? sheetForSite(full, only) : full;
      const sig = await latestSignature(sql, e.id, month);
      const base = `/personal/${e.id}/stundenzettel`;
      const oq = only ? `&objekt=${encodeURIComponent(only)}` : '';
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a class="btn sm sec" href={`${base}?monat=${shiftMonth(month, -1)}${oq}`}>
              ←
            </a>
            <b style="min-width:150px;text-align:center">{monthLabel(month)}</b>
            <a class="btn sm sec" href={`${base}?monat=${shiftMonth(month, 1)}${oq}`}>
              →
            </a>
            {siteNames.length > 1 && (
              <form method="get" style="display:inline">
                <input type="hidden" name="monat" value={month} />
                <select
                  name="objekt"
                  onchange="this.form.submit()"
                  aria-label="Objekt"
                  data-nosearch
                  style="max-width:260px"
                >
                  <option value="">alle Objekte ({siteNames.length})</option>
                  {siteNames.map((n) => (
                    <option value={n} selected={n === only}>
                      nur {n}
                    </option>
                  ))}
                </select>
              </form>
            )}
            <span style="flex:1" />
            {sig ? (
              sig.sheet_hash === full.hash ? (
                <span class="badge ok">
                  ✓ unterschrieben am {dateDe(sig.signed_at.toISOString().slice(0, 10))}
                </span>
              ) : (
                <span class="badge err">nach Unterschrift geändert – neu unterschreiben lassen</span>
              )
            ) : (
              <span class="badge warn">noch nicht unterschrieben</span>
            )}
            <a class="btn sm" href={`${base}/druck?monat=${month}${oq}`} target="_blank" rel="noopener">
              {only ? 'Auszug drucken / PDF' : 'Drucken / PDF'}
            </a>
          </div>
          {(s.open.running > 0 || s.open.pending > 0) && (
            <div class="flash warn">
              Offen: {s.open.running > 0 && `${s.open.running} laufende Stempelung `}
              {s.open.pending > 0 && `${s.open.pending} Nachtrag/Nachträge in Prüfung`} – der Mitarbeiter kann
              erst unterschreiben, wenn alles geklärt ist.
            </div>
          )}
          <div class="card" style="overflow-x:auto">
            <style dangerouslySetInnerHTML={{ __html: SHEET_CSS }} />
            <div dangerouslySetInnerHTML={{ __html: sheetTableHtml(s) }} />
          </div>
          <p class="small mut">
            Der Mitarbeiter unterschreibt die Stundenliste am Monatsende in der Handy-App. Ändert sich danach
            eine Zeit, wird das hier angezeigt und er kann neu unterschreiben (alle Unterschriften bleiben
            gespeichert).
          </p>
        </>
      );
    }),
  );

  app.get(`/personal/:id{${UUID}}/stundenzettel/druck`, async (c) => {
    const month = monthOf(c.req.query('monat'));
    const full = await timesheet(sql, c.req.param('id'), month);
    const only = c.req.query('objekt') ?? '';
    const s = only && full.rows.some((r) => r.site === only) ? sheetForSite(full, only) : full;
    return c.html(printHtml(`Stundenliste ${s.employee.name} ${monthLabel(month)}`, [await sheetSection(s)]));
  });

  app.get(`/personal/:id{${UUID}}/stundenzettel/unterschrift/:sid{${UUID}}.png`, async (c) => {
    const [sig] = await sql<{ signature_path: string }[]>`
      select signature_path from app.timesheet_signatures
       where id = ${c.req.param('sid')} and employee_id = ${c.req.param('id')}`;
    if (!sig) return c.notFound();
    const bytes = await deps.archive.get(sig.signature_path);
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
    });
  });

  // ------------------------------------------------------------ Stundenzettel & Lohnarten (eine Seite)
  type Emp = Awaited<ReturnType<typeof listEmployees>>[number];
  const filterEmps = (
    all: Emp[],
    siteLinks: { employee_id: string; site_id: string }[],
    f: { from: string; to: string; q: string; art: string; site: string },
  ) => {
    const lq = f.q.toLowerCase();
    return all.filter(
      (e) =>
        e.entry_date <= f.to &&
        (!e.exit_date || e.exit_date >= f.from) &&
        (!lq || `${e.last_name} ${e.first_name} ${e.personnel_no}`.toLowerCase().includes(lq)) &&
        (!f.art || e.employment_type === f.art) &&
        (!f.site || siteLinks.some((l) => l.employee_id === e.id && l.site_id === f.site)),
    );
  };
  type SigState = 'alle' | 'unterschrieben' | 'offen' | 'geaendert';
  const listData = async (c: Context<AppEnv>) => {
    const month = monthOf(c.req.query('monat'));
    const q = (c.req.query('q') ?? '').trim();
    const art = c.req.query('art') ?? '';
    const site = c.req.query('objekt') ?? '';
    const sig = (c.req.query('unterschrift') ?? 'alle') as SigState;
    const view = c.req.query('ansicht') === 'lohnarten' ? 'lohnarten' : 'stunden';
    // „nur Zeiten dieses Objekts“: Stundenzettel als Auszug je Objekt (z. B. Nachweis für den Kunden)
    const onlySite = !!site && c.req.query('nur') === '1';
    // Auswahl einzelner Personen (Häkchen in der Liste) für Druck/Export
    const picked = new Set(c.req.queries('p') ?? []);
    const { from, to } = monthRange(month);
    // Lohnarten: je Einsatz die erfasste Zeit, fehlt sie die geplante (Ahmed 28.10.: „zuerst Ist, wenn nicht da
    // Soll, sonst nichts“) – für jeden Monat. „stichtag=ohne“ = nur erfasste Zeiten.
    const noCut = (c.req.query('stichtag') ?? '') === 'ohne';
    const fillPlan = !noCut;
    // als Stand für die Korrektur im Folgemonat festgehalten (Monatsende = ganzer Monat Ist/Plan)
    const cutoff = fillPlan ? to : null;
    const [all, sigs, pay, siteLinks, sites] = await Promise.all([
      listEmployees(sql),
      signaturesOfMonth(sql, month),
      payrollMonth(sql, month, undefined, { fillPlan }),
      sql<{ employee_id: string; site_id: string }[]>`select employee_id, site_id from app.employee_sites`,
      sql<{ id: string; site_no: string; name: string; customer_name: string }[]>`
        select s.id, s.site_no, s.name, s.street, s.city, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id where s.active order by s.name`,
    ]);
    const emps = filterEmps(all, siteLinks, { from, to, q, art, site });
    const siteName = sites.find((x) => x.id === site)?.name ?? '';
    const sheets = await Promise.all(
      emps.map(async (e) => {
        const full = await timesheet(sql, e.id, month);
        return { full, s: onlySite ? sheetForSite(full, siteName) : full };
      }),
    );
    const payOf = new Map(pay.map((p) => [p.employee_id, p]));
    const rows = emps
      .map((e, i) => {
        const { s, full } = sheets[i]!;
        const sg = sigs.get(e.id);
        const state: Exclude<SigState, 'alle'> = sg
          ? sg.sheet_hash === full.hash
            ? 'unterschrieben'
            : 'geaendert'
          : 'offen';
        return { e, s, sg, state, p: payOf.get(e.id) };
      })
      .filter(
        (x) =>
          (x.s.rows.length > 0 ||
            (view === 'lohnarten' &&
              !!x.p &&
              (x.p.salary || Object.values(x.p.minutes).some((m) => m > 0)))) &&
          (sig === 'alle' || x.state === sig),
      );
    // Sortierung aus der Tabelle (Klick auf Spaltenkopf) gilt auch für Druck/PDF/CSV (Ahmed 07.10.)
    const sortBy = (c.req.query('sort') ?? '').toLowerCase();
    const dir = c.req.query('dir') === 'desc' ? -1 : 1;
    if (/pers/.test(sortBy))
      rows.sort((a, b) => dir * a.e.personnel_no.localeCompare(b.e.personnel_no, 'de', { numeric: true }));
    else if (/mitarbeiter|name/.test(sortBy) || dir === -1)
      rows.sort(
        (a, b) =>
          dir *
          `${a.e.last_name} ${a.e.first_name}`.localeCompare(`${b.e.last_name} ${b.e.first_name}`, 'de'),
      );
    const all2 = rows;
    const chosen = picked.size ? rows.filter((x) => picked.has(x.e.id)) : rows;
    const qs = (o: Record<string, string> = {}) => {
      const p = new URLSearchParams({ monat: month });
      if (q) p.set('q', q);
      if (art) p.set('art', art);
      if (site) p.set('objekt', site);
      if (onlySite) p.set('nur', '1');
      if (sig !== 'alle') p.set('unterschrift', sig);
      if (view !== 'stunden') p.set('ansicht', view);
      if (noCut) p.set('stichtag', 'ohne');
      for (const [k, v] of Object.entries(o)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      return p.toString();
    };
    return {
      emps,
      picked,
      month,
      q,
      art,
      site,
      sig,
      view,
      rows: all2,
      chosen,
      onlySite,
      siteName,
      sites,
      qs,
      cutoff,
      fillPlan,
    };
  };
  const surchargeMin = (p: { minutes: Record<string, number> } | undefined) =>
    p ? SURCHARGES.reduce((a, k) => a + p.minutes[k]!, 0) : 0;
  const surchargeEur = (p: { surchargeCents: Record<string, bigint> } | undefined) =>
    p
      ? SURCHARGES.reduce((a, k) => a + p.surchargeCents[k]!, 0n) +
        ((p as { overtimeCents?: bigint }).overtimeCents ?? 0n)
      : 0n;

  app.get('/zeiterfassung/stundenzettel', async (c) => {
    const d = await listData(c);
    const { month, rows } = d;
    const st = await getPayrollSettings(sql);
    const corrPrev = addMonths(month, -1);
    const corr = {
      month: corrPrev,
      ...(d.view === 'lohnarten' ? await payrollCorrections(sql, corrPrev) : { cutoff: null, rows: [] }),
    };
    const signed = rows.filter((x) => x.state === 'unterschrieben').length;
    const { from: mFrom, to: mTo } = monthRange(month);
    const reqCount = (await requestsOf(sql, mFrom, mTo, new Set(d.emps.map((e) => e.id)))).length;
    const tot = (f: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + f(x), 0);
    const lc = lohnCols(rows);
    return page(
      c,
      'Stundenliste & Lohnarten',
      'personal',
      <>
        <PageHead title={`Stundenliste & Lohnarten ${monthLabel(month)}`} />
        {d.onlySite && (
          <div class="flash">
            Auszug: nur Zeiten im Objekt <b>{d.siteName}</b> – je Person ein Blatt, ohne Unterschrift (die
            gilt für den ganzen Monat). CSV fürs Lohnprogramm rechnet weiter mit allen Zeiten.
          </div>
        )}
        <form method="get" class="actions" style="margin-top:0">
          <a class="btn sm sec" href={`?${d.qs({ monat: shiftMonth(month, -1) })}`}>
            ←
          </a>
          <input
            type="month"
            name="monat"
            value={month}
            onchange="this.form.submit()"
            style="max-width:170px"
          />
          <a class="btn sm sec" href={`?${d.qs({ monat: shiftMonth(month, 1) })}`}>
            →
          </a>
          <input name="q" value={d.q} placeholder="Name oder Pers.-Nr." style="max-width:190px" />
          <select
            name="art"
            onchange="this.form.submit()"
            aria-label="Beschäftigungsart"
            data-nosearch
            style="max-width:220px"
          >
            <option value="">Alle Beschäftigungsarten</option>
            {Object.entries(EMPLOYMENT_TYPES).map(([k, v]) => (
              <option value={k} selected={k === d.art}>
                {v}
              </option>
            ))}
          </select>
          <select name="objekt" onchange="this.form.submit()" aria-label="Objekt" style="max-width:240px">
            <option value="">Alle Objekte</option>
            <SiteOptions sites={d.sites} selected={d.site} />
          </select>
          <select
            name="unterschrift"
            onchange="this.form.submit()"
            aria-label="Unterschrift"
            data-nosearch
            style="max-width:240px"
          >
            {(
              [
                ['alle', 'Unterschrift: alle'],
                ['unterschrieben', 'unterschrieben'],
                ['offen', 'noch offen'],
                ['geaendert', 'geändert (neu unterschreiben)'],
              ] as const
            ).map(([k, v]) => (
              <option value={k} selected={k === d.sig}>
                {v}
              </option>
            ))}
          </select>
          {d.site && (
            <label class="small" style="margin:0;display:flex;gap:6px;align-items:center">
              <input
                type="checkbox"
                name="nur"
                value="1"
                checked={d.onlySite}
                onchange="this.form.submit()"
              />
              nur Zeiten dieses Objekts
            </label>
          )}
          {d.view !== 'stunden' && <input type="hidden" name="ansicht" value={d.view} />}
          <button class="btn sm sec">Filtern</button>
        </form>
        {/* Auswahl einzelner Personen: Häkchen in der Tabelle gehören zu diesem Formular */}
        <form id="pick" method="get" action="/zeiterfassung/stundenzettel/druck" target="_blank">
          {[...new URLSearchParams(d.qs()).entries()].map(([k, v]) => (
            <input type="hidden" name={k} value={v} />
          ))}
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.addEventListener('change',function(ev){var t=ev.target;if(!t.matches||!(t.matches('[data-pick]')||t.matches('[data-pick-all]')))return;
var bs=document.querySelectorAll('[data-pick]');if(t.matches('[data-pick-all]'))bs.forEach(function(b){b.checked=t.checked});
var n=0;bs.forEach(function(b){if(b.checked)n++});var btn=document.querySelector('[data-pick-btn]');if(btn){btn.disabled=!n;btn.textContent='Nur markierte Personen drucken'+(n?' ('+n+')':'')}});`,
          }}
        />
        <div class="actions">
          <div class="chips" style="margin:0">
            <a href={`?${d.qs({ ansicht: '' })}`} class={d.view === 'stunden' ? 'on' : ''}>
              Stundenliste
            </a>
            <a href={`?${d.qs({ ansicht: 'lohnarten' })}`} class={d.view === 'lohnarten' ? 'on' : ''}>
              Lohnarten
            </a>
          </div>
          <a
            class="btn sm sec"
            href={`/zeiterfassung/stundenzettel/urlaubsantraege?${d.qs()}`}
            target="_blank"
            rel="noopener"
            title="Urlaub, unbezahlte und sonstige Freistellung im Monat – je Antrag eine Seite, fertig zum Unterschreiben"
          >
            <Icon name="calendar" /> Urlaubsanträge drucken ({reqCount})
          </a>
          <span class="mut small">
            {rows.length} Mitarbeitende · {signed} von {rows.length} unterschrieben
          </span>
          <span style="flex:1" />
          <details class="dd ts-export">
            <summary class="btn sm">
              <Icon name="download" /> Drucken / Exportieren <Icon name="chevron" size={14} />
            </summary>
            <div class="drop right">
              <div class="ts-ex-h">Stundenliste (Ablage, Zoll)</div>
              <a
                href={`/zeiterfassung/stundenzettel/druck?${d.qs()}`}
                data-export
                target="_blank"
                rel="noopener"
              >
                Je Person ein Blatt – drucken / PDF <span class="cnt">{rows.length}</span>
              </a>
              {d.view === 'stunden' && (
                <button type="submit" form="pick" data-pick-btn disabled>
                  Nur markierte Personen drucken
                </button>
              )}
              <a
                href={`/zeiterfassung/stundenzettel/uebersicht.pdf?${d.qs({ ansicht: '' })}`}
                data-export
                target="_blank"
              >
                Übersicht als PDF
              </a>
              <a href={`/zeiterfassung/stundenzettel.csv?${d.qs({ ansicht: '' })}`} data-export>
                Übersicht als CSV (Excel)
              </a>
              <div class="sep" />
              <div class="ts-ex-h">Lohnarten (Lohnabrechnung)</div>
              <a
                href={`/zeiterfassung/stundenzettel/uebersicht.pdf?${d.qs({ ansicht: 'lohnarten' })}`}
                data-export
                target="_blank"
              >
                Übersicht als PDF
              </a>
              <a href={`/zeiterfassung/stundenzettel.csv?${d.qs({ ansicht: 'lohnarten' })}`} data-export>
                Übersicht als CSV (Excel)
              </a>
              <div class="sep" />
              <div class="ts-ex-h">Fürs Lohnprogramm (Stand wird festgehalten)</div>
              <a
                href={`/zeiterfassung/lohnarten.csv?${d.qs({ ansicht: 'lohnarten' })}`}
                data-export
                data-confirm={
                  d.fillPlan
                    ? `Lohnarten ${month.slice(5)}/${month.slice(0, 4)} fürs Lohnprogramm exportieren? Je Einsatz die erfasste Zeit, fehlt sie die geplante Zeit. Der Stand wird festgehalten; spätere Änderungen erscheinen im Folgemonat als Korrekturzeile.`
                    : `Lohnarten ${month.slice(5)}/${month.slice(0, 4)} fürs Lohnprogramm exportieren – nur erfasste Zeiten (ohne Plan)? Der Stand wird festgehalten.`
                }
              >
                CSV Lohnprogramm
              </a>
              <a
                href={`/zeiterfassung/lohnarten-lexware.txt?${d.qs({ ansicht: 'lohnarten' })}`}
                data-export
                title="Lexware ASCII-Import: Jahr;Monat;Personalnummer;Lohnartnummer;Wert – Windows-1252 (ANSI), ohne Kopfzeile"
                data-confirm={
                  d.fillPlan
                    ? `Lohnarten ${month.slice(5)}/${month.slice(0, 4)} als Lexware-ASCII-Datei exportieren? Je Einsatz die erfasste Zeit, fehlt sie die geplante Zeit. Der Stand wird festgehalten; spätere Änderungen erscheinen im Folgemonat als Korrekturzeile.`
                    : `Lohnarten ${month.slice(5)}/${month.slice(0, 4)} als Lexware-ASCII-Datei exportieren – nur erfasste Zeiten (ohne Plan)? Der Stand wird festgehalten.`
                }
              >
                Lexware (ASCII)
              </a>
              <div class="sep" />
              <a
                href={`/zeiterfassung/stundenzettel/urlaubsantraege?${d.qs()}`}
                target="_blank"
                rel="noopener"
              >
                Urlaubsanträge (je Antrag eine Seite) <span class="cnt">{reqCount}</span>
              </a>
            </div>
          </details>
        </div>
        <style
          dangerouslySetInnerHTML={{
            __html: `.ts-export .drop{min-width:340px;padding:6px;text-align:left}.ts-export .drop a,.ts-export .drop button{padding:7px 10px;border-radius:6px;justify-content:flex-start;white-space:nowrap}
.ts-export .drop a .cnt{margin-left:auto}
.ts-export .drop a:hover,.ts-export .drop button:hover:not(:disabled){background:var(--head)}
.ts-export .drop button{display:block;width:100%;text-align:left;border:0;background:none;font:inherit;color:var(--ink);cursor:pointer}
.ts-export .drop button:disabled{color:var(--faint);cursor:default}
.ts-ex-h{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);padding:6px 10px 2px}
.absdot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:0}
${absenceCss(
  (k) => `.absdot.${k}`,
  (c) => `background:${c.solid}`,
)}
${absenceCss(
  (k) => `td.abscell.${k}`,
  (c) => `background:${c.tint};color:${c.ink};font-weight:600`,
)}`,
          }}
        />
        {d.view === 'lohnarten' &&
          (() => {
            // nur Lohnarten, die in diesem Monat vorkommen und keine Nummer haben
            const used = new Set<WageType>();
            for (const x of d.rows) {
              if (x.p?.salary) used.add(x.p.salary.type);
              if (x.p?.unpaidDeductionCents) used.add('unbezahlt');
              for (const k of HOUR_TYPES) if (x.p?.minutes[k]) used.add(k);
            }
            const miss = WAGE_TYPES.filter((k) => used.has(k) && !st.wage_type_numbers[k]?.trim());
            return (
              miss.length > 0 && (
                <div class="notice warn" style="max-width:960px">
                  Für den Lexware-Export fehlen Lohnart-Nummern (
                  {miss.map((k) => WAGE_TYPE_LABEL[k]).join(', ')}) – ohne Nummer werden diese Werte nicht
                  exportiert. <a href="/zeiterfassung/lohnarten/einstellungen">Nummern eintragen →</a>
                </div>
              )
            );
          })()}
        {d.view === 'lohnarten' && (
          <details class="card" style="max-width:960px;padding:10px 16px">
            <summary>
              <b>Grundlage:</b> {d.fillPlan ? 'erfasste Zeit, sonst geplante Zeit' : 'nur erfasste Zeiten'}
              {corr.rows.length > 0 && ` · Korrektur Vormonat: ${corr.rows.length} Mitarbeitende`} – Details
            </summary>
            <div style="margin-top:8px">
              {d.fillPlan ? (
                <>
                  Je Einsatz die <b>erfasste Zeit</b>, fehlt sie (noch nicht bestätigt, Nachtrag offen, noch
                  nicht gearbeitet) die <b>geplante Zeit</b>; Zeiten ohne Einsatz zählen wie erfasst.{' '}
                  <a class="btn sm sec" href={`/zeiterfassung/stundenzettel?${d.qs({ stichtag: 'ohne' })}`}>
                    nur erfasste Zeiten
                  </a>
                </>
              ) : (
                <>
                  Nur erfasste Zeiten.{' '}
                  <a class="btn sm sec" href={`/zeiterfassung/stundenzettel?${d.qs({ stichtag: '' })}`}>
                    Ist, sonst Plan
                  </a>
                </>
              )}
            </div>
            <div class="small mut" style="margin-top:6px">
              Jeder Export fürs Lohnprogramm wird festgehalten. Im Folgemonat enthält er automatisch die
              Zeilen „Korrektur“ mit der Differenz zum jetzigen Stand (Stunden, auch minus). Zuschläge nach
              RTV Gebäudereinigung (§ 10) laut{' '}
              <a href="/zeiterfassung/lohnarten/einstellungen">Einstellungen</a>: Nacht {st.night_from}–
              {st.night_to} {st.night_bp / 100} %, Sonntag {st.sunday_bp / 100} %, Feiertag{' '}
              {st.holiday_bp / 100} %, hohe Feiertage {st.high_holiday_bp / 100} % – je Stunde nur der
              höchste.
            </div>
            {corr.rows.length > 0 && (
              <table style="margin-top:8px">
                <tbody>
                  {corr.rows.map((r) => (
                    <tr>
                      <td>{r.personnel_no}</td>
                      <td>{r.name}</td>
                      <td>
                        {Object.entries(r.minutes)
                          .map(
                            ([k, v]) =>
                              `${WAGE_TYPE_LABEL[k as keyof typeof WAGE_TYPE_LABEL]} ${v! > 0 ? '+' : ''}${(v! / 60).toFixed(2).replace('.', ',')} Std.`,
                          )
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        )}
        <div class="tbl">
          <table>
            <thead>
              {d.view === 'stunden' ? (
                <tr>
                  <th style="width:28px">
                    <input type="checkbox" aria-label="alle auswählen" data-pick-all />
                  </th>
                  <th>Pers.-Nr.</th>
                  <th>Mitarbeiter</th>
                  <th class="r">Plan</th>
                  <th class="r">Gearbeitet</th>
                  <th class="r">
                    <span class="absdot urlaub" />
                    Urlaub
                  </th>
                  <th class="r">
                    <span class="absdot krank" />
                    Krank
                  </th>
                  <th class="r">
                    <span class="absdot unbezahlt" />
                    Unbezahlt
                  </th>
                  <th class="r">Bezahlt</th>
                  <th class="r">Zuschl.-Std.</th>
                  <th>Unterschrift</th>
                  <th></th>
                </tr>
              ) : (
                <tr>
                  <th>Pers.-Nr.</th>
                  <th>Mitarbeiter</th>
                  {lc.map((col) => (
                    <th class="r">
                      {col.abs && <span class={`absdot ${col.abs}`} />}
                      {col.label}
                    </th>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((x) => {
                const { e, s, sg, state, p } = x;
                return (
                  <tr>
                    {d.view === 'stunden' && (
                      <td>
                        <input
                          type="checkbox"
                          name="p"
                          value={e.id}
                          form="pick"
                          aria-label="auswählen"
                          data-pick
                        />
                      </td>
                    )}
                    <td class="num">{e.personnel_no}</td>
                    <td>
                      <a
                        href={`/personal/${e.id}/stundenzettel?monat=${month}${d.onlySite ? `&objekt=${encodeURIComponent(d.siteName)}` : ''}`}
                      >
                        {e.last_name}, {e.first_name}
                      </a>
                      <div class="small mut">
                        {EMPLOYMENT_TYPES[e.employment_type]}
                        {p && !p.wage_cents && <span class="badge warn"> Lohn fehlt</span>}
                        {p && p.uncoveredSundayHolidayMinutes > 0 && (
                          <div
                            class="small"
                            style="color:var(--warn)"
                            title="Zeit an Sonntagen ohne Einsatz „auch an Sonn- und Feiertagen“ – kein Zuschlag berechnet"
                          >
                            {(p.uncoveredSundayHolidayMinutes / 60).toLocaleString('de-DE', {
                              maximumFractionDigits: 2,
                            })}{' '}
                            Std. Sonn-/Feiertag ohne Zuschlag
                          </div>
                        )}
                        {p && p.holidayWorkedAsLfzMinutes > 0 && (
                          <div
                            class="small"
                            style="color:var(--warn)"
                            title="Zeit an Feiertagen ohne Einsatz „auch an Sonn- und Feiertagen“ – als Feiertagslohn gezählt, nicht als Arbeit mit Zuschlag"
                          >
                            {(p.holidayWorkedAsLfzMinutes / 60).toLocaleString('de-DE', {
                              maximumFractionDigits: 2,
                            })}{' '}
                            Std. am Feiertag gearbeitet → Feiertagslohn
                          </div>
                        )}
                        {(s.open.running > 0 || s.open.pending > 0) && (
                          <span class="badge warn"> offene Zeiten</span>
                        )}
                      </div>
                    </td>
                    {d.view === 'stunden' ? (
                      <>
                        <td class="r">{hm(s.totals.plan)}</td>
                        <td class="r">
                          <b>{hm(s.totals.work)}</b>
                        </td>
                        <td class={`r${s.totals.vacation ? ' abscell urlaub' : ''}`}>
                          {h(s.totals.vacation)}
                        </td>
                        <td class={`r${s.totals.sick ? ' abscell krank' : ''}`}>{h(s.totals.sick)}</td>
                        <td class={`r${s.totals.unpaid ? ' abscell unbezahlt' : ''}`}>
                          {h(s.totals.unpaid)}
                        </td>
                        <td class="r">
                          <b>{hm(s.totals.paid)}</b>
                        </td>
                        <td class="r">{h(surchargeMin(p))}</td>
                        <td>
                          {state === 'unterschrieben' ? (
                            <span class="badge ok">✓ {dateDe(sg!.signed_at.toISOString().slice(0, 10))}</span>
                          ) : state === 'geaendert' ? (
                            <span class="badge err">geändert</span>
                          ) : (
                            <span class="badge">offen</span>
                          )}
                        </td>
                        <td>
                          <a
                            class="btn sm sec"
                            href={`/personal/${e.id}/stundenzettel/druck?monat=${month}${d.onlySite ? `&objekt=${encodeURIComponent(d.siteName)}` : ''}`}
                            target="_blank"
                            rel="noopener"
                          >
                            Drucken
                          </a>
                        </td>
                      </>
                    ) : (
                      <>
                        {lc.map((col) => (
                          <td
                            class={`r${col.abs && lohnText(col, col.val(x)) ? ` abscell ${col.abs}` : ''}`}
                            style={
                              infoOnly(x, col)
                                ? 'color:var(--bad)'
                                : col.key === 'gesamt'
                                  ? 'font-weight:700'
                                  : undefined
                            }
                            title={
                              infoOnly(x, col)
                                ? 'Festgehalt – Stunden nur zur Info, bezahlt wird das Gehalt'
                                : undefined
                            }
                          >
                            {lohnText(col, col.val(x))}
                          </td>
                        ))}
                      </>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colspan={12} class="mut">
                    Keine Zeiten für diesen Filter.
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                {d.view === 'stunden' ? (
                  <tr>
                    <td></td>
                    <td></td>
                    <td>
                      <b>Summe</b>
                    </td>
                    <td class="r">{hm(tot((x) => x.s.totals.plan))}</td>
                    <td class="r">
                      <b>{hm(tot((x) => x.s.totals.work))}</b>
                    </td>
                    <td class="r">{h(tot((x) => x.s.totals.vacation))}</td>
                    <td class="r">{h(tot((x) => x.s.totals.sick))}</td>
                    <td class="r">{h(tot((x) => x.s.totals.unpaid))}</td>
                    <td class="r">
                      <b>{hm(tot((x) => x.s.totals.paid))}</b>
                    </td>
                    <td class="r">{h(tot((x) => surchargeMin(x.p)))}</td>
                    <td colspan={2}></td>
                  </tr>
                ) : (
                  <tr>
                    <td></td>
                    <td>
                      <b>Gesamt</b>
                    </td>
                    {lc.map((col) => (
                      <td class="r">
                        <b>{lohnText(col, lohnTotal(rows, col))}</b>
                      </td>
                    ))}
                  </tr>
                )}
              </tfoot>
            )}
          </table>
        </div>
      </>,
    );
  });

  // Alle Urlaubsanträge des Monats (Filter wie die Liste) bzw. einer Abwesenheit (?id=) als Druckseite
  app.get('/zeiterfassung/stundenzettel/urlaubsantraege', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const { from, to } = monthRange(month);
    const id = c.req.query('id') ?? '';
    const [all, siteLinks, co] = await Promise.all([
      listEmployees(sql),
      sql<{ employee_id: string; site_id: string }[]>`select employee_id, site_id from app.employee_sites`,
      company(),
    ]);
    let reqs;
    if (/^[0-9a-f-]{36}$/.test(id)) {
      const [one] = await sql<
        { employee_id: string }[]
      >`select employee_id from app.absences where id = ${id}`;
      reqs = one ? (await listAbsences(sql, { employeeId: one.employee_id })).filter((a) => a.id === id) : [];
    } else {
      const emps = filterEmps(all, siteLinks, {
        from,
        to,
        q: (c.req.query('q') ?? '').trim(),
        art: c.req.query('art') ?? '',
        site: c.req.query('objekt') ?? '',
      });
      const picked = new Set(c.req.queries('p') ?? []);
      reqs = await requestsOf(
        sql,
        from,
        to,
        new Set(emps.filter((e) => !picked.size || picked.has(e.id)).map((e) => e.id)),
      );
    }
    const body = await leaveRequestsHtml(sql, reqs, new Map(all.map((e) => [e.id, e])), co);
    return c.html(leaveRequestsPage(`Urlaubsanträge ${monthLabel(month)}`, body));
  });

  app.get('/zeiterfassung/stundenzettel/druck', async (c) => {
    const d = await listData(c);
    const sections: string[] = [];
    for (const x of d.chosen) sections.push(await sheetSection(x.s));
    return c.html(printHtml(`Stundenlisten ${monthLabel(d.month)}`, sections));
  });

  // Stundenliste (Ablage, Zoll): Stunden je Person. Lohnarten (Lohnabrechnung): Stunden je Lohnart + Zuschläge.
  type Row = Awaited<ReturnType<typeof listData>>['rows'][number];
  // Lohnarten kurz und knapp (Ahmed 29.10.): nur Lohnarten, die im Monat vorkommen, eine Summe „Bezahlt gesamt“.
  // Werte aus der Lohnberechnung (je Einsatz Ist, sonst Plan) – nicht aus der Stundenliste (die zeigt nur Ist).
  // Festgehalt: Grundstunden nur zur Info (rot), nicht in der Summe – bezahlt wird das Gehalt.
  type LCol = {
    key: string;
    label: string;
    kind: 'h' | 'eur';
    abs?: AbsenceKind;
    neg?: boolean;
    val: (x: Row) => number | bigint;
  };
  const LBASE: HourType[] = ['normal', 'aushilfslohn', 'urlaub', 'krank', 'feiertag_lfz'];
  const LSHORT: Record<HourType, string> = {
    normal: 'Normalstunden',
    aushilfslohn: 'Aushilfslohn',
    urlaub: 'Urlaub',
    krank: 'Krank',
    feiertag_lfz: 'Feiertag',
    nacht: 'Nacht',
    sonntag: 'Sonntag',
    feiertag: 'Feiertagsarbeit',
    feiertag_hoch: 'Hohe Feiertage',
    mehrarbeit: 'Mehrarbeit',
  };
  const lohnCols = (rows: Row[]): LCol[] => {
    const any = (f: (x: Row) => boolean) => rows.some(f);
    const cols: LCol[] = [];
    for (const k of HOUR_TYPES)
      if (any((x) => (x.p?.minutes[k] ?? 0) > 0))
        cols.push({
          key: k,
          label: LSHORT[k],
          kind: 'h',
          ...(k === 'urlaub' || k === 'krank' ? { abs: k } : {}),
          val: (x) => x.p?.minutes[k] ?? 0,
        });
    cols.push({
      key: 'gesamt',
      label: 'Bezahlt gesamt',
      kind: 'h',
      val: (x) => LBASE.reduce((a, k) => a + (x.p?.minutes[k] ?? 0), 0),
    });
    if (any((x) => surchargeEur(x.p) > 0n))
      cols.push({ key: 'zuschlag', label: 'Zuschläge €', kind: 'eur', val: (x) => surchargeEur(x.p) });
    if (any((x) => !!x.p?.salary))
      cols.push({ key: 'gehalt', label: 'Gehalt €', kind: 'eur', val: (x) => x.p?.salary?.cents ?? 0n });
    if (any((x) => (x.p?.unpaidMinutes ?? 0) > 0))
      cols.push({
        key: 'unbezahlt',
        label: 'Unbezahlt',
        kind: 'h',
        abs: 'unbezahlt',
        val: (x) => x.p?.unpaidMinutes ?? 0,
      });
    if (any((x) => (x.p?.unpaidDeductionCents ?? 0n) > 0n))
      cols.push({
        key: 'abzug',
        label: 'Abzug €',
        kind: 'eur',
        neg: true,
        abs: 'unbezahlt',
        val: (x) => x.p?.unpaidDeductionCents ?? 0n,
      });
    return cols;
  };
  /** Festgehalt: Grundstunden und Summe nur zur Info */
  const infoOnly = (x: Row, c: LCol) =>
    !!x.p?.salary && (c.key === 'gesamt' || (LBASE as string[]).includes(c.key));
  const lohnText = (c: LCol, v: number | bigint) =>
    c.kind === 'eur'
      ? (v as bigint) > 0n
        ? `${c.neg ? '− ' : ''}${euro(v as bigint)}`
        : ''
      : h(v as number);
  const lohnTotal = (rows: Row[], c: LCol) =>
    c.kind === 'eur'
      ? rows.reduce((a, x) => a + (c.val(x) as bigint), 0n)
      : rows.reduce((a, x) => a + (infoOnly(x, c) ? 0 : (c.val(x) as number)), 0);
  const empLabel = (x: Row) =>
    `${EMPLOYMENT_TYPES[x.e.employment_type]}${x.p?.salary ? ' · Festgehalt' : ''}`;

  const overviewCols = () => [
    'Personalnummer',
    'Name',
    'Beschäftigung',
    'Plan',
    'Gearbeitet',
    'Pausen',
    'Urlaub',
    'Krank',
    'Unbezahlt',
    'Bezahlt',
    'Differenz',
    'Unterschrift',
  ];
  const overviewRow = (x: Row) => [
    x.e.personnel_no,
    `${x.e.last_name}, ${x.e.first_name}`,
    EMPLOYMENT_TYPES[x.e.employment_type],
    hm(x.s.totals.plan),
    hm(x.s.totals.work),
    hm(x.s.totals.breaks),
    h(x.s.totals.vacation),
    h(x.s.totals.sick),
    h(x.s.totals.unpaid),
    hm(x.s.totals.paid),
    `${x.s.totals.diff > 0 ? '+' : ''}${hm(x.s.totals.diff)}`,
    x.state === 'unterschrieben' ? 'ja' : x.state === 'geaendert' ? 'geändert' : 'offen',
  ];

  app.get('/zeiterfassung/stundenzettel.csv', async (c) => {
    const d = await listData(c);
    const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/;/g, ',');
    const lc = lohnCols(d.rows);
    const lines =
      d.view === 'lohnarten'
        ? [
            ['Personalnummer', 'Name', 'Beschäftigung', ...lc.map((c) => c.label)].join(';'),
            ...d.rows.map((x) =>
              [
                x.e.personnel_no,
                `${x.e.last_name}, ${x.e.first_name}`,
                empLabel(x),
                ...lc.map((c) => lohnText(c, c.val(x))),
              ]
                .map(safe)
                .join(';'),
            ),
            ['', 'Gesamt', '', ...lc.map((c) => lohnText(c, lohnTotal(d.rows, c)))].map(safe).join(';'),
          ]
        : [overviewCols().join(';'), ...d.rows.map((x) => overviewRow(x).map(safe).join(';'))];
    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${d.view === 'lohnarten' ? 'lohnarten' : 'stundenliste'}-${d.month}.csv"`,
      },
    });
  });

  const ABS_COL: Record<string, AbsenceKind> = {
    Urlaub: 'urlaub',
    Krank: 'krank',
    Unbezahlt: 'unbezahlt',
    'Unbezahlt Std.': 'unbezahlt',
    'Abzug unbezahlt €': 'unbezahlt',
  };
  // Lohnarten als PDF wie am Bildschirm: nur vorkommende Lohnarten, eine Gesamtzeile (Ahmed 29.10.)
  const RED: [number, number, number] = [0.7, 0.15, 0.12];
  const lohnPdf = async (d: Awaited<ReturnType<typeof listData>>) => {
    const lc = lohnCols(d.rows);
    const fixed = [44, 114, 94];
    // Beträge brauchen mehr Platz als Stunden („12.345,67“), der Rest wird auf die Stundenspalten verteilt
    const eurW = 66;
    const nEur = lc.filter((c) => c.kind === 'eur').length;
    const hW = Math.max(
      40,
      Math.min(
        78,
        Math.floor((786 - fixed.reduce((a, b) => a + b, 0) - nEur * eurW) / Math.max(1, lc.length - nEur)),
      ),
    );
    const pdfLabel = (c: LCol) =>
      ({
        normal: 'Normal',
        gesamt: 'Gesamt',
        feiertag: 'Feiertag Arb.',
        feiertag_hoch: 'Hohe Feiert.',
        feiertag_lfz: 'Feiertag LFZ',
      })[c.key] ?? c.label;
    const pdf = await renderTablePdf({
      title: `Lohnarten ${monthLabel(d.month)}`,
      subtitle: `${d.rows.length} Mitarbeitende · Stunden in Std.:Min. · ${d.fillPlan ? 'erfasste Zeit, sonst geplante Zeit' : 'nur erfasste Zeiten'}`,
      columns: [
        { label: 'Pers.-Nr.', width: fixed[0]! },
        { label: 'Name', width: fixed[1]! },
        { label: 'Beschäftigung', width: fixed[2]! },
        ...lc.map((c) => ({
          label: pdfLabel(c),
          width: c.kind === 'eur' ? eurW : hW,
          align: 'right' as const,
        })),
      ],
      rows: d.rows.map((x) => [
        x.e.personnel_no,
        `${x.e.last_name}, ${x.e.first_name}`,
        empLabel(x),
        ...lc.map((c) => {
          const text = lohnText(c, c.val(x));
          if (!text) return '';
          return {
            text,
            ...(infoOnly(x, c) ? { color: RED } : {}),
            ...(c.abs ? { fill: rgb01(ABSENCE_COLORS[c.abs].tint) } : {}),
            ...(c.key === 'gesamt' ? { bold: true } : {}),
          };
        }),
      ]),
      totals: ['', 'Gesamt', '', ...lc.map((c) => lohnText(c, lohnTotal(d.rows, c)))],
      fontSize: 8.5,
      footnote:
        'Lohnarten für die Lohnabrechnung (je Einsatz die erfasste Zeit, sonst die geplante). Zuschläge nach RTV laut Einstellungen. ' +
        'Rot = Festgehalt: Stunden nur zur Info, bezahlt wird das Gehalt; nicht in der Gesamtzeile. Vertraulich – Personaldaten.',
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="lohnarten-${d.month}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  };
  app.get('/zeiterfassung/stundenzettel/uebersicht.pdf', async (c) => {
    const d = await listData(c);
    if (d.view === 'lohnarten') return lohnPdf(d);
    const cols = overviewCols();
    const widths = [54, 150, 70, 56, 62, 52, 50, 50, 56, 56, 56, 60];
    const tsum = (f: (x: Row) => number) => d.rows.reduce((a, x) => a + f(x), 0);
    const totals = [
      '',
      'Summe',
      '',
      hm(tsum((x) => x.s.totals.plan)),
      hm(tsum((x) => x.s.totals.work)),
      hm(tsum((x) => x.s.totals.breaks)),
      h(tsum((x) => x.s.totals.vacation)),
      h(tsum((x) => x.s.totals.sick)),
      h(tsum((x) => x.s.totals.unpaid)),
      hm(tsum((x) => x.s.totals.paid)),
      '',
      '',
    ];
    const pdf = await renderTablePdf({
      title: `Stundenliste ${monthLabel(d.month)}`,
      subtitle: `${d.rows.length} Mitarbeitende · Stunden in Std.:Min.`,
      columns: cols.map((label, i) => ({
        label: label
          .replace('Zuschlag ', 'Zuschl. ')
          .replace('Sonstige bezahlt', 'Sonst. bez.')
          .replace(/^Personal(nummer|nr\.)$/, 'Pers.-Nr.')
          .replace(/^Beschäftigung(sart)?$/, 'Beschäft.')
          .replace(/^Unterschrift$/, 'Unterschr.'),
        width: widths[i] ?? 44,
        align: i >= 3 && i < cols.length - 1 ? ('right' as const) : ('left' as const),
      })),
      // Abwesenheiten farbig wie im Kalender (Urlaub grün, Krank orange, unbezahlt grau)
      rows: d.rows.map((x) =>
        overviewRow(x).map((v, i) => {
          const k = ABS_COL[cols[i]!];
          return k && v ? { text: v, fill: rgb01(ABSENCE_COLORS[k].tint) } : v;
        }),
      ),
      totals,
      fontSize: 8.5,
      footnote:
        'Stundenliste nach § 17 MiLoG (Beginn, Ende, Dauer – Einzelnachweis je Person unter „Stundenlisten drucken“). Vertraulich – Personaldaten.',
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="stundenliste-${d.month}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // ------------------------------------------------------------ Abwesenheit: Stunden je Tag/Einsatz
  app.get(`/urlaub/:id{${UUID}}/stunden`, async (c) => {
    const id = c.req.param('id');
    const [a] = await sql<
      {
        id: string;
        employee_id: string;
        employee_name: string;
        kind: AbsenceKind;
        start_date: string;
        end_date: string;
        status: string;
      }[]
    >`
      select a.id, a.employee_id, e.last_name || ', ' || e.first_name as employee_name, a.kind::text as kind,
             a.start_date::text, a.end_date::text, a.status::text
        from app.absences a join app.employees e on e.id = a.employee_id where a.id = ${id}`;
    if (!a) return c.notFound();
    const hours = await listAbsenceHours(sql, { absenceId: id });
    const total = hours.reduce((s, x) => s + (x.paid ? x.minutes : 0), 0);
    return page(
      c,
      'Abwesenheit – Stunden',
      'personal',
      <>
        <PageHead
          title={`${ABSENCE_LABEL[a.kind]} ${dateDe(a.start_date)} – ${dateDe(a.end_date)}`}
          crumbs={[
            ['Mitarbeiter', '/personal'],
            [a.employee_name, `/personal/${a.employee_id}/abwesenheiten`],
          ]}
        />
        {a.status !== 'genehmigt' ? (
          <div class="flash warn">Stunden gibt es erst, wenn die Abwesenheit genehmigt ist.</div>
        ) : (
          <>
            <p class="mut" style="max-width:820px">
              Die Abwesenheit gilt automatisch für die geplanten Einsätze (geplante Stunden). Hier können Sie
              je Tag andere Stunden eintragen oder einzelne Tage als unbezahlt markieren. Ohne Einsatzplan
              werden Wochenstunden ÷ 5 je Arbeitstag angesetzt.
            </p>
            <form method="post" action={`/urlaub/${id}/stunden`} class="card">
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Einsatz</th>
                      <th style="width:120px">Stunden</th>
                      <th>bezahlt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hours.map((x) => (
                      <tr>
                        <td>
                          {dayShort(x.work_date)} {dateDe(x.work_date)}
                          <input type="hidden" name="hid" value={x.id} />
                        </td>
                        <td>
                          {x.site_name ? `${x.site_name} ${x.plan_from}–${x.plan_to}` : 'ohne Einsatz'}
                          {x.manual && (
                            <span class="badge" style="margin-left:6px">
                              geändert
                            </span>
                          )}
                        </td>
                        <td>
                          <input name="hours" value={hm(x.minutes)} class="right" aria-label="Stunden" />
                        </td>
                        <td>
                          <select name="paid" aria-label="bezahlt" data-nosearch>
                            <option value="1" selected={x.paid}>
                              bezahlt
                            </option>
                            <option value="0" selected={!x.paid}>
                              unbezahlt
                            </option>
                          </select>
                        </td>
                      </tr>
                    ))}
                    {hours.length === 0 && (
                      <tr>
                        <td colspan={4} class="mut">
                          Keine geplanten Einsätze im Zeitraum – Tag unten von Hand ergänzen.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div class="actions">
                <span class="mut">Bezahlt gesamt: {hm(total)} Std.</span>
                <span style="flex:1" />
                {hours.length > 0 && <button class="btn">Stunden speichern</button>}
              </div>
            </form>
            <form method="post" action={`/urlaub/${id}/stunden/tag`} class="card">
              <h3 style="margin-top:0">Tag ergänzen</h3>
              <div class="grid">
                <div>
                  <label for="d">Tag</label>
                  <input id="d" type="date" name="date" min={a.start_date} max={a.end_date} required />
                </div>
                <div>
                  <label for="hh">Stunden</label>
                  <input id="hh" name="hours" placeholder="z. B. 4:00 oder 4,5" required />
                </div>
                <div>
                  <label for="pp">bezahlt</label>
                  <select id="pp" name="paid" data-nosearch>
                    <option value="1">bezahlt</option>
                    <option value="0">unbezahlt</option>
                  </select>
                </div>
              </div>
              <div class="actions">
                <button class="btn sec">Tag hinzufügen</button>
              </div>
            </form>
          </>
        )}
      </>,
    );
  });

  const minutesOf = (v: string, n: number) => {
    const t = v.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
    if ((m = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(t)))
      return Math.round((Number(m[1]) + Number(`0.${m[2] ?? '0'}`)) * 60);
    throw new BusinessError(`Zeile ${n}: Stunden „${v}“ bitte als 4:00 oder 4,5`);
  };

  app.post(`/urlaub/:id{${UUID}}/stunden`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const ids = arr(b, 'hid');
    const hrs = arr(b, 'hours');
    const paid = arr(b, 'paid');
    await saveAbsenceHours(
      sql,
      id,
      ids.map((x, i) => ({ id: x, minutes: minutesOf(hrs[i] ?? '', i + 1), paid: paid[i] === '1' })),
      c.get('actor'),
    );
    return back(c, `/urlaub/${id}/stunden`, { ok: 'Stunden gespeichert.' });
  });

  app.post(`/urlaub/:id{${UUID}}/stunden/tag`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    await addAbsenceDay(sql, id, {
      date: str(b, 'date') ?? '',
      minutes: minutesOf(str(b, 'hours') ?? '', 1),
      paid: str(b, 'paid') === '1',
    });
    return back(c, `/urlaub/${id}/stunden`, { ok: 'Tag ergänzt.' });
  });

  // ------------------------------------------------------------ Lohnarten (für die Lohnabrechnung)
  app.get('/zeiterfassung/lohnarten', (c) => {
    const m = c.req.query('monat');
    return c.redirect(
      `/zeiterfassung/stundenzettel?ansicht=lohnarten${m ? `&monat=${encodeURIComponent(m)}` : ''}`,
      301,
    );
  });

  app.get('/zeiterfassung/lohnarten.csv', async (c) => {
    const d = await listData(c);
    const month = d.month;
    const st = await getPayrollSettings(sql);
    const rows = d.rows.map((x) => x.p).filter((p): p is NonNullable<typeof p> => !!p);
    const prev = addMonths(month, -1);
    const corr = await payrollCorrections(sql, prev);
    // jeder Lohnprogramm-Export wird festgehalten → Grundlage für die Korrektur im Folgemonat
    await recordPayrollExport(sql, month, d.cutoff, rows, c.get('actor'));
    return new Response(
      payrollCsv(rows, st, month, corr.rows.length ? { month: prev, rows: corr.rows } : undefined),
      {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="lohnarten-${month}.csv"`,
        },
      },
    );
  });

  // Lexware ASCII-Import (ANSI/Windows-1252, ohne Kopfzeile)
  app.get('/zeiterfassung/lohnarten-lexware.txt', async (c) => {
    const d = await listData(c);
    const month = d.month;
    const st = await getPayrollSettings(sql);
    const rows = d.rows.map((x) => x.p).filter((p): p is NonNullable<typeof p> => !!p);
    const prev = addMonths(month, -1);
    const corr = await payrollCorrections(sql, prev);
    const { text, missing } = payrollLexwareAscii(rows, st, month, corr.rows);
    // leere Datei nie still herunterladen (Ahmed 11.10.: „enthält nichts drin“) – Grund nennen
    if (!text) {
      const back2 = `/zeiterfassung/stundenzettel?ansicht=lohnarten&${d.qs()}`;
      return back(c, back2, {
        fehler: missing.length
          ? `Lexware-Datei wäre leer: Es fehlen die Lohnart-Nummern für ${missing
              .map((k) => WAGE_TYPE_LABEL[k])
              .join(
                ', ',
              )}. Bitte unter Einstellungen → Zuschläge & Lohnarten die Nummern aus Lexware eintragen.`
          : `Im Monat ${month.slice(5)}/${month.slice(0, 4)} gibt es für die Auswahl keine Stunden zum Exportieren.`,
      });
    }
    await recordPayrollExport(sql, month, d.cutoff, rows, c.get('actor'));
    return new Response(encodeCp1252(text), {
      headers: {
        'Content-Type': 'text/plain; charset=windows-1252',
        'Content-Disposition': `attachment; filename="lexware-lohnarten-${month}.txt"`,
      },
    });
  });

  app.get('/zeiterfassung/lohnarten/einstellungen', async (c) => {
    const st = await getPayrollSettings(sql);
    const pct = (bp: number) => String(bp / 100).replace('.', ',');
    return page(
      c,
      'Zuschläge & Lohnarten',
      'personal',
      <>
        <PageHead title="Zuschläge & Lohnart-Nummern" crumbs={[['Einstellungen', '/einstellungen']]} />
        <form
          method="post"
          action="/zeiterfassung/lohnarten/einstellungen"
          class="card"
          style="max-width:820px"
        >
          <input type="hidden" name="version" value={String(st.version)} />
          <input type="hidden" name="sunday_regular_bp" value={String(st.sunday_regular_bp / 100)} />
          <h3 style="margin-top:0">Zuschläge (Rahmentarifvertrag Gebäudereinigung § 10)</h3>
          <div class="grid">
            <div>
              <label for="nf">Nachtarbeit von</label>
              <input id="nf" type="time" name="night_from" value={st.night_from} required />
            </div>
            <div>
              <label for="nt">Nachtarbeit bis</label>
              <input id="nt" type="time" name="night_to" value={st.night_to} required />
            </div>
            {(
              [
                ['night_bp', 'Nachtzuschlag %', st.night_bp],
                ['sunday_bp', 'Sonntagszuschlag %', st.sunday_bp],
                ['holiday_bp', 'Feiertagszuschlag %', st.holiday_bp],
                [
                  'high_holiday_bp',
                  'Hohe Feiertage % (Neujahr, Ostersonntag, Pfingstsonntag, 1. Mai, 25./26.12.)',
                  st.high_holiday_bp,
                ],
              ] as const
            ).map(([n, l, v]) => (
              <div>
                <label for={n}>{l}</label>
                <input id={n} name={n} value={pct(v)} class="right" required />
              </div>
            ))}
          </div>
          <h3>Mehrarbeit (RTV § 10)</h3>
          <div class="grid">
            <div>
              <label for="ot_h">Zuschlag ab Stunden je Woche (0 = aus)</label>
              <input
                id="ot_h"
                name="overtime_hours"
                value={String(st.overtime_weekly_minutes / 60).replace('.', ',')}
                class="right"
                required
              />
            </div>
            <div>
              <label for="overtime_bp">Mehrarbeitszuschlag %</label>
              <input id="overtime_bp" name="overtime_bp" value={pct(st.overtime_bp)} class="right" required />
            </div>
          </div>
          <p class="small mut">
            Gezählt je Kalenderwoche (Mo–So) über alle Objekte: Arbeitszeit ohne Pause über der Schwelle (RTV:
            regelmäßige Arbeitszeit 39 Std./Woche). Gilt auch für Teilzeit erst über dieser Schwelle; Stunden
            im Arbeitszeitkonto werden dadurch nicht abgebaut. Zuschläge werden nicht addiert – zusätzlich zu
            Nacht/Sonntag möglich, mit Steuerberater abstimmen.
          </p>
          <p class="small mut">
            Voreinstellung Viva-Deluxe: Nacht 30 %, Sonntag und Feiertag 80 %, hohe Feiertage 150 % – gilt
            automatisch für alle Mitarbeitenden (RTV vom 31.10.2019: Nacht 25 %, Sonntag 100 %, Feiertag 150
            %, regelmäßig 75 % – Tarifbindung prüfen). Bei mehreren Zuschlägen zählt nur der höchste.
            Steuerfrei nach § 3b EStG sind Zuschläge nur bis 25 % (Nacht), 50 % (Sonntag), 125 % (Feiertag)
            bzw. 150 % (hohe Feiertage) und auf höchstens 50 € Grundlohn je Stunde – den Rest versteuert das
            Lohnprogramm.
          </p>
          <h3>Lohnart-Nummern im Lohnprogramm</h3>
          <p class="small mut">
            Export „Lexware (ASCII)“: Windows-1252 (ANSI), Trennzeichen Semikolon, Dezimalkomma, ohne
            Kopfzeile; je Zeile Jahr;Monat;Personalnummer;Lohnartnummer;Wert. Wert = Stunden bei
            Normalstunden, Aushilfslohn, Urlaub, Krank, Feiertag; Euro-Betrag bei Zuschlägen (mit unseren
            Sätzen) und Gehältern. Gehalt / Aushilfsgehalt / Geschäftsführergehalt gilt für Vergütung
            „Festgehalt“ (Minijob → Aushilfsgehalt, Tag „Geschäftsführer“ → Geschäftsführergehalt; anteilig
            bei Ein-/Austritt im Monat) – dann keine Grundlohn-Stunden. Minijob mit Stundenlohn → Aushilfslohn
            statt Normalstunden. Sonstige bezahlte Abwesenheit zählt als Normalstunden. Unbezahlte
            Abwesenheit: bei Stundenlohn nicht bezahlt (keine Zeile); bei Festgehalt Lohnart „Unbezahlte
            Abwesenheit (Abzug)“ mit Minusbetrag = Gehalt ÷ Soll-Stunden des Monats (Einsatzplan) ×
            ausgefallene Stunden. Im Vorab-Export zählen Einsätze mit Urlaub/Krank nur über die Abwesenheit,
            nicht zusätzlich als Normalstunden. Lohnarten ohne Nummer werden nicht exportiert.
          </p>
          <div class="grid">
            {WAGE_TYPES.map((k) => (
              <div>
                <label for={`ln-${k}`}>{WAGE_TYPE_LABEL[k]}</label>
                <input
                  id={`ln-${k}`}
                  name={`ln_${k}`}
                  value={st.wage_type_numbers[k] ?? ''}
                  placeholder="z. B. 1000"
                />
              </div>
            ))}
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/zeiterfassung/lohnarten/einstellungen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const bp = (k: string) => {
      const v = (str(b, k) ?? '').replace(',', '.');
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) throw new BusinessError('Zuschlag bitte als Prozent, z. B. 25');
      return Math.round(Number(v) * 100);
    };
    const numbers: Record<string, string> = {};
    for (const k of WAGE_TYPES) {
      const v = str(b, `ln_${k}`);
      if (v) numbers[k] = v.slice(0, 20);
    }
    await savePayrollSettings(sql, {
      night_from: str(b, 'night_from') ?? '',
      night_to: str(b, 'night_to') ?? '',
      night_bp: bp('night_bp'),
      sunday_bp: bp('sunday_bp'),
      sunday_regular_bp: bp('sunday_regular_bp'),
      holiday_bp: bp('holiday_bp'),
      high_holiday_bp: bp('high_holiday_bp'),
      overtime_bp: bp('overtime_bp'),
      overtime_weekly_minutes: (() => {
        const v = Number((str(b, 'overtime_hours') ?? '').replace(',', '.'));
        if (!Number.isFinite(v) || v < 0 || v > 80) throw new BusinessError('Mehrarbeit ab: 0–80 Stunden');
        return Math.round(v * 60);
      })(),
      wage_type_numbers: numbers,
      expectedVersion: Number(str(b, 'version')) || null,
    });
    return back(c, '/zeiterfassung/lohnarten/einstellungen', { ok: 'Gespeichert.' });
  });
}
