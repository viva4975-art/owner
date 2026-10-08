import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEFAULT_DASH, normalizeDash } from '../web/pages-crm.js';
import { applyDueHours, hoursHistory, recordHoursChange, sollMinutes } from './employee-hours.js';
import { importFtx, parseFtx } from './fortytools-xml-import.js';
import { missingDocs } from './hr-required-docs.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { sheetForSite, sumRows, timesheet } from './timesheet.js';
import { archiveLink, listFiles, storeFile } from './uploads.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode(s);

// kleine, ausgedachte Fortytools-Exporte (keine echten Daten)
const CUSTOMERS = `<?xml version="1.0" encoding="UTF-8"?><customers><customer>
  <number>29977</number><shortname>Testamt</shortname><email>amt@example.org</email>
  <customer-state><name>Kunde</name></customer-state><payment-practice><name>7 Tage 3%, 20 Tage netto</name></payment-practice>
  <address><addressable-id>501</addressable-id><name>Testamt Nord</name><street>Amtsweg 1</street><zip>81375</zip><city>München</city></address>
</customer></customers>`;
const FACILITIES = `<facilities><facility><number>2997701</number><customer-id>501</customer-id>
  <address><addressable-id>601</addressable-id><name>Amtsgebäude</name><street>Amtsweg 1</street><zip>81375</zip><city>München</city></address>
</facility></facilities>`;
const STAFF = `<staff-members><staff-member><number>9901</number><weekly-hours>20.0</weekly-hours>
  <date-of-joining>2024-03-01</date-of-joining><vacation-days-per-year>28</vacation-days-per-year>
  <address><name>Probe, Paula</name><street>Weg 2</street><zip>8000</zip><city>München</city></address>
</staff-member></staff-members>`;
const INVOICES = `<invoices><invoice><number>7700001</number><date>2026-08-01</date><customer-id>501</customer-id>
  <customer><number>29977</number></customer><net-amount>1000.0</net-amount><gross-amount>1190.0</gross-amount>
  <payment-status>open</payment-status><invoice-positions><invoice-position><title>Unterhaltsreinigung</title>
  <quantity>1.0</quantity><price>1000.0</price><net-amount>1000.0</net-amount><unit><name>pauschal</name></unit>
  <invoiceable-type>Facility</invoiceable-type><invoiceable-id>601</invoiceable-id>
  <service-period-start>2026-08-01</service-period-start><service-period-end>2026-08-31</service-period-end>
  </invoice-position></invoice-positions></invoice></invoices>`;

describe.skipIf(!available)('Runde 19 (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'r19-'));
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours)
              values (${emp}, '8901', 'Wanda', 'Woche', '2026-01-01', 20)`;
    await sql`insert into app.employee_hours (employee_id, valid_from, weekly_hours, recorded_by)
              values (${emp}, '2026-01-01', 20, 'test')`;
  });
  afterAll(async () => {
    await sql?.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('Wochenstunden mit „gültig ab“: Verlauf, Soll je Abschnitt, Zukunft erst am Stichtag', async () => {
    // ab 15.09.2026: 30 Std. → September 2026: 1.–14. mit 20, 15.–30. mit 30 Std.
    await recordHoursChange(sql, emp, 30, '2026-09-15', 'test');
    // Soll = Wochenstunden × 4,33 anteilig nach Kalendertagen: 1.–14. (14/30) mit 20, 15.–30. (16/30) mit 30 Std.
    expect(await sollMinutes(sql, emp, '2026-09-01', '2026-09-30')).toBe(
      Math.round((20 * 60 * 4.33 * 14) / 30) + Math.round((30 * 60 * 4.33 * 16) / 30),
    );
    // Eintrag weit in der Zukunft ändert den heutigen Wert nicht
    await recordHoursChange(sql, emp, 35, '2099-01-01', 'test');
    const [e] = await sql`select weekly_hours::text as h from app.employees where id = ${emp}`;
    expect(Number(e!.h)).toBe(30);
    expect((await hoursHistory(sql, emp)).map((h) => [h.valid_from, Number(h.weekly_hours)])).toEqual([
      ['2099-01-01', 35],
      ['2026-09-15', 30],
      ['2026-01-01', 20],
    ]);
    expect(await applyDueHours(sql)).toBe(0);
    // Verlauf ist nur anhängbar
    await expect(sql`delete from app.employee_hours where employee_id = ${emp}`).rejects.toThrow();
  });

  it('Personalakte: ältere Fassung ins Archiv, Pflichtunterlagen zählen nur aktuelle', async () => {
    const cfg = { dir, maxBytes: 1_000_000 };
    const before = (await missingDocs(sql)).find((r) => r.employee_id === emp);
    expect(before?.missing).toContain('Arbeitsvertrag');
    const old = await storeFile(
      sql,
      cfg,
      {
        id: randomUUID(),
        name: 'av-alt.pdf',
        type: 'application/pdf',
        data: enc('%PDF alt'),
        link: { type: 'employee', id: emp },
        category: 'Arbeitsvertrag',
      },
      'test',
    );
    expect((await missingDocs(sql)).find((r) => r.employee_id === emp)?.missing).not.toContain(
      'Arbeitsvertrag',
    );
    expect(await archiveLink(sql, { type: 'employee', id: emp }, old.id, true, 'test')).toBe(true);
    expect(await archiveLink(sql, { type: 'employee', id: emp }, old.id, true, 'test')).toBe(false);
    const files = await listFiles(sql, { type: 'employee', id: emp });
    expect(files[0]!.archived_at).toBeTruthy();
    // nur noch im Archiv → fehlt wieder
    expect((await missingDocs(sql)).find((r) => r.employee_id === emp)?.missing).toContain('Arbeitsvertrag');
    await archiveLink(sql, { type: 'employee', id: emp }, old.id, false, 'test');
    expect((await listFiles(sql, { type: 'employee', id: emp }))[0]!.archived_at).toBeNull();
  });

  it('Fortytools-XML: Probelauf ändert nichts, Übernahme idempotent, Nummernkreis wird angehoben', async () => {
    expect(() => parseFtx(enc('<!DOCTYPE x><customers/>'))).toThrow(/DTD/);
    expect(() => parseFtx(enc('<foo/>'))).toThrow(/Unbekannte/);
    const files = [
      { name: 'customers.xml', data: enc(CUSTOMERS) },
      { name: 'facilities.xml', data: enc(FACILITIES) },
      { name: 'staff_members.xml', data: enc(STAFF) },
      { name: 'invoices.xml', data: enc(INVOICES) },
    ];
    await importFtx(sql, files, { actor: 'test', dryRun: true });
    expect((await sql`select 1 from app.customers where customer_no = '29977'`).length).toBe(0);
    const r1 = await importFtx(sql, files, { actor: 'test', dryRun: false });
    expect(r1.counters.invoiceNext).toBeTruthy();
    const [c] = await sql`select id, name, payment_terms_days from app.customers where customer_no = '29977'`;
    expect(c).toMatchObject({ name: 'Testamt Nord', payment_terms_days: 20 });
    const [s] = await sql`select name from app.sites where site_no = '2997701'`;
    expect(s?.name).toBe('Amtsgebäude');
    const [e] = await sql`select e.weekly_hours::text as h, p.postal_code from app.employees e
                           join app.employee_private p on p.employee_id = e.id where e.personnel_no = '9901'`;
    expect(e).toMatchObject({ postal_code: '08000' });
    expect(Number(e!.h)).toBe(20);
    const [li] =
      await sql`select net_cents, gross_cents, paid from app.legacy_invoices where number = '7700001'`;
    expect(li).toMatchObject({ net_cents: 100000n, gross_cents: 119000n, paid: false });
    // Rechnungsnummern-Zähler liegt danach über der höchsten Fortytools-Nummer
    const [n] = await sql<
      { next: string }[]
    >`select next_value::text as next from app.number_ranges where key = 'invoice'`;
    expect(BigInt(n!.next)).toBeGreaterThan(7700001n);
    // zweiter Lauf: nichts doppelt
    await importFtx(sql, files, { actor: 'test', dryRun: false });
    expect((await sql`select 1 from app.customers where customer_no = '29977'`).length).toBe(1);
    expect((await sql`select 1 from app.legacy_invoices where number = '7700001'`).length).toBe(1);
    // Altrechnungen: nur „bezahlt“ darf sich ändern
    await expect(
      sql`update app.legacy_invoices set net_cents = 1 where number = '7700001'`,
    ).rejects.toThrow();
  });

  it('Stundenzettel-Auszug je Objekt rechnet nur die Zeilen des Objekts', async () => {
    const s = await timesheet(sql, emp, '2026-10');
    const part = sheetForSite(s, 'gibt es nicht');
    expect(part.rows).toEqual([]);
    expect(part.totals).toEqual(sumRows([]));
    expect(part.onlySite).toBe('gibt es nicht');
  });
});

describe('Startseite anpassen', () => {
  it('unbekannte Karten fallen weg, fehlende kommen in Standardreihenfolge dazu', () => {
    const d = normalizeDash([
      { key: 'abwesend', col: 1, hidden: true },
      { key: 'gibtsnicht', col: 2 },
      { key: 'abwesend', col: 2 },
    ]);
    expect(d[0]).toEqual({ key: 'abwesend', col: 1, hidden: true });
    expect(d.map((x) => x.key).sort()).toEqual(DEFAULT_DASH.map((x) => x.key).sort());
    expect(normalizeDash('kaputt')).toEqual(DEFAULT_DASH);
  });
});
