import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { getInvoice, issue, saveDraft } from './invoices.js';
import { groupBillingInput, saveInvoiceGroup, setSiteInvoiceGroup } from './invoice-groups.js';
import { effectiveBilling, saveCustomer, saveSite, standardGroupId } from './masterdata.js';
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
        {
          description: 'Unterhaltsreinigung',
          quantity: parseQuantity('1'),
          unitCode: 'MON',
          unitPrice: parseEuro('100,00'),
          vatRate: 1900,
        },
      ],
    },
    'test',
  );

describe.skipIf(!available)('Rechnungsgruppen = Rechnungseinstellungen je Objekt', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  const billing = (over: Record<string, string>) =>
    groupBillingInput.parse({
      bill_name: '',
      bill_name2: '',
      bill_street: '',
      bill_postal_code: '',
      bill_city: '',
      bill_contact_name: '',
      bill_emails: '',
      bill_format: 'zugferd',
      buyer_reference: '',
      bill_supplier_no: '',
      bill_payment_terms_days: '30',
      bill_skonto_percent_bp: '',
      bill_skonto_days: '',
      ...over,
    });
  const group = (id: string, over: Record<string, string>, combine = false) =>
    saveInvoiceGroup(
      sql,
      id,
      {
        customerId: DEMO.authority,
        name: `Gruppe ${id.slice(0, 6)}`,
        combine,
        billing: billing(over),
        orderReference: null,
        note: null,
        active: true,
        siteIds: null,
        expectedVersion: null,
      },
      't',
    );

  it('Prüfungen der Gruppe', () => {
    expect(() => billing({ bill_name: 'Schulamt' })).toThrow(/Rechnungsadresse/);
    expect(() => billing({ bill_format: 'xrechnung', bill_emails: '' })).toThrow(
      /Leitweg-ID oder eine Rechnungs-E-Mail/,
    );
    // ohne Leitweg-ID, aber mit Rechnungs-E-Mail erlaubt (Firmenkunden)
    expect(() => billing({ bill_format: 'xrechnung', bill_emails: 'rechnung@firma.example' })).not.toThrow();
    expect(() => billing({ bill_skonto_percent_bp: '2' })).toThrow(/zusammen/);
    expect(() => billing({ bill_skonto_percent_bp: '2', bill_skonto_days: '30' })).toThrow(/kürzer/);
  });

  it('Gruppe liefert Adresse, E-Mail, Format, Leitweg-ID, Zahlungsziel, Skonto für Entwurf und Ausstellung', async () => {
    const gid = randomUUID();
    await group(gid, {
      bill_name: 'Referat für Bildung – Schulverwaltung Süd',
      bill_street: 'Bayerstr. 28',
      bill_postal_code: '80335',
      bill_city: 'München',
      bill_contact_name: 'Frau Schmidt',
      bill_emails: 'schule-sued@muenchen.example, kopie@muenchen.example',
      bill_format: 'zugferd',
      buyer_reference: '09162000-SUED-12',
      bill_payment_terms_days: '45',
      bill_skonto_percent_bp: '2',
      bill_skonto_days: '10',
    });
    await setSiteInvoiceGroup(sql, DEMO.siteSchool, gid, 't');
    const b = await effectiveBilling(sql, DEMO.authority, DEMO.siteSchool);
    expect(b).toMatchObject({
      source: 'gruppe',
      name: 'Referat für Bildung – Schulverwaltung Süd',
      emails: ['schule-sued@muenchen.example', 'kopie@muenchen.example'],
      format: 'zugferd',
      leitwegId: '09162000-SUED-12',
      paymentTermsDays: 45,
      skonto: { percentBp: 200, days: 10 },
    });

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
  });

  it('eine Gruppe für mehrere Objekte; leere Adresse = Kundenadresse; kein Skonto in der Gruppe = kein Skonto', async () => {
    const gid = randomUUID();
    await sql`update app.customers set skonto_percent_bp = 300, skonto_days = 7 where id = ${DEMO.authority}`;
    await group(gid, { bill_emails: 'rechnung@stadt.example', bill_payment_terms_days: '20' });
    await setSiteInvoiceGroup(sql, DEMO.siteSchool, gid, 't');
    await setSiteInvoiceGroup(sql, DEMO.siteOffice, gid, 't');
    const [c] = await sql`select name, street from app.customers where id = ${DEMO.authority}`;
    for (const site of [DEMO.siteSchool, DEMO.siteOffice]) {
      const b = await effectiveBilling(sql, DEMO.authority, site);
      expect(b).toMatchObject({ name: c!.name, street: c!.street, emails: ['rechnung@stadt.example'] });
      expect(b.paymentTermsDays).toBe(20);
      expect(b.skonto).toBeNull();
    }
  });

  it('neuer Kunde bekommt Gruppe „Standard“, neue Objekte landen darin; fremde Gruppe abgelehnt', async () => {
    const cid = randomUUID();
    await saveCustomer(
      sql,
      cid,
      {
        customer_no: '29990',
        name: 'Neukunde GmbH',
        name2: null,
        street: 'Weg 1',
        postal_code: '80331',
        city: 'München',
        vat_id: null,
        contact_name: null,
        contact_email: null,
        contact_phone: null,
        notes: null,
        status: 'interessent',
      },
      't',
    );
    const [g] =
      await sql`select name, bill_format, combine from app.invoice_groups where id = ${standardGroupId(cid)}`;
    expect(g).toEqual({ name: 'Standard', bill_format: 'zugferd', combine: false });
    const sid = randomUUID();
    await saveSite(
      sql,
      sid,
      {
        customer_id: cid,
        site_no: '2999001',
        name: 'Büro',
        street: null,
        postal_code: null,
        city: null,
        order_reference: null,
        contract_reference: null,
      },
      't',
    );
    const [s] = await sql`select invoice_group_id from app.sites where id = ${sid}`;
    expect(s!.invoice_group_id).toBe(standardGroupId(cid));
    await expect(setSiteInvoiceGroup(sql, sid, standardGroupId(DEMO.authority), 't')).rejects.toThrow(
      /nicht zu diesem Kunden/,
    );
    // Status „ehemalig“ = inaktiv
    await saveCustomer(
      sql,
      cid,
      {
        customer_no: '29990',
        name: 'Neukunde GmbH',
        name2: null,
        street: 'Weg 1',
        postal_code: '80331',
        city: 'München',
        vat_id: null,
        contact_name: null,
        contact_email: null,
        contact_phone: null,
        notes: null,
        status: 'ehemalig',
      },
      't',
    );
    const [cu] = await sql`select active, status from app.customers where id = ${cid}`;
    expect(cu).toEqual({ active: false, status: 'kunde' });
  });
});
