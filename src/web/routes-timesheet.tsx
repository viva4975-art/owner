import { todayBerlin } from '../domain/invoice/calc.js';
import { SiteOptions } from './site-options.js';
import {
  ABSENCE_LABEL,
  type AbsenceKind,
  addAbsenceDay,
  listAbsenceHours,
  saveAbsenceHours,
} from '../services/absences.js';
import { BusinessError } from '../services/errors.js';
import { EMPLOYMENT_TYPES, listEmployees } from '../services/employees.js';
import { renderTablePdf } from '../pdf/table.js';
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
  WAGE_TYPES,
  WAGE_TYPE_LABEL,
  getPayrollSettings,
  payrollCsv,
  payrollMonth,
  savePayrollSettings,
} from '../services/payroll.js';
import type { Context } from 'hono';
import type { AppEnv, Ctx } from './app.js';
import { arr, str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';

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
        ? `${esc(ABSENCE_SHORT[r.absence])}${r.absenceMinutes ? ` ${h(r.absenceMinutes)}` : ''}${r.absence && !r.absencePaid && r.absenceMinutes ? ' (unbezahlt)' : ''}`
        : '';
      const st =
        r.status === 'beantragt'
          ? '<span class="ts-warn">Nachtrag in Prüfung</span>'
          : r.status === 'laeuft'
            ? '<span class="ts-warn">läuft</span>'
            : r.late
              ? '<span class="ts-warn">nach 7 Tagen erfasst</span>'
              : '';
      return `<tr${r.holiday ? ' class="ts-hol"' : ''}><td>${dayShort(r.date)} ${dateDe(r.date).slice(0, 6)}</td><td>${esc(r.site)}${r.holiday ? `<div class="ts-sub">${esc(r.holiday)}</div>` : ''}</td>
<td>${r.planFrom ? `${r.planFrom}–${r.planTo}` : ''}</td><td class="r">${h(r.planMinutes)}</td>
<td>${r.start ?? ''}</td><td>${r.end ?? ''}</td><td>${r.breakFrom ? `${r.breakFrom}–${r.breakTo}` : ''}</td><td class="r">${r.breakMinutes ? r.breakMinutes : ''}</td>
<td class="r"><b>${h(r.workMinutes)}</b></td><td>${abs}</td><td>${st}${r.note ? `<div class="ts-sub">${esc(r.note)}</div>` : ''}</td></tr>`;
    })
    .join('');
  const t = s.totals;
  return `<table class="ts"><thead><tr><th>Tag</th><th>Objekt</th><th>Soll</th><th class="r">Std.</th><th>Beginn</th><th>Ende</th><th>Pause von–bis</th><th class="r">Min.</th><th class="r">Arbeitszeit</th><th>Abwesenheit</th><th>Hinweis</th></tr></thead>
<tbody>${body || '<tr><td colspan="11" class="ts-empty">Keine Einsätze, Zeiten oder Abwesenheiten in diesem Monat.</td></tr>'}</tbody></table>
<table class="ts-sum"><tbody>
<tr><td>Soll (geplant)</td><td class="r">${hm(t.plan)}</td><td>Gearbeitet (netto)</td><td class="r"><b>${hm(t.work)}</b></td><td>Pausen</td><td class="r">${hm(t.breaks)}</td></tr>
<tr><td>Urlaub</td><td class="r">${hm(t.vacation)}</td><td>Krank</td><td class="r">${hm(t.sick)}</td><td>Sonstige bezahlt</td><td class="r">${hm(t.otherPaid)}</td></tr>
<tr><td>Unbezahlt</td><td class="r">${hm(t.unpaid)}</td><td><b>Bezahlte Stunden gesamt</b></td><td class="r"><b>${hm(t.paid)}</b></td><td>Differenz zum Soll</td><td class="r">${t.diff > 0 ? '+' : ''}${hm(t.diff)}</td></tr>
</tbody></table>`;
}

export const SHEET_CSS = `
.ts{width:100%;border-collapse:collapse;font-size:12.5px}.ts th,.ts td{border-bottom:1px solid #e6e3df;padding:5px 6px;text-align:left;vertical-align:top}
.ts th{background:#f8f7f5;font-weight:600;font-size:11.5px;color:#57534e}.ts .r{text-align:right;font-variant-numeric:tabular-nums}
.ts-hol td{background:#eef4fb}.ts-sub{font-size:11px;color:#78716c}.ts-warn{color:#b45309;font-weight:600;font-size:11.5px}.ts-empty{text-align:center;color:#78716c;padding:18px}
.ts-sum{margin-top:12px;border-collapse:collapse;font-size:12.5px;min-width:60%}.ts-sum td{padding:4px 10px;border-bottom:1px solid #eee}.ts-sum .r{text-align:right;font-variant-numeric:tabular-nums}`;

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
.hd h1{margin:0;font-size:17px;color:#7D1435}.hd .logo{height:34px;margin-bottom:3px}.hd .m{font-size:11.5px;color:#57534e;line-height:1.45}.hd .r{text-align:right}
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
      ? `<div class="legal">Auszug nur mit den Zeiten im Objekt „${esc(s.onlySite)}“. Der vollständige Stundenzettel des Monats (mit Unterschrift) liegt in der Personalakte.</div>`
      : signatureBlock(
          s,
          sig,
          sig ? `/personal/${s.employee.id}/stundenzettel/unterschrift/${sig.id}.png` : null,
        );
    return `<div class="sheet"><div class="hd"><div><h1>Stundenzettel ${esc(monthLabel(s.month))}${s.onlySite ? ` – Objekt ${esc(s.onlySite)}` : ''}</h1>
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
            Der Mitarbeiter unterschreibt den Stundenzettel am Monatsende in der Handy-App. Ändert sich danach
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
    return c.html(
      printHtml(`Stundenzettel ${s.employee.name} ${monthLabel(month)}`, [await sheetSection(s)]),
    );
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
    const [all, sigs, pay, siteLinks, sites] = await Promise.all([
      listEmployees(sql),
      signaturesOfMonth(sql, month),
      payrollMonth(sql, month),
      sql<{ employee_id: string; site_id: string }[]>`select employee_id, site_id from app.employee_sites`,
      sql<{ id: string; site_no: string; name: string; customer_name: string }[]>`
        select s.id, s.site_no, s.name, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id where s.active order by s.name`,
    ]);
    const lq = q.toLowerCase();
    const emps = all.filter(
      (e) =>
        e.entry_date <= to &&
        (!e.exit_date || e.exit_date >= from) &&
        (!lq || `${e.last_name} ${e.first_name} ${e.personnel_no}`.toLowerCase().includes(lq)) &&
        (!art || e.employment_type === art) &&
        (!site || siteLinks.some((l) => l.employee_id === e.id && l.site_id === site)),
    );
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
      .filter((x) => x.s.rows.length > 0 && (sig === 'alle' || x.state === sig));
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
      for (const [k, v] of Object.entries(o)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      return p.toString();
    };
    return { month, q, art, site, sig, view, rows: all2, chosen, onlySite, siteName, sites, qs };
  };
  const surchargeMin = (p: { minutes: Record<string, number> } | undefined) =>
    p ? SURCHARGES.reduce((a, k) => a + p.minutes[k]!, 0) : 0;
  const surchargeEur = (p: { surchargeCents: Record<string, bigint> } | undefined) =>
    p ? SURCHARGES.reduce((a, k) => a + p.surchargeCents[k]!, 0n) : 0n;

  app.get('/zeiterfassung/stundenzettel', async (c) => {
    const d = await listData(c);
    const { month, rows } = d;
    const st = await getPayrollSettings(sql);
    const signed = rows.filter((x) => x.state === 'unterschrieben').length;
    const tot = (f: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + f(x), 0);
    return page(
      c,
      'Stundenzettel & Lohnarten',
      'personal',
      <>
        <PageHead title={`Stundenzettel & Lohnarten ${monthLabel(month)}`} />
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
var n=0;bs.forEach(function(b){if(b.checked)n++});var btn=document.querySelector('[data-pick-btn]');if(btn){btn.disabled=!n;btn.textContent='Auswahl drucken'+(n?' ('+n+')':'')}});`,
          }}
        />
        <div class="actions">
          <div class="chips" style="margin:0">
            <a href={`?${d.qs({ ansicht: '' })}`} class={d.view === 'stunden' ? 'on' : ''}>
              Stunden
            </a>
            <a href={`?${d.qs({ ansicht: 'lohnarten' })}`} class={d.view === 'lohnarten' ? 'on' : ''}>
              Lohnarten &amp; Zuschläge
            </a>
          </div>
          <span class="mut small">
            {rows.length} Mitarbeitende · {signed} von {rows.length} unterschrieben
          </span>
          <span style="flex:1" />
          <a
            class="btn sm sec"
            href={`/zeiterfassung/stundenzettel/uebersicht.pdf?${d.qs()}`}
            target="_blank"
          >
            PDF Übersicht
          </a>
          <a
            class="btn sm sec"
            href={`/zeiterfassung/stundenzettel/druck?${d.qs()}`}
            target="_blank"
            rel="noopener"
          >
            Alle {rows.length} drucken / PDF
          </a>
          {d.view === 'stunden' && (
            <button class="btn sm sec" form="pick" data-pick-btn disabled>
              Auswahl drucken
            </button>
          )}
          <a class="btn sm sec" href={`/zeiterfassung/stundenzettel.csv?${d.qs()}`}>
            CSV Übersicht
          </a>
          <a class="btn sm" href={`/zeiterfassung/lohnarten.csv?${d.qs()}`}>
            CSV Lohnprogramm
          </a>
        </div>
        {d.view === 'lohnarten' && (
          <p class="small mut" style="max-width:960px">
            Zuschläge nach Rahmentarifvertrag Gebäudereinigung (§ 10) laut{' '}
            <a href="/zeiterfassung/lohnarten/einstellungen">Einstellungen</a>: Nacht {st.night_from}–
            {st.night_to} {st.night_bp / 100} %, Sonntag {st.sunday_bp / 100} %, Feiertag{' '}
            {st.holiday_bp / 100} %, hohe Feiertage {st.high_holiday_bp / 100} % – je Stunde nur der höchste.
            Nur erfasste/freigegebene Zeiten.
          </p>
        )}
        <div class="tbl">
          <table>
            <thead>
              {d.view === 'stunden' ? (
                <tr>
                  <th style="width:28px">
                    <input type="checkbox" aria-label="alle auswählen" data-pick-all />
                  </th>
                  <th>Mitarbeiter</th>
                  <th class="r">Soll</th>
                  <th class="r">Gearbeitet</th>
                  <th class="r">Urlaub</th>
                  <th class="r">Krank</th>
                  <th class="r">Unbezahlt</th>
                  <th class="r">Bezahlt</th>
                  <th class="r">Zuschl.-Std.</th>
                  <th>Unterschrift</th>
                  <th></th>
                </tr>
              ) : (
                <tr>
                  <th>Mitarbeiter</th>
                  {WAGE_TYPES.map((k) => (
                    <th class="r">{WAGE_TYPE_LABEL[k].replace('Zuschlag ', 'Zuschl. ')}</th>
                  ))}
                  <th class="r">Zuschläge €</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map(({ e, s, sg, state, p }) => (
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
                  <td>
                    <a
                      href={`/personal/${e.id}/stundenzettel?monat=${month}${d.onlySite ? `&objekt=${encodeURIComponent(d.siteName)}` : ''}`}
                    >
                      {e.last_name}, {e.first_name}
                    </a>
                    <div class="small mut">
                      {e.personnel_no} · {EMPLOYMENT_TYPES[e.employment_type]}
                      {p && !p.wage_cents && <span class="badge warn"> Lohn fehlt</span>}
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
                      <td class="r">{h(s.totals.vacation)}</td>
                      <td class="r">{h(s.totals.sick)}</td>
                      <td class="r">{h(s.totals.unpaid)}</td>
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
                      {WAGE_TYPES.map((k) => (
                        <td class="r">{h(p?.minutes[k] ?? 0)}</td>
                      ))}
                      <td class="r">{euro(surchargeEur(p))}</td>
                    </>
                  )}
                </tr>
              ))}
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
                    <td>
                      <b>Summe</b>
                    </td>
                    {WAGE_TYPES.map((k) => (
                      <td class="r">
                        <b>{h(tot((x) => x.p?.minutes[k] ?? 0))}</b>
                      </td>
                    ))}
                    <td class="r">
                      <b>{euro(rows.reduce((a, x) => a + surchargeEur(x.p), 0n))}</b>
                    </td>
                  </tr>
                )}
              </tfoot>
            )}
          </table>
        </div>
      </>,
    );
  });

  app.get('/zeiterfassung/stundenzettel/druck', async (c) => {
    const d = await listData(c);
    const sections: string[] = [];
    for (const x of d.chosen) sections.push(await sheetSection(x.s));
    return c.html(printHtml(`Stundenzettel ${monthLabel(d.month)}`, sections));
  });

  const overviewCols = () => [
    'Personalnummer',
    'Name',
    'Beschäftigung',
    'Soll',
    'Gearbeitet',
    'Urlaub',
    'Krank',
    'Sonstige bezahlt',
    'Unbezahlt',
    'Bezahlt',
    ...SURCHARGES.map((k) => WAGE_TYPE_LABEL[k]),
    'Zuschläge €',
    'Unterschrift',
  ];
  const overviewRow = (x: Awaited<ReturnType<typeof listData>>['rows'][number]) => [
    x.e.personnel_no,
    `${x.e.last_name}, ${x.e.first_name}`,
    EMPLOYMENT_TYPES[x.e.employment_type],
    hm(x.s.totals.plan),
    hm(x.s.totals.work),
    h(x.s.totals.vacation),
    h(x.s.totals.sick),
    h(x.s.totals.otherPaid),
    h(x.s.totals.unpaid),
    hm(x.s.totals.paid),
    ...SURCHARGES.map((k) => h(x.p?.minutes[k] ?? 0)),
    euro(surchargeEur(x.p)),
    x.state === 'unterschrieben' ? 'ja' : x.state === 'geaendert' ? 'geändert' : 'offen',
  ];

  app.get('/zeiterfassung/stundenzettel.csv', async (c) => {
    const d = await listData(c);
    const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/;/g, ',');
    const lines = [overviewCols().join(';'), ...d.rows.map((x) => overviewRow(x).map(safe).join(';'))];
    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="stundenzettel-${d.month}.csv"`,
      },
    });
  });

  app.get('/zeiterfassung/stundenzettel/uebersicht.pdf', async (c) => {
    const d = await listData(c);
    const cols = overviewCols();
    const widths = [48, 120, 58, 40, 46, 40, 40, 44, 44, 44, 44, 44, 44, 44, 52, 52];
    const tsum = (f: (x: (typeof d.rows)[number]) => number) => d.rows.reduce((a, x) => a + f(x), 0);
    const pdf = await renderTablePdf({
      title: `Stundenzettel & Lohnarten ${monthLabel(d.month)}`,
      subtitle: `${d.rows.length} Mitarbeitende · Stunden in Std.:Min.`,
      columns: cols.map((label, i) => ({
        label: label.replace('Zuschlag ', 'Zuschl. ').replace('Sonstige bezahlt', 'Sonst. bez.'),
        width: widths[i] ?? 44,
        align: i >= 3 && i < cols.length - 1 ? ('right' as const) : ('left' as const),
      })),
      rows: d.rows.map((x) => overviewRow(x)),
      totals: [
        '',
        'Summe',
        '',
        hm(tsum((x) => x.s.totals.plan)),
        hm(tsum((x) => x.s.totals.work)),
        h(tsum((x) => x.s.totals.vacation)),
        h(tsum((x) => x.s.totals.sick)),
        h(tsum((x) => x.s.totals.otherPaid)),
        h(tsum((x) => x.s.totals.unpaid)),
        hm(tsum((x) => x.s.totals.paid)),
        ...SURCHARGES.map((k) => h(tsum((x) => x.p?.minutes[k] ?? 0))),
        euro(d.rows.reduce((a, x) => a + surchargeEur(x.p), 0n)),
        '',
      ],
      fontSize: 7,
      footnote:
        'Aufzeichnung nach § 17 MiLoG. Zuschläge nach RTV Gebäudereinigung laut Einstellungen; nur erfasste/freigegebene Zeiten. Vertraulich – Personaldaten.',
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="stundenzettel-${d.month}.pdf"`,
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
    return new Response(payrollCsv(rows, st, month), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="lohnarten-${month}.csv"`,
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
          <p class="small mut">
            Voreinstellung Viva-Deluxe: Nacht 30 %, Sonntag und Feiertag 80 %, hohe Feiertage 200 % – gilt
            automatisch für alle Mitarbeitenden (RTV vom 31.10.2019: Nacht 25 %, Sonntag 100 %, Feiertag 150
            %, regelmäßig 75 % – Tarifbindung prüfen). Bei mehreren Zuschlägen zählt nur der höchste.
            Steuerfrei nach § 3b EStG sind Zuschläge nur bis 25 % (Nacht), 50 % (Sonntag), 125 % (Feiertag)
            bzw. 150 % (hohe Feiertage) und auf höchstens 50 € Grundlohn je Stunde – den Rest versteuert das
            Lohnprogramm.
          </p>
          <h3>Lohnart-Nummern im Lohnprogramm</h3>
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
      wage_type_numbers: numbers,
      expectedVersion: Number(str(b, 'version')) || null,
    });
    return back(c, '/zeiterfassung/lohnarten/einstellungen', { ok: 'Gespeichert.' });
  });
}
