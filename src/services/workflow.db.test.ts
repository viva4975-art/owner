import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { createCancellation, getInvoice, runMonthly } from './invoices.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, kositAvailable, testDeps } from './testing.js';
import {
  type Deps,
  addAttachment,
  ensureDocuments,
  issueInvoice,
  listDeliveries,
  sendInvoice,
} from './workflow.js';

const available = (await kositAvailable()) && (await dbAvailable());

describe.skipIf(!available)('Ablauf: Monatslauf → Ausstellen → Archiv → Versand → Storno', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let invoiceId: string;

  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    const run = await runMonthly(sql, '2026-09', 'test');
    invoiceId = run.created.find((c) => c.siteName === 'Grundschule Musterweg')!.invoiceId;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('stellt aus und archiviert PDF, XRechnung, ZUGFeRD und Prüfberichte', async () => {
    const docs = await issueInvoice(deps, invoiceId, 'test');
    const kinds = docs.map((d) => d.kind).sort();
    expect(kinds).toEqual(['pdf', 'validation_report', 'validation_report', 'xrechnung_xml', 'zugferd_pdf']);
    expect(docs.find((d) => d.kind === 'xrechnung_xml')!.valid).toBe(true);
    expect(docs.find((d) => d.kind === 'zugferd_pdf')!.valid).toBe(true);
    for (const d of docs) {
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await deps.archive.get(d.storage_path)).byteLength).toBe(Number(d.size_bytes));
    }
    // Aufbewahrung: 10 Jahre ab Ende des Ausstellungsjahres
    const year = Number((await getInvoice(sql, invoiceId))!.invoice.issue_date!.slice(0, 4));
    expect(docs[0]!.retain_until).toBe(`${year + 10}-12-31`);
  });

  it('Belege werden nicht doppelt erzeugt', async () => {
    const before = await ensureDocuments(deps, invoiceId);
    const after = await ensureDocuments(deps, invoiceId);
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
  });

  it('Archivdatei kann nicht überschrieben werden', async () => {
    const [doc] = await ensureDocuments(deps, invoiceId);
    await expect(deps.archive.put(doc!.storage_path, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /Überschreiben nicht erlaubt/,
    );
  });

  it('versendet mit Anhang genau einmal – nur an die Testadresse', async () => {
    await addAttachment(
      deps,
      invoiceId,
      'Leistungsnachweis September.pdf',
      'application/pdf',
      new TextEncoder().encode('%PDF-1.4 test'),
      'test',
    );
    const results = await Promise.allSettled([
      sendInvoice(deps, invoiceId, 'test'),
      sendInvoice(deps, invoiceId, 'test'),
      sendInvoice(deps, invoiceId, 'test'),
    ]);
    expect(deps.mailer.sent).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);

    const mail = deps.mailer.sent[0]!;
    expect(mail.to).toEqual(['test@viva-deluxe.local']);
    expect(mail.subject).toMatch(/^\[TEST\] Rechnung RE-\d{4}-\d{5}/);
    expect(mail.text).toContain('rechnungseingang@beispielbehoerde.example');
    // Kunde hat Format XRechnung → XML + PDF-Sichtkopie + Anhang
    expect(mail.attachments.map((a) => a.filename.replace(/^[0-9a-f]{12}_/, ''))).toEqual([
      expect.stringMatching(/_xrechnung\.xml$/),
      expect.stringMatching(/^RE-\d{4}-\d{5}\.pdf$/),
      expect.stringMatching(/Leistungsnachweis September\.pdf$/),
    ]);

    const again = await sendInvoice(deps, invoiceId, 'test');
    expect(again.alreadySent).toBe(true);
    expect(deps.mailer.sent).toHaveLength(1);

    const [log] = await listDeliveries(sql, invoiceId);
    expect(log!.status).toBe('sent');
    expect(log!.intended_recipients).toEqual(['rechnungseingang@beispielbehoerde.example']);
    expect(log!.actual_recipients).toEqual(['test@viva-deluxe.local']);
    expect(log!.files).toHaveLength(3);
    await expect(
      sql`update app.invoice_deliveries set status = 'pending' where id = ${log!.id}`,
    ).rejects.toThrow(/unveränderbar/);
  });

  it('Versandfehler: Status "failed", Wiederholung nur ausdrücklich', async () => {
    const run = await runMonthly(sql, '2026-07', 'test');
    const id = run.created.find((c) => c.siteName === 'Firmenzentrale Planegg')!.invoiceId;
    await issueInvoice(deps, id, 'test');
    deps.mailer.failNext = true;
    await expect(sendInvoice(deps, id, 'test')).rejects.toThrow(/Versand fehlgeschlagen/);
    await expect(sendInvoice(deps, id, 'test')).rejects.toThrow(/Erneut versenden/);
    const ok = await sendInvoice(deps, id, 'test', { retryFailed: true });
    expect(ok.delivery.status).toBe('sent');
    expect(ok.delivery.attempts).toBe(2);
    // ZUGFeRD-Kunde → eine PDF mit eingebettetem XML
    expect(deps.mailer.sent.at(-1)!.attachments.map((a) => a.filename)).toEqual([
      expect.stringMatching(/_zugferd\.pdf$/),
    ]);
  });

  it('Storno wird ebenfalls geprüft, archiviert und versendet', async () => {
    const stornoId = await createCancellation(sql, invoiceId, 'test');
    const docs = await issueInvoice(deps, stornoId, 'test');
    expect(docs.find((d) => d.kind === 'xrechnung_xml')!.valid).toBe(true);
    const xml = new TextDecoder().decode(
      await deps.archive.get(docs.find((d) => d.kind === 'xrechnung_xml')!.storage_path),
    );
    expect(xml).toContain('<cbc:InvoiceTypeCode>384</cbc:InvoiceTypeCode>');
    const orig = (await getInvoice(sql, invoiceId))!.invoice;
    expect(xml).toContain(`<cbc:ID>${orig.number}</cbc:ID>`);
    await sendInvoice(deps, stornoId, 'test');
    expect(deps.mailer.sent.at(-1)!.subject).toMatch(/Stornorechnung/);
  });

  it('ungültige E-Rechnung wird nicht ausgestellt (keine Nummer verbraucht)', async () => {
    // Steuersatz 0 % ist ohne Befreiungsgrund nicht abbildbar → Vorabprüfung schlägt fehl.
    const [row] = await sql<{ id: string }[]>`
      insert into app.invoices (customer_id, site_id, invoice_format) values (${DEMO.authority}, ${DEMO.siteSchool}, 'xrechnung') returning id`;
    const id = row!.id;
    await sql`insert into app.invoice_lines (invoice_id, position, description, quantity_milli, unit_price_cents, net_cents, vat_rate_bp)
              values (${id}, 1, 'Test', 1000, 1000, 1000, 0)`;
    await sql`update app.invoices set net_cents = 1000, gross_cents = 1000, payable_cents = 1000 where id = ${id}`;
    const [before] = await sql`select coalesce(max(last_value), 0) as v from app.invoice_number_counters`;
    await expect(issueInvoice(deps, id, 'test')).rejects.toThrow(/nicht erzeugt werden|ungültig/);
    const [after] = await sql`select coalesce(max(last_value), 0) as v from app.invoice_number_counters`;
    expect(after!.v).toBe(before!.v);
    expect((await getInvoice(sql, id))!.invoice.status).toBe('draft');
  });
});
