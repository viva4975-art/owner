import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { applyReconcile, reconcileRows } from './ft-reconcile.js';
import { importFtx, renderLegacyInvoicePdf } from './fortytools-xml-import.js';
import { revenueStats } from './statistics.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!available)('Runde 21: Fortytools-Abgleich und Statistik (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  // Vormonat (volle Monatsrechnung, „aktuell“ für den Abgleich)
  const d = new Date(`${todayBerlin().slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const m = d.toISOString().slice(0, 7);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  const mEnd = d.toISOString().slice(0, 10);

  it('gleichnamige Objekte: Zuordnung über Name + Straße, alte Fehlzuordnung wird gelöst; Abgleich übernimmt Preise', async () => {
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city, external_ref)
              values (${cust}, '29977', 'Wohnbau Test GmbH', 'Weg 1', '80331', 'München', 'ft:k29977')`;
    const site = (street: string, no: string, ref: string) => {
      const id = randomUUID();
      return sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city, external_ref)
                 values (${id}, ${cust}, ${no}, 'Treppenhaus', ${street}, '80331', 'München', ${ref}) returning id`.then(
        (r) => r[0]!.id as string,
      );
    };
    // wie auf dem Server: Stollbergstr. trägt fälschlich die Fortytools-ID des Objekts in der Arcisstr.
    const a = await site('Stollbergstr. 1', '2997751', 'ftx:f:903');
    const b = await site('Baaderstr. 39', '2997752', 'ft:o:b');
    const c = await site('Arcisstr. 63', '2997753', 'ft:o:c');
    // CSV-Import hatte alle Treppenhaus-Pauschalen an das erste Objekt gehängt
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                             vat_rate_bp, valid_from, sort_order)
              values (${randomUUID()}, ${a}, 'monthly_flat', 'Treppenhaus', 'LS', 1000, 40000, 1900, '2025-01-01', 1),
                     (${randomUUID()}, ${a}, 'monthly_flat', 'Treppenhaus', 'LS', 1000, 15500, 1900, '2025-01-01', 2)`;
    const fac = (id: number, no: string, street: string) =>
      `<facility><number>${no}</number><customer-id>702</customer-id><address><addressable-id>${id}</addressable-id><name>Treppenhaus</name><street>${street}</street><zip>80331</zip><city>München</city></address></facility>`;
    const pos = (fid: number, price: string, s: string, e: string) =>
      `<invoice-position><title>Treppenhaus</title><quantity>1.0</quantity><price>${price}</price><net-amount>${price}</net-amount>
       <service-period-start>${s}</service-period-start><service-period-end>${e}</service-period-end>
       <invoiceable-type>Facility</invoiceable-type><invoiceable-id>${fid}</invoiceable-id>
       <unit><name>pauschal</name></unit><service-type><name>Unterhaltsreinigung</name></service-type></invoice-position>`;
    const files = [
      {
        name: 'customers.xml',
        data: enc(`<customers><customer><number>29977</number><shortname>Wohnbau</shortname>
          <address><addressable-id>702</addressable-id><name>Wohnbau Test GmbH</name><street>Weg 1</street><zip>80331</zip><city>München</city></address>
          </customer></customers>`),
      },
      {
        name: 'facilities.xml',
        data: enc(
          `<facilities>${fac(901, '29978000', 'Stollbergstr. 1')}${fac(902, '29978001', 'Baaderstr. 39')}${fac(903, '29978004', 'Arcisstr. 63')}</facilities>`,
        ),
      },
      {
        name: 'invoices.xml',
        data: enc(`<invoices><invoice><number>9900001</number><date>${mEnd}</date><customer-id>702</customer-id>
          <net-amount>581.00</net-amount><gross-amount>691.39</gross-amount><payment-status>unpaid</payment-status>
          <header-text>Sehr geehrte Damen und Herren,
wir danken für Ihren Auftrag.</header-text><customer><number>29977</number></customer><invoice-positions>
          ${pos(901, '400.0', `${m}-01`, mEnd)}${pos(902, '155.0', `${m}-01`, mEnd)}
          ${pos(903, '26.0', '2025-01-16', '2025-02-15')}
          </invoice-positions></invoice></invoices>`),
      },
    ];
    await importFtx(sql, files, { actor: 't', dryRun: false });
    const refs = await sql<{ id: string; external_ref: string }[]>`
      select id, external_ref from app.sites where customer_id = ${cust}`;
    const refOf = (id: string) => refs.find((r) => r.id === id)?.external_ref;
    expect([refOf(a), refOf(b), refOf(c)]).toEqual(['ftx:f:901', 'ftx:f:902', 'ftx:f:903']);
    const lines = await sql<{ site_id: string }[]>`
      select x.site_id from app.legacy_invoice_lines x join app.legacy_invoices l on l.id = x.invoice_id
       where l.number = '9900001' order by x.position`;
    expect(lines.map((l) => l.site_id)).toEqual([a, b, c]);

    // Abgleich: Stollbergstr. 555 € in der App, 400 € laut Fortytools → übernehmen
    const rows = (await reconcileRows(sql)).filter((r) => r.customer_id === cust);
    const ra = rows.find((r) => r.site_id === a)!;
    expect(ra).toMatchObject({ status: 'abweichend', ft_cents: 40000n, app_cents: 55500n, ft_month: m });
    // Baaderstr. hatte keine Leistung → Monatspauschale aus der Rechnung (XML-Import) → stimmt
    expect(rows.find((r) => r.site_id === b)).toMatchObject({ status: 'gleich', ft_cents: 15500n });
    const res = await applyReconcile(sql, [a, b], 't');
    expect(res).toMatchObject({ sites: 1, ended: 2, created: 1 });
    const after = (await reconcileRows(sql)).filter((r) => r.customer_id === cust && r.site_id !== c);
    expect(after.map((r) => r.status)).toEqual(['gleich', 'gleich']);

    // Statistik: 16.01.–15.02. (31 Tage) → Januar 16/31, Februar 15/31; Kunden nach Rechnungsdatum
    const st = await revenueStats(sql, {
      from: '2025-01-01',
      to: '2025-02-28',
      basis: 'leistung',
      group: 'monat',
      customerId: cust,
    });
    expect(st.periods).toEqual([
      { key: '2025-01', cents: 1342n },
      { key: '2025-02', cents: 1258n },
    ]);
    expect(st.total).toBe(2600n);

    // PDF der Altrechnung
    const [inv] = await sql<{ id: string }[]>`select id from app.legacy_invoices where number = '9900001'`;
    const pdf = await renderLegacyInvoicePdf(sql, inv!.id);
    expect(Buffer.from(pdf.pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });
});
