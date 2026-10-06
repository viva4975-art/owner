import { todayBerlin } from '../domain/invoice/calc.js';
import {
  ABSENCE_LABEL,
  type AbsenceKind,
  addAbsenceDay,
  listAbsenceHours,
  saveAbsenceHours,
} from '../services/absences.js';
import { BusinessError } from '../services/errors.js';
import { listEmployees } from '../services/employees.js';
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
import type { Ctx } from './app.js';
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
.hd h1{margin:0;font-size:17px;color:#7D1435}.hd .m{font-size:11.5px;color:#57534e;line-height:1.45}.hd .r{text-align:right}
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

  const sheetSection = async (s: Timesheet) => {
    const co = await company();
    const sig = await latestSignature(sql, s.employee.id, s.month);
    return `<div class="sheet"><div class="hd"><div><h1>Stundenzettel ${esc(monthLabel(s.month))}</h1>
<div class="m"><b>${esc(s.employee.name)}</b> · Personalnr. ${esc(s.employee.personnel_no)}${s.employee.weekly_hours ? ` · ${String(Number(s.employee.weekly_hours)).replace('.', ',')} Std./Woche` : ''}<br>Zeitraum ${dateDe(s.from)} – ${dateDe(s.to)}</div></div>
<div class="m r"><b>${esc(co?.name)}</b><br>${esc(co?.street)}<br>${esc(co?.postal_code)} ${esc(co?.city)}</div></div>
${sheetTableHtml(s)}${signatureBlock(s, sig, sig ? `/personal/${s.employee.id}/stundenzettel/unterschrift/${sig.id}.png` : null)}
<div class="legal">Aufzeichnung nach § 17 MiLoG (Beginn, Ende und Dauer der täglichen Arbeitszeit; Aufbewahrung mindestens 2 Jahre). Pausen nach § 4 ArbZG. Erstellt am ${dateDe(todayBerlin())}.</div></div>`;
  };

  const printHtml = (title: string, sections: string[]) =>
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button></div>${sections.join('')}</body></html>`;

  // ------------------------------------------------------------ je Mitarbeiter (Reiter)
  app.get(`/personal/:id{${UUID}}/stundenzettel`, (c) =>
    shells.employee!(c, 'stundenzettel', async (e) => {
      const month = monthOf(c.req.query('monat'));
      const s = await timesheet(sql, e.id, month);
      const sig = await latestSignature(sql, e.id, month);
      const base = `/personal/${e.id}/stundenzettel`;
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a class="btn sm sec" href={`${base}?monat=${shiftMonth(month, -1)}`}>
              ←
            </a>
            <b style="min-width:150px;text-align:center">{monthLabel(month)}</b>
            <a class="btn sm sec" href={`${base}?monat=${shiftMonth(month, 1)}`}>
              →
            </a>
            <span style="flex:1" />
            {sig ? (
              sig.sheet_hash === s.hash ? (
                <span class="badge ok">
                  ✓ unterschrieben am {dateDe(sig.signed_at.toISOString().slice(0, 10))}
                </span>
              ) : (
                <span class="badge err">nach Unterschrift geändert – neu unterschreiben lassen</span>
              )
            ) : (
              <span class="badge warn">noch nicht unterschrieben</span>
            )}
            <a class="btn sm" href={`${base}/druck?monat=${month}`} target="_blank" rel="noopener">
              Drucken / PDF
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
    const s = await timesheet(sql, c.req.param('id'), month);
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

  // ------------------------------------------------------------ alle Mitarbeitenden eines Monats
  app.get('/zeiterfassung/stundenzettel', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const { from, to } = monthRange(month);
    const emps = (await listEmployees(sql)).filter(
      (e) => e.entry_date <= to && (!e.exit_date || e.exit_date >= from),
    );
    const sigs = await signaturesOfMonth(sql, month);
    const sheets = await Promise.all(emps.map((e) => timesheet(sql, e.id, month)));
    const rows = emps.map((e, i) => ({ e, s: sheets[i]! })).filter((x) => x.s.rows.length > 0);
    const signed = rows.filter((x) => sigs.get(x.e.id)?.sheet_hash === x.s.hash).length;
    return page(
      c,
      'Stundenzettel',
      'personal',
      <>
        <PageHead
          title={`Stundenzettel ${monthLabel(month)}`}
          crumbs={[['Zeiterfassung', '/zeiterfassung']]}
        />
        <div class="actions" style="margin-top:0">
          <a class="btn sm sec" href={`?monat=${shiftMonth(month, -1)}`}>
            ← {monthLabel(shiftMonth(month, -1))}
          </a>
          <a class="btn sm sec" href={`?monat=${shiftMonth(month, 1)}`}>
            {monthLabel(shiftMonth(month, 1))} →
          </a>
          <span style="flex:1" />
          <span class="mut">
            {signed} von {rows.length} unterschrieben
          </span>
          <a
            class="btn sm"
            href={`/zeiterfassung/stundenzettel/druck?monat=${month}`}
            target="_blank"
            rel="noopener"
          >
            Alle drucken / PDF
          </a>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th class="r">Soll</th>
                <th class="r">Gearbeitet</th>
                <th class="r">Urlaub</th>
                <th class="r">Krank</th>
                <th class="r">Unbezahlt</th>
                <th class="r">Bezahlt</th>
                <th>Unterschrift</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ e, s }) => {
                const sg = sigs.get(e.id);
                return (
                  <tr>
                    <td>
                      <a href={`/personal/${e.id}/stundenzettel?monat=${month}`}>
                        {e.last_name}, {e.first_name}
                      </a>
                      <div class="small mut">{e.personnel_no}</div>
                    </td>
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
                    <td>
                      {sg ? (
                        sg.sheet_hash === s.hash ? (
                          <span class="badge ok">✓ {dateDe(sg.signed_at.toISOString().slice(0, 10))}</span>
                        ) : (
                          <span class="badge err">geändert</span>
                        )
                      ) : s.open.running || s.open.pending ? (
                        <span class="badge warn">offene Zeiten</span>
                      ) : (
                        <span class="badge">offen</span>
                      )}
                    </td>
                    <td>
                      <a
                        class="btn sm sec"
                        href={`/personal/${e.id}/stundenzettel/druck?monat=${month}`}
                        target="_blank"
                        rel="noopener"
                      >
                        Drucken
                      </a>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colspan={9} class="mut">
                    Keine Zeiten in diesem Monat.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get('/zeiterfassung/stundenzettel/druck', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const { from, to } = monthRange(month);
    const emps = (await listEmployees(sql)).filter(
      (e) => e.entry_date <= to && (!e.exit_date || e.exit_date >= from),
    );
    const sections: string[] = [];
    for (const e of emps) {
      const s = await timesheet(sql, e.id, month);
      if (s.rows.length) sections.push(await sheetSection(s));
    }
    return c.html(printHtml(`Stundenzettel ${monthLabel(month)}`, sections));
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
  app.get('/zeiterfassung/lohnarten', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const [rows, st] = await Promise.all([payrollMonth(sql, month), getPayrollSettings(sql)]);
    const cols = WAGE_TYPES;
    const sum = (k: (typeof cols)[number]) => rows.reduce((a, r) => a + r.minutes[k], 0);
    return page(
      c,
      'Lohnarten',
      'personal',
      <>
        <PageHead title={`Lohnarten ${monthLabel(month)}`} crumbs={[['Zeiterfassung', '/zeiterfassung']]} />
        <div class="actions" style="margin-top:0">
          <a class="btn sm sec" href={`?monat=${shiftMonth(month, -1)}`}>
            ← {monthLabel(shiftMonth(month, -1))}
          </a>
          <a class="btn sm sec" href={`?monat=${shiftMonth(month, 1)}`}>
            {monthLabel(shiftMonth(month, 1))} →
          </a>
          <span style="flex:1" />
          <a class="btn sm sec" href="/zeiterfassung/lohnarten/einstellungen">
            Zuschläge &amp; Lohnart-Nummern
          </a>
          <a class="btn sm" href={`/zeiterfassung/lohnarten.csv?monat=${month}`}>
            Export für Lohnprogramm (CSV)
          </a>
        </div>
        <p class="small mut" style="max-width:900px">
          Stunden in Std.:Min. Zuschläge nach Rahmentarifvertrag Gebäudereinigung (§ 10): Nacht{' '}
          {st.night_from}–{st.night_to} {st.night_bp / 100} %, Sonntag {st.sunday_bp / 100} % (regelmäßig am
          selben Arbeitsplatz {st.sunday_regular_bp / 100} %), Feiertag {st.holiday_bp / 100} %, hohe
          Feiertage (Neujahr, Ostersonntag, Pfingstsonntag, 1. Mai, 25./26.12.) {st.high_holiday_bp / 100} % –
          je Stunde nur der höchste. Nur erfasste/freigegebene Zeiten; Urlaub/Krank aus den Abwesenheiten
          (Stunden je Einsatz).
        </p>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                {cols.map((k) => (
                  <th class="r">{WAGE_TYPE_LABEL[k].replace('Zuschlag ', 'Zuschl. ')}</th>
                ))}
                <th class="r">Zuschläge €</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>
                    <a href={`/personal/${r.employee_id}/stundenzettel?monat=${month}`}>{r.name}</a>
                    <div class="small mut">
                      {r.personnel_no}
                      {r.wage_cents ? ` · ${euro(r.wage_cents)}/Std.` : ''}
                      {!r.wage_cents && <span class="badge warn"> Lohn fehlt</span>}
                      {r.pending > 0 && <span class="badge warn"> {r.pending} offen</span>}
                    </div>
                  </td>
                  {cols.map((k) => (
                    <td class="r">{h(r.minutes[k])}</td>
                  ))}
                  <td class="r">{euro(SURCHARGES.reduce((a, k) => a + r.surchargeCents[k], 0n))}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colspan={cols.length + 2} class="mut">
                    Keine Zeiten in diesem Monat.
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td>
                    <b>Summe</b>
                  </td>
                  {cols.map((k) => (
                    <td class="r">
                      <b>{h(sum(k))}</b>
                    </td>
                  ))}
                  <td class="r">
                    <b>
                      {euro(
                        rows.reduce(
                          (a, r) => a + SURCHARGES.reduce((x, k) => x + r.surchargeCents[k], 0n),
                          0n,
                        ),
                      )}
                    </b>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </>,
    );
  });

  app.get('/zeiterfassung/lohnarten.csv', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const [rows, st] = await Promise.all([payrollMonth(sql, month), getPayrollSettings(sql)]);
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
                [
                  'sunday_regular_bp',
                  'Sonn-/Feiertag regelmäßig am selben Arbeitsplatz %',
                  st.sunday_regular_bp,
                ],
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
            Voreinstellung Viva-Deluxe: Nacht 30 %, Sonntag und Feiertag 80 % (auch regelmäßig am selben
            Arbeitsplatz), hohe Feiertage 200 % (RTV vom 31.10.2019: Nacht 25 %, Sonntag 100 %, Feiertag 150
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
