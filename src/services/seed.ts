import type { Sql } from '../db/client.js';

/** Firmenstamm der Viva-Deluxe GmbH (aus dem Briefing). Idempotent. */
export async function seedCompany(sql: Sql) {
  await sql`
    insert into app.company (id, legal_name, street, postal_code, city, vat_id, tax_number, register_court,
                             register_number, managing_director, phone, email, website, bank_accounts)
    values (1, 'Viva-Deluxe Gebäudereinigung GmbH', 'Würmtalstr. 10', '81375', 'München', 'DE341586171', null,
            'Amtsgericht München', 'HRB 262567', 'Ahmed Chomontek', '+49 89 63855496',
            'info@viva-deluxe-reinigung.de', 'www.viva-deluxe-reinigung.de',
            ${sql.json([
              {
                name: 'Münchner Bank',
                iban: 'DE39 7019 0000 0003 2978 37',
                bic: 'GENODEF1M01',
                primary: true,
              },
              { name: 'Targobank', iban: 'DE66 7019 0000 0003 1914 27', bic: 'CMCIDEDDXXX' },
            ])})
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
                               leitweg_id, supplier_no, invoice_emails, invoice_format, payment_terms_days, contact_name)
    values
      (${DEMO.authority}, 'K-10001', 'DEMO Beispielbehörde Referat für Bildung', 'Abteilung Gebäudemanagement',
       'Musterstraße 1', '80331', 'München', true, '04011000-1234512345-06', '4711',
       ${['rechnungseingang@beispielbehoerde.example']}, 'xrechnung', 30, null),
      (${DEMO.company}, 'K-10002', 'DEMO Musterfirma GmbH', null, 'Industriestraße 7', '82152', 'Planegg', false,
       null, null, ${['buchhaltung@musterfirma.example', 'einkauf@musterfirma.example']}, 'zugferd', 14, 'Frau Beispiel')
    on conflict (id) do nothing`;
  await sql`
    insert into app.sites (id, customer_id, site_no, name, street, postal_code, city, order_reference)
    values
      (${DEMO.siteSchool}, ${DEMO.authority}, 'O-2001', 'Grundschule Musterweg', 'Musterweg 5', '81369', 'München', 'BE-2026-0042'),
      (${DEMO.siteOffice}, ${DEMO.authority}, 'O-2002', 'Verwaltungsgebäude Am Platz', 'Am Platz 3', '80331', 'München', null),
      (${DEMO.siteHq}, ${DEMO.company}, 'O-3001', 'Firmenzentrale Planegg', 'Industriestraße 7', '82152', 'Planegg', null)
    on conflict (id) do nothing`;
  await sql`
    insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents, vat_rate_bp, valid_from, sort_order)
    values
      ('00000000-0000-4000-8000-000000000101', ${DEMO.siteSchool}, 'monthly_flat', 'Unterhaltsreinigung lt. Leistungsverzeichnis', 'MON', 1000, 485000, 1900, '2026-01-01', 1),
      ('00000000-0000-4000-8000-000000000102', ${DEMO.siteSchool}, 'monthly_flat', 'Sanitärreinigung täglich', 'MON', 1000, 62000, 1900, '2026-01-01', 2),
      ('00000000-0000-4000-8000-000000000103', ${DEMO.siteSchool}, 'hourly', 'Regiestunden Sonderreinigung', 'HUR', 1000, 2980, 1900, '2026-01-01', 3),
      ('00000000-0000-4000-8000-000000000104', ${DEMO.siteSchool}, 'special', 'Glasreinigung innen/außen', 'C62', 1000, 38000, 1900, '2026-01-01', 4),
      ('00000000-0000-4000-8000-000000000105', ${DEMO.siteOffice}, 'monthly_flat', 'Unterhaltsreinigung Büroflächen', 'MON', 1000, 212050, 1900, '2026-01-01', 1),
      ('00000000-0000-4000-8000-000000000106', ${DEMO.siteHq}, 'monthly_flat', 'Unterhaltsreinigung Pauschale', 'MON', 1000, 139900, 1900, '2026-01-01', 1),
      ('00000000-0000-4000-8000-000000000107', ${DEMO.siteHq}, 'hourly', 'Regiestunden', 'HUR', 1000, 3150, 1900, '2026-01-01', 2)
    on conflict (id) do nothing`;
}
