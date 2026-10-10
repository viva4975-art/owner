import type { Sql } from '../db/client.js';

/** Firmenstamm der Viva-Deluxe Gebäudereinigung GmbH (aus dem Briefing). Idempotent. */
export async function seedCompany(sql: Sql) {
  await sql`
    insert into app.company (id, legal_name, street, postal_code, city, vat_id, tax_number, register_court,
                             register_number, managing_director, phone, fax, email, website, bank_accounts,
                             job_whatsapp)
    values (1, 'Viva-Deluxe Gebäudereinigung GmbH', 'Würmtalstr. 10', '81375', 'München', 'DE341586171',
            '143/190/63154', 'Amtsgericht München', 'HRB 262 567', 'Ahmed Chomontek', '+49 89 63855496',
            '+49 89 99753096',
            'info@viva-deluxe-reinigung.de', 'www.viva-deluxe-reinigung.de',
            ${sql.json([
              {
                name: 'Münchner Bank',
                iban: 'DE39 7019 0000 0003 2978 37',
                bic: 'GENODEF1M01',
                primary: true,
              },
              { name: 'Targobank', iban: 'DE66 7019 0000 0003 1914 27', bic: 'CMCIDEDDXXX' },
            ])}, '0176 63050802')
    on conflict (id) do nothing`;
}

// Feste IDs → der Seed ist beliebig oft ausführbar.
export const DEMO = {
  authority: '00000000-0000-4000-8000-000000000001',
  company: '00000000-0000-4000-8000-000000000002',
  siteSchool: '00000000-0000-4000-8000-000000000011',
  siteOffice: '00000000-0000-4000-8000-000000000012',
  siteHq: '00000000-0000-4000-8000-000000000013',
};

/** Beispieldaten zum Ausprobieren (eindeutig als Demo gekennzeichnet). */
export async function seedDemo(sql: Sql) {
  await seedCompany(sql);
  await sql`
    insert into app.customers (id, customer_no, name, name2, street, postal_code, city, is_public_authority,
                               leitweg_id, supplier_no, invoice_emails, invoice_format, payment_terms_days,
                               skonto_percent_bp, skonto_days, contact_name)
    values
      (${DEMO.authority}, '29901', 'DEMO Beispielbehörde Referat für Bildung', 'Abteilung Gebäudemanagement',
       'Musterstraße 1', '80331', 'München', true, '04011000-1234512345-06', '4711',
       ${['rechnungseingang@beispielbehoerde.example']}, 'xrechnung', 30, null, null, null),
      (${DEMO.company}, '29902', 'DEMO Musterfirma GmbH', null, 'Industriestraße 7', '82152', 'Planegg', false,
       null, null, ${['buchhaltung@musterfirma.example', 'einkauf@musterfirma.example']}, 'zugferd', 20, 300, 7, 'Frau Beispiel')
    on conflict (id) do nothing`;
  await sql`
    insert into app.sites (id, customer_id, site_no, name, street, postal_code, city, order_reference)
    values
      (${DEMO.siteSchool}, ${DEMO.authority}, '2990101', 'Grundschule Musterweg', 'Musterweg 5', '81369', 'München', 'BE-2026-0042'),
      (${DEMO.siteOffice}, ${DEMO.authority}, '2990102', 'Verwaltungsgebäude Am Platz', 'Am Platz 3', '80331', 'München', null),
      (${DEMO.siteHq}, ${DEMO.company}, '2990201', 'Firmenzentrale Planegg', 'Industriestraße 7', '82152', 'Planegg', null)
    on conflict (id) do nothing`;
  await sql`
    insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents, vat_rate_bp, valid_from, sort_order, note)
    values
      ('00000000-0000-4000-8000-000000000101', ${DEMO.siteSchool}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 485000, 1900, '2026-01-01', 1, 'lt. Leistungsverzeichnis vom 01.01.2026'),
      ('00000000-0000-4000-8000-000000000102', ${DEMO.siteSchool}, 'monthly_flat', 'Sanitärreinigung täglich', 'LS', 1000, 62000, 1900, '2026-01-01', 2, null),
      ('00000000-0000-4000-8000-000000000103', ${DEMO.siteSchool}, 'hourly', 'Regiestunden Sonderreinigung', 'HUR', 1000, 2980, 1900, '2026-01-01', 3, null),
      ('00000000-0000-4000-8000-000000000104', ${DEMO.siteSchool}, 'special', 'Glasreinigung innen/außen', 'C62', 1000, 38000, 1900, '2026-01-01', 4, null),
      ('00000000-0000-4000-8000-000000000105', ${DEMO.siteOffice}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 212050, 1900, '2026-01-01', 1, '2.018,13 € + 5,07% Tariflohnerhöhung ab 01.01.2026'),
      ('00000000-0000-4000-8000-000000000106', ${DEMO.siteHq}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 139900, 1900, '2026-01-01', 1, null),
      ('00000000-0000-4000-8000-000000000107', ${DEMO.siteHq}, 'hourly', 'Regiestunden', 'HUR', 1000, 3150, 1900, '2026-01-01', 2, null)
    on conflict (id) do nothing`;
  // Sonderleistung und Regie werden je Ausführung abgerechnet
  await sql`update app.site_services set billing_cycle = 'je_ausfuehrung'
             where kind in ('special', 'hourly') and billing_cycle = 'monatlich'`;
}

const D = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;

/** Demo-Daten für Angebote, Lieferanten, Inventar (relativ zu heute, damit Fristen sichtbar sind). */
export async function seedDemoModules(sql: Sql) {
  const { saveOffer, setOfferStatus } = await import('./offers.js');
  const { todayBerlin } = await import('../domain/invoice/calc.js');
  const today = todayBerlin();
  const plus = (days: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  await sql`
    insert into app.customers (id, customer_no, name, street, postal_code, city, is_public_authority, invoice_emails,
                               invoice_format, payment_terms_days, status)
    values (${D(1)}, '29990', 'DEMO Gemeinde Musterhausen – Bauamt', 'Rathausplatz 1', '82110', 'Germering', true,
            ${['bauamt@musterhausen.example']}, 'zugferd', 30, 'interessent')
    on conflict (id) do nothing`;
  const offers: [
    string,
    string,
    string,
    number | null,
    'entwurf' | 'versendet' | 'angenommen',
    [string, number, number, boolean][],
  ][] = [
    [
      D(11),
      D(1),
      'Unterhaltsreinigung Rathaus und Bürgerbüro',
      5,
      'entwurf',
      [
        ['Unterhaltsreinigung Rathaus lt. LV Los 1', 1000, 389000, true],
        ['Unterhaltsreinigung Bürgerbüro lt. LV Los 2', 1000, 96000, true],
        ['Grundreinigung Bodenbeläge vor Beginn', 1000, 245000, false],
      ],
    ],
    [
      D(12),
      DEMO.authority,
      'Glasreinigung Schulzentrum Nord (2x jährlich)',
      12,
      'entwurf',
      [['Glasreinigung innen/außen je Durchgang', 2000, 198000, false]],
    ],
    [
      D(13),
      DEMO.company,
      'Erweiterung Unterhaltsreinigung 2. OG',
      null,
      'versendet',
      [['Unterhaltsreinigung 2. OG, 5x wöchentlich', 1000, 74500, true]],
    ],
    [
      D(14),
      DEMO.authority,
      'Sonderreinigung nach Umbau Turnhalle',
      null,
      'angenommen',
      [
        ['Bauendreinigung Turnhalle', 1000, 184000, false],
        ['Regiestunden', 12000, 2980, false],
      ],
    ],
  ];
  for (const [id, cust, title, days, status, lines] of offers) {
    const [exists] = await sql`select 1 from app.offers where id = ${id}`;
    if (exists) continue;
    await saveOffer(
      sql,
      id,
      {
        customerId: cust,
        siteId: null,
        title,
        tenderReference: days ? `2026-V-${100 + days}` : null,
        tenderPlatform: days ? 'Bayerischer Vergabemarktplatz' : null,
        submissionDeadline: days ? `${plus(days)}T10:00` : null,
        offerDate: today,
        validUntil: plus(90),
        introText: null,
        closingText: null,
        lines: lines.map(([description, quantity, unitPrice, recurring]) => ({
          description,
          detail: null,
          quantity: BigInt(quantity) as never,
          unitCode: description.startsWith('Regie') ? 'HUR' : 'C62',
          unitPrice: BigInt(unitPrice) as never,
          vatRate: 1900,
          recurring,
        })),
      },
      'demo',
    );
    if (status !== 'entwurf') await setOfferStatus(sql, id, 'versendet', 'demo');
    if (status === 'angenommen') await setOfferStatus(sql, id, 'angenommen', 'demo');
  }
  await sql`
    insert into app.suppliers (id, supplier_no, name, kind, street, postal_code, city, email, phone, contact_name,
                               payment_terms_days, exemption_valid_until, clearance_valid_until, iban, bic)
    values
      (${D(21)}, '70001', 'DEMO Reinigungsbedarf Süd GmbH', 'lieferant', 'Gewerbering 4', '85748', 'Garching',
       'bestellung@reinigungsbedarf.example', '089 1234567', 'Herr Muster', 14, null, null, 'DE89370400440532013000', 'COBADEFFXXX'),
      (${D(22)}, '70002', 'DEMO Glas & Fassade Service UG', 'nachunternehmer', 'Seestraße 9', '82319', 'Starnberg',
       'info@glasfassade.example', '08151 98765', 'Frau Beispiel', 30, ${plus(20)}, ${plus(120)}, 'DE02120300000000202051', null)
    on conflict (id) do nothing`;
  await sql`
    insert into app.articles (id, article_no, name, unit, stock_milli, min_stock_milli, supplier_id, purchase_price_cents)
    values
      (${D(31)}, '1001', 'Allzweckreiniger 10 l', 'Kanister', 4000, 6000, ${D(21)}, 2890),
      (${D(32)}, '1002', 'Sanitärreiniger 10 l', 'Kanister', 12000, 4000, ${D(21)}, 3450),
      (${D(33)}, '1003', 'Müllbeutel 120 l (Rolle à 25)', 'Rolle', 30000, 40000, ${D(21)}, 690),
      (${D(34)}, '1004', 'Mikrofasertücher blau (10 Stk.)', 'Pack', 18000, 10000, ${D(21)}, 1290)
    on conflict (id) do nothing`;
  await sql`
    insert into app.devices (id, inventory_no, name, manufacturer, serial_no, site_id, purchase_date, next_inspection)
    values
      (${D(41)}, '5001', 'Scheuersaugmaschine', 'Kärcher B 50 W', 'KB50-221873', ${DEMO.siteSchool}, '2023-04-12', ${plus(14)}),
      (${D(42)}, '5002', 'Nass-/Trockensauger', 'Nilfisk VP300', 'NF-778123', ${DEMO.siteOffice}, '2024-09-01', ${plus(200)}),
      (${D(43)}, '5003', 'Einscheibenmaschine', 'Taski ergodisc 165', 'TE-99812', null, '2022-02-15', ${plus(-3)})
    on conflict (id) do nothing`;
  await sql`
    insert into app.keys (id, key_no, site_id, description, quantity)
    values
      (${D(51)}, 'S-2990101-01', ${DEMO.siteSchool}, 'Haupteingang + Putzraum', 2),
      (${D(52)}, 'S-2990102-01', ${DEMO.siteOffice}, 'Generalschlüssel Verwaltung', 1)
    on conflict (id) do nothing`;
}
