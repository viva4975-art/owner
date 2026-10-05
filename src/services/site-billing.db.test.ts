import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { getInvoice, issue, saveDraft } from './invoices.js';
import { effectiveBilling, saveSiteBilling, siteBillingInput } from './masterdata.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

const draft = (sql: Sql, siteId: string | null) =>
  saveDraft(
    sql,
    randomUUID(),
    {
      customerId: DEMO.authority,
      siteId,
      kind: 'invoice',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      orderReference: null,
      introText: null,
      closingText: null,
      lines: [
        { description: 'Unterhaltsreinigung', quantity: parseQuantity('1'), unitCode: 'MON', unitPrice: parseEuro('100,00'), vatRate: 1900 },
      ],
    },
    'test',
  );

describe.skipIf(!available)('Rechnungsangaben je Objekt', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  const form = (over: Record<string, string>) =>
    siteBillingInput.parse({
      billing_mode: 'eigen',
      bill_name: '',
      bill_name2: '',
      bill_street: '',
      bill_postal_code: '',
      bill_city: '',
      bill_contact_name: '',
      bill_emails: '',
      bill_format: '',
      bill_leitweg_id: '',
      bill_supplier_no: '',
      bill_payment_terms_days: '',
      bill_skonto_percent_bp: '',
      bill_skonto_days: '',
      ...over,
    });

  it('wie Kunde: alles vom Kunden', async () => {
    const [c] = await sql`select name, invoice_emails, payment_terms_days from app.customers where id = ${DEMO.authority}`;
    const b = await effectiveBilling(sql, DEMO.authority, DEMO.siteSchool);
    expect(b).toMatchObject({ source: 'kunde', name: c!.name, emails: c!.invoice_emails, paymentTermsDays: c!.payment_terms_days });
  });

  it('abweichend: Adresse, E-Mail, Format, Leitweg-ID, Zahlungsziel, Skonto gehen in Entwurf und Ausstellung', async () => {
    await expect(
      saveSiteBilling(sql, DEMO.siteSchool, form({ bill_format: 'xrechnung', bill_leitweg_id: '' }), 't'),
    ).resolves.toBeUndefined(); // Leitweg-ID kommt vom Kunden (Behörde)
    expect(() => form({ bill_name: 'Schulamt' })).toThrow(/Rechnungsadresse/);
    await saveSiteBilling(
      sql,
      DEMO.siteSchool,
      form({
        bill_name: 'Referat für Bildung – Schulverwaltung Süd',
        bill_street: 'Bayerstr. 28',
        bill_postal_code: '80335',
        bill_city: 'München',
        bill_contact_name: 'Frau Schmidt',
        bill_emails: 'schule-sued@muenchen.example, kopie@muenchen.example',
        bill_format: 'zugferd',
        bill_leitweg_id: '09162000-SUED-12',
        bill_payment_terms_days: '45',
        bill_skonto_custom: 'on',
        bill_skonto_percent_bp: '2',
        bill_skonto_days: '10',
      }),
      't',
    );
    const b = await effectiveBilling(sql, DEMO.authority, DEMO.siteSchool);
    expect(b).toMatchObject({
      source: 'objekt',
      name: 'Referat für Bildung – Schulverwaltung Süd',
      emails: ['schule-sued@muenchen.example', 'kopie@muenchen.example'],
      format: 'zugferd',
      leitwegId: '09162000-SUED-12',
      paymentTermsDays: 45,
      skonto: { percentBp: 200, days: 10 },
    });
    // anderes Objekt desselben Kunden bleibt beim Kunden
    expect((await effectiveBilling(sql, DEMO.authority, DEMO.siteOffice)).source).toBe('kunde');

    const id = await draft(sql, DEMO.siteSchool);
    const d = (await getInvoice(sql, id))!.invoice;
    expect(d).toMatchObject({ invoice_format: 'zugferd', buyer_reference: '09162000-SUED-12' });
    await issue(sql, id, 't', '2026-10-01');
    const inv = (await getInvoice(sql, id))!.invoice;
    expect(inv.due_date).toBe('2026-11-15');
    expect(inv).toMatchObject({ skonto_percent_bp: 200, skonto_days: 10, skonto_date: '2026-10-11' });
    expect(inv.buyer_snapshot).toMatchObject({
      name: 'Referat für Bildung – Schulverwaltung Süd',
      street: 'Bayerstr. 28',
      postalCode: '80335',
      contactName: 'Frau Schmidt',
      leitwegId: '09162000-SUED-12',
    });

    // eigenes Skonto „leer“ = kein Skonto, obwohl der Kunde Skonto hat
    await sql`update app.customers set skonto_percent_bp = 300, skonto_days = 7 where id = ${DEMO.authority}`;
    await saveSiteBilling(sql, DEMO.siteSchool, form({ bill_skonto_custom: 'on' }), 't');
    expect((await effectiveBilling(sql, DEMO.authority, DEMO.siteSchool)).skonto).toBeNull();
    expect((await effectiveBilling(sql, DEMO.authority, DEMO.siteOffice)).skonto).toEqual({ percentBp: 300, days: 7 });

    // zurück auf „wie Kunde“ leert alles
    await saveSiteBilling(sql, DEMO.siteSchool, form({ billing_mode: 'kunde', bill_name: 'X', bill_street: 'Y', bill_postal_code: '80331', bill_city: 'Z' }), 't');
    const [s] = await sql`select billing_mode, bill_name, bill_emails from app.sites where id = ${DEMO.siteSchool}`;
    expect(s).toEqual({ billing_mode: 'kunde', bill_name: null, bill_emails: null });
  });
});
