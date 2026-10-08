import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { skontoTerms } from '../domain/invoice/calc.js';
import { BUYER, SELLER, sampleDocument } from '../einvoice/fixtures.js';
import { generateCii, generateXRechnungUbl, generateZugferd } from '../einvoice/generate.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { loadEInvoice, pendingEInvoices, takeOverEInvoice, uploadEInvoice } from './einvoice-inbox.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode(s);

/** Rechnung eines Lieferanten an uns (Verkäufer = Lieferant, Käufer = Viva-Deluxe). */
const supplierDoc = (no: string, vatId = 'DE811111111') => {
  const base = sampleDocument();
  return {
    ...base,
    number: no,
    seller: {
      ...SELLER,
      legalName: 'Glas & Fassade Huber GmbH',
      vatId,
      taxNumber: '143/111/11111',
      street: 'Industriestr. 3',
      postalCode: '85221',
      city: 'Dachau',
      email: 'rechnung@huber.example',
      bankAccounts: [
        { name: 'Sparkasse', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', primary: true },
      ],
    },
    buyer: { ...BUYER, name: SELLER.legalName, vatId: SELLER.vatId, leitwegId: null },
    buyerReference: 'Viva-Deluxe',
  };
};

describe.skipIf(!available)('E-Rechnung im Rechnungseingang (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const cfg = () => ({ dir, maxBytes: 50_000_000 });
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'ein-'));
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('XRechnung: Lieferant aus den Daten anlegen, doppelt absenden legt nichts doppelt an', async () => {
    const d = supplierDoc('RE-4711');
    const f = await uploadEInvoice(
      sql,
      cfg(),
      { id: randomUUID(), name: 'RE-4711.xml', bytes: enc(await generateXRechnungUbl(d)) },
      'test',
    );
    expect((await pendingEInvoices(sql)).map((x) => x.id)).toContain(f.id);
    const v = await loadEInvoice(sql, cfg(), f.id);
    expect(v.match).toBeNull();
    expect(v.warnings).toEqual([]);
    const input = {
      supplierId: 'neu',
      category: 'material' as const,
      siteId: null,
      serviceMonth: null,
      note: null,
    };
    const id = await takeOverEInvoice(sql, cfg(), f.id, input, 'test');
    expect(await takeOverEInvoice(sql, cfg(), f.id, input, 'test')).toBe(id);
    const [inv] =
      await sql`select i.*, s.name, s.vat_id, s.iban, s.payment_terms_days from app.incoming_invoices i
                              join app.suppliers s on s.id = i.supplier_id where i.id = ${id}`;
    expect(inv!.invoice_no).toBe('RE-4711');
    expect(inv!.gross_cents).toBe(d.grossTotal);
    expect(inv!.due_date).toBe('2026-10-31');
    expect(inv!.service_month).toBe('2026-09-01');
    expect(inv!.name).toBe('Glas & Fassade Huber GmbH');
    expect(inv!.vat_id).toBe('DE811111111');
    expect(inv!.iban).toBe('DE89370400440532013000');
    expect(inv!.payment_terms_days).toBe(30);
    expect(inv!.einvoice.lines).toHaveLength(3);
    expect((await pendingEInvoices(sql)).map((x) => x.id)).not.toContain(f.id);
    const [link] = await sql`select entity_type from app.file_links where file_id = ${f.id}`;
    expect(link!.entity_type).toBe('incoming_invoice');
    expect(await sql`select count(*)::int as n from app.suppliers where vat_id = 'DE811111111'`).toEqual([
      { n: 1 },
    ]);
  });

  it('ZUGFeRD: Lieferant über USt-IdNr. erkannt, Skonto übernommen; gleiche Nummer = Dublette', async () => {
    const base = supplierDoc('RE-4712');
    const d = { ...base, skonto: skontoTerms(base.payableTotal, 200, 10, base.issueDate) };
    const pdf = await generateZugferd(d, await renderInvoicePdf(d), 'RE-4712.pdf');
    const f = await uploadEInvoice(sql, cfg(), { id: randomUUID(), name: 'RE-4712.pdf', bytes: pdf }, 'test');
    const v = await loadEInvoice(sql, cfg(), f.id);
    expect(v.match?.by).toBe('USt-IdNr.');
    const id = await takeOverEInvoice(
      sql,
      cfg(),
      f.id,
      { supplierId: v.match!.id, category: 'sonstiges', siteId: null, serviceMonth: '2026-08', note: 'Test' },
      'test',
    );
    const [inv] = await sql`select * from app.incoming_invoices where id = ${id}`;
    expect(inv!.skonto_percent_bp).toBe(200);
    expect(inv!.skonto_until).toBe('2026-10-11');
    expect(inv!.service_month).toBe('2026-08-01');
    // dieselbe Rechnung noch einmal als CII-XML → Dublette erkannt, Übernahme abgelehnt
    const again = await uploadEInvoice(
      sql,
      cfg(),
      { id: randomUUID(), name: 'x.xml', bytes: enc(await generateCii(base)) },
      'test',
    );
    const v2 = await loadEInvoice(sql, cfg(), again.id);
    expect(v2.duplicateId).toBe(id);
    await expect(
      takeOverEInvoice(
        sql,
        cfg(),
        again.id,
        { supplierId: v.match!.id, category: 'material', siteId: null, serviceMonth: null, note: null },
        'test',
      ),
    ).rejects.toThrow(/schon erfasst/);
  });

  it('Eigene Ausgangsrechnung und Nicht-E-Rechnung werden abgelehnt', async () => {
    const own = await uploadEInvoice(
      sql,
      cfg(),
      { id: randomUUID(), name: 'eigen.xml', bytes: enc(await generateXRechnungUbl(sampleDocument())) },
      'test',
    );
    const v = await loadEInvoice(sql, cfg(), own.id);
    expect(v.warnings[0]).toMatch(/von uns selbst/);
    await expect(
      takeOverEInvoice(
        sql,
        cfg(),
        own.id,
        { supplierId: 'neu', category: 'material', siteId: null, serviceMonth: null, note: null },
        'test',
      ),
    ).rejects.toThrow(/eigene Ausgangsrechnung/);
    await expect(
      uploadEInvoice(
        sql,
        cfg(),
        { id: randomUUID(), name: 'brief.pdf', bytes: await renderInvoicePdf(sampleDocument()) },
        'test',
      ),
    ).rejects.toThrow(/keine eingebettete E-Rechnung/);
  });
});

describe.skipIf(!available)('E-Rechnung: geänderte Bankverbindung (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'ein-'));
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('USt-IdNr. passt, IBAN anders → Warnung', async () => {
    await sql`insert into app.suppliers (id, supplier_no, name, vat_id, iban)
              values (${randomUUID()}, '79990', 'Glas & Fassade Huber GmbH', 'DE 811 111 111', 'DE02120300000000202051')`;
    const f = await uploadEInvoice(
      sql,
      { dir, maxBytes: 5e7 },
      { id: randomUUID(), name: 'a.xml', bytes: enc(await generateCii(supplierDoc('X-1'))) },
      'test',
    );
    const v = await loadEInvoice(sql, { dir, maxBytes: 5e7 }, f.id);
    expect(v.match?.by).toBe('USt-IdNr.');
    expect(v.warnings.join()).toMatch(/Bankverbindung .* weicht .* ab/);
  });
});
