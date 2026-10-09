import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { applyTimes, detectMore, planTimes } from './fortytools-more-import.js';
import { payrollMonth } from './payroll.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { plannedShifts } from './time.js';

const available = await dbAvailable();
const BOM = String.fromCharCode(0xfeff);
const enc = (s: string) => new TextEncoder().encode(`${BOM}${s}`);

/** Mini-xlsx (ein Blatt, Inline-Texte) – Fortytools liefert den Zeitbericht als Excel mit Endung .csv */
function xlsx(rows: string[][]): Uint8Array {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`;
  return zipSync({ 'xl/worksheets/sheet1.xml': new TextEncoder().encode(sheet) });
}

const HEAD = [
  'Art',
  'Soll Beginn',
  'Soll Ende',
  'Soll Dauer',
  'Datum',
  'Beginn',
  'Ende',
  'Dauer',
  'Erfasster Beginn',
  'Erfasstes Ende',
  'Erfasste Dauer',
  'Mitarbeiter',
  'Einsatzort',
];
const r = (
  art: string,
  d: string,
  b: string,
  e: string,
  dauer: string,
  ma: string,
  ort: string,
  soll = true,
) => [art, soll ? b : '', soll ? e : '', soll ? dauer : '', d, b, e, dauer, '', '', '', ma, ort];

describe.skipIf(!available)('Zeitbericht aus Fortytools (Excel): Zeiten, Pausen, Abwesenheiten', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values ('00000000-0000-4000-8000-0000000000c1', '29001', 'Stadt Test Referat Bau', 'Weg 1', '80331', 'München')`;
    for (const [id, no, name, street] of [
      ['00000000-0000-4000-8000-0000000000a1', '2900101', 'Grundschule Ost', 'A-Str. 1'],
      ['00000000-0000-4000-8000-0000000000a2', '2900102', 'Turnhalle', 'B-Str. 1'],
      ['00000000-0000-4000-8000-0000000000a3', '2900103', 'Turnhalle', 'C-Str. 1'],
    ])
      await sql`insert into app.sites (id, customer_id, site_no, name, street)
                values (${id!}, '00000000-0000-4000-8000-0000000000c1', ${no!}, ${name!}, ${street!})`;
    // mehrteiliger Nachname anders aufgeteilt als im Bericht
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours, hourly_wage_cents)
              values ('00000000-0000-4000-8000-0000000000e1', '1101', 'Elisa Maria Ferreira de', 'Sousa', '2025-01-01', 20, 1500),
                     ('00000000-0000-4000-8000-0000000000e2', '1102', 'Max', 'Muster', '2025-01-01', 20, 1500)`;
    await sql`insert into app.employee_sites (employee_id, site_id)
              values ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a3')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const rows = [
    HEAD,
    // Mo 02.03. und Mo 09.03.: 06:00–12:30, Dauer netto 6 Std. (30 Min. Pause schon abgezogen)
    r(
      'Einsatzzeit',
      '02.03.2026',
      '06:00',
      '12:30',
      '6',
      'Ferreira de Sousa, Elisa Maria',
      'Grundschule Ost',
    ),
    r(
      'Einsatzzeit',
      '09.03.2026',
      '06:00',
      '12:30',
      '6',
      'Ferreira de Sousa, Elisa Maria',
      'Grundschule Ost',
    ),
    r(
      'Einsatzzeit',
      '30.03.2026',
      '06:00',
      '12:30',
      '6',
      'Ferreira de Sousa, Elisa Maria',
      'Grundschule Ost',
    ),
    // einzelner Termin am Monatsende (Bericht umfasst > 2 Wochen → Einsatz erst ab 2 Vorkommen)
    r('Einsatzzeit', '30.03.2026', '17:00', '18:00', '1', 'Muster, Max', 'Turnhalle', false),
    // gestempelt mit Pausen-Zeile innerhalb der Zeit
    r('Einsatzzeit', '03.03.2026', '07:00', '11:00', '4', 'Muster, Max', 'Turnhalle', false),
    r('Pause', '03.03.2026', '09:00', '09:20', '0.33', 'Muster, Max', '', false),
    // Buchung auf den (von Fortytools gekürzten) Kundennamen → Objekt „Allgemein“
    r('Einsatzzeit', '04.03.2026', '17:00', '18:00', '1', 'Muster, Max', 'Stadt Test Referat', false),
    // Urlaub Mo–Fr + nächsten Mo (Wochenende dazwischen → eine Abwesenheit), Krank ohne Abrechnung, Feiertag
    ...['16', '17', '18', '19', '20', '23'].map((d) =>
      r('Urlaub Tariflohn 1', `${d}.03.2026`, '06:00', '10:00', '4', 'Muster, Max', 'Turnhalle', false),
    ),
    r('Krank ohne Abrechnung', '25.03.2026', '06:00', '08:00', '2', 'Muster, Max', '', false),
    r('Feiertagslohnfortzahlung', '03.04.2026', '06:00', '10:00', '4', 'Muster, Max', 'Turnhalle', false),
    r('Einsatzzeit', '05.03.2026', '08:00', '09:00', '1', 'Unbekannt, Niemand', 'Grundschule Ost'),
  ];

  it('erkennt Excel, ordnet Namen/Objekte zu, Pausen und Abwesenheiten', async () => {
    const t = detectMore(xlsx(rows));
    expect(t.kind).toBe('zeitbericht');
    const p = await planTimes(sql, t, { exclude: [] });
    expect(p.issues.filter((i) => i.level === 'fehler').map((i) => i.text)).toEqual([
      'Mitarbeiter „Unbekannt, Niemand“ nicht gefunden',
    ]);
    expect(p.rows).toHaveLength(6);
    const byDate = new Map(p.rows.map((x) => [x.date, x]));
    expect(byDate.get('2026-03-02')).toMatchObject({
      employee_id: '00000000-0000-4000-8000-0000000000e1',
      break_minutes: 30,
    });
    // gleichnamige „Turnhalle“ → das Objekt, dem die Person zugeordnet ist
    expect(byDate.get('2026-03-03')).toMatchObject({
      site_id: '00000000-0000-4000-8000-0000000000a3',
      break_minutes: 20,
    });
    expect(p.newSites).toHaveLength(1);
    expect(
      p.absences.map((a) => [a.kind, a.start, a.end, a.days.length, a.days.every((d) => d.paid)]),
    ).toEqual([
      ['urlaub', '2026-03-16', '2026-03-23', 6, true],
      ['krank', '2026-03-25', '2026-03-25', 1, false],
    ]);
    expect(p.skippedKinds).toEqual([['Feiertagslohnfortzahlung', 1]]);
    expect(p.shifts.map((s) => [s.weekday, s.start, s.end, s.valid_from])).toEqual([
      [1, '06:00', '12:30', '2026-03-02'],
    ]);
  });

  it('übernimmt idempotent; Zeiten in Lohnarten, Urlaub als bezahlte Stunden, Feiertag aus dem Plan', async () => {
    const t = detectMore(xlsx(rows));
    const a = await applyTimes(sql, t, { exclude: [], shifts: true, actor: 'test' });
    expect(a).toMatchObject({ created: 6, skipped: 0, shiftsCreated: 1, absencesCreated: 2 });
    const b = await applyTimes(sql, t, { exclude: [], shifts: true, actor: 'test' });
    expect(b).toMatchObject({ created: 0, absencesCreated: 0, shiftsCreated: 0 });
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from app.time_entries`;
    expect(n!.n).toBe(6);
    const pay = await payrollMonth(sql, '2026-03');
    const max = pay.find((x) => x.personnel_no === '1102')!;
    expect(max.minutes.normal).toBe(220 + 60 + 60); // 4 Std. − 20 Min. Pause + 2 × 1 Std.
    expect(max.minutes.urlaub).toBe(6 * 240);
    expect(max.minutes.unbezahlt).toBe(120);
    // Einsatz Mo 06:00–12:30 (30 Min. Pause) → Ostermontag 06.04. bezahlter Feiertag 6 Std.
    const april = await payrollMonth(sql, '2026-04');
    expect(april.find((x) => x.personnel_no === '1101')!.minutes.feiertag_lfz).toBe(360);
  });

  it('Einsätze ausgetretener Mitarbeiter zählen bis zum Austritt', async () => {
    await sql`update app.employees set status = 'ausgetreten', exit_date = '2026-03-10'
               where id = '00000000-0000-4000-8000-0000000000e1'`;
    const sh = await plannedShifts(sql, {
      from: '2026-03-01',
      to: '2026-03-31',
      employeeId: '00000000-0000-4000-8000-0000000000e1',
    });
    expect(sh.map((s) => s.date)).toEqual(['2026-03-02', '2026-03-09']);
  });

  it('erkennt den Bericht auch als CSV', () => {
    const t = detectMore(
      enc(
        rows
          .slice(0, 2)
          .map((x) => x.join(';'))
          .join('\n'),
      ),
    );
    expect(t.kind).toBe('zeitbericht');
  });
});
