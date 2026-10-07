import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  applyArticles,
  applyTimes,
  centsOf,
  detectMore,
  planArticles,
  planTimes,
} from './fortytools-more-import.js';
import { countWithoutShift, listEmployees } from './employees.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { plannedShifts } from './time.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode(`\uFEFF${s}`);

describe('centsOf', () => {
  it('rechnet exakt ohne Gleitkomma', () => {
    expect(centsOf('17.0')).toBe(1700n);
    expect(centsOf('0.62')).toBe(62n);
    expect(centsOf('1.234,50')).toBe(123450n);
    expect(centsOf('')).toBeNull();
  });
});

describe.skipIf(!available)('Runde 23: Artikel und Zeiten aus Fortytools (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values ('00000000-0000-4000-8000-0000000000c1', '29001', 'Stadt Test', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.sites (id, customer_id, site_no, name)
              values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '2900101',
                      'Grundschule Ost')`;
    for (const [id, no] of [
      ['00000000-0000-4000-8000-0000000000e1', '1013'],
      ['00000000-0000-4000-8000-0000000000e2', '1020'],
    ])
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours)
                values (${id!}, ${no!}, 'Max', ${`M${no}`}, '2026-01-01', 20)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Artikel: Preise exakt, negativer Bestand → 0, idempotent', async () => {
    const t = detectMore(
      enc(
        'Artikelnummer;Name;Beschreibung;Artikel-Nr.;Einkaufspreis;Verkaufspreis;Lieferant;Notizen;Bestand\n' +
          '1;Reiniger 10 l;"";"";17.0;21.0;;"";-22\n2;Tücher;"";"";0.62;3.0;;"";30\n',
      ),
    );
    expect(t.kind).toBe('artikel');
    const p = await planArticles(sql, t);
    expect(p.issues.some((i) => i.text.includes('negativ'))).toBe(true);
    expect(await applyArticles(sql, t, { update: false, actor: 't' })).toMatchObject({
      created: 2,
      booked: 1,
    });
    expect(await applyArticles(sql, t, { update: false, actor: 't' })).toMatchObject({
      created: 0,
      booked: 0,
    });
    const rows = await sql<{ article_no: string; stock_milli: bigint; sales_price_cents: bigint }[]>`
      select article_no, stock_milli, sales_price_cents from app.articles order by article_no`;
    expect(rows.map((r) => [r.article_no, r.stock_milli, r.sales_price_cents])).toEqual([
      ['1', 0n, 2100n],
      ['2', 30000n, 300n],
    ]);
  });

  it('Zeiten: Personalnummer ausschließen, Objekt über Kunde+Name, ohne Objekt → „Allgemein“, Einsätze ableiten', async () => {
    const head =
      'Mitarbeiter;Mitarbeiternummer;Einsatzort;Kundennummer;Arbeitszeit;Dauer Pause;Dauer Gesamt;Menge;Start;Ende;Datum;Details;Einsatzbeschreibung;Lohnart;Lohnfaktor;Summe;Servicebericht\n';
    const row = (no: string, ort: string, d: string, s = '06:00', e = '08:30') =>
      `X;${no};${ort};29001;;00:00;;;${s};${e};${d};;"Unterhalt\nzweite Zeile";;;;\n`;
    const t = detectMore(
      enc(
        head +
          row('1013', 'Grundschule Ost', '01.09.2026') +
          row('1020', 'Grundschule Ost', '07.09.2026') +
          row('1020', 'Grundschule Ost', '14.09.2026') +
          row('1020', 'Stadt Test', '15.09.2026', '22:00', '01:00'),
      ),
    );
    expect(t.kind).toBe('zeiten');
    const p = await planTimes(sql, t, { exclude: ['1013'] });
    expect(p.excluded).toBe(1);
    expect(p.rows).toHaveLength(3);
    expect(p.newSites).toHaveLength(1);
    expect(p.shifts).toHaveLength(1);
    expect(p.shifts[0]).toMatchObject({ weekday: 1, start: '06:00', end: '08:30' });
    const r = await applyTimes(sql, t, { exclude: ['1013'], shifts: true, actor: 't' });
    expect(r).toMatchObject({ created: 3, shiftsCreated: 1 });
    expect(await applyTimes(sql, t, { exclude: ['1013'], shifts: true, actor: 't' })).toMatchObject({
      created: 0,
      shiftsCreated: 0,
      shiftsUpdated: 0,
    });
    const [night] = await sql<{ h: number }[]>`
      select extract(epoch from end_at - start_at)/3600 as h from app.time_entries where work_date = '2026-09-15'`;
    expect(Number(night!.h)).toBe(3);
    const [plan] = await sql<{ valid_from: string }[]>`select valid_from::text from app.shift_plans`;
    expect(plan!.valid_from).toBe('2026-09-07');
    // Einsatz gilt ab dem ersten Vorkommen → die importierten Zeiten hängen am Einsatz („Zeit bestätigt“)
    const planned = await plannedShifts(sql, { from: '2026-09-07', to: '2026-09-14' });
    expect(planned.map((x) => [x.date, !!x.entry])).toEqual([
      ['2026-09-07', true],
      ['2026-09-14', true],
    ]);
  });

  it('„Allgemein“ im Büro umbenannt → erneuter Import erkennt es (nichts doppelt)', async () => {
    await sql`update app.sites set name = 'Stadt Test' where name = 'Allgemein (aus Fortytools)'`;
    const t = detectMore(
      enc(
        'Mitarbeiter;Mitarbeiternummer;Einsatzort;Kundennummer;Arbeitszeit;Dauer Pause;Dauer Gesamt;Menge;Start;Ende;Datum;Details;Einsatzbeschreibung;Lohnart;Lohnfaktor;Summe;Servicebericht\n' +
          'X;1020;Stadt Test;29001;;00:00;;;22:00;01:00;15.09.2026;;;;;;\n',
      ),
    );
    const p = await planTimes(sql, t, { exclude: [] });
    expect(p.newSites).toHaveLength(0);
    expect(await applyTimes(sql, t, { exclude: [], shifts: false, actor: 't' })).toMatchObject({
      created: 0,
    });
    expect(
      (await sql`select 1 from app.sites where customer_id = '00000000-0000-4000-8000-0000000000c1'`).length,
    ).toBe(2);
  });

  it('Mitarbeitende ohne laufenden Einsatz', async () => {
    expect(await countWithoutShift(sql)).toBe(1);
    const rows = await listEmployees(sql, { status: 'aktiv', withoutShift: true });
    expect(rows.map((r) => r.personnel_no)).toEqual(['1013']);
    expect(await countWithoutShift(sql, ['00000000-0000-4000-8000-0000000000a1'])).toBe(0);
  });
});
