import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { getInvoice, loadDocument, runMonthly } from './invoices.js';
import { buildMailBundle } from './mail-bundle.js';
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

async function onePagePdf() {
  const d = await PDFDocument.create();
  d.addPage([595, 842]);
  return d.save();
}

describe.skipIf(!available)('Eine Datei je E-Mail (Deutsche Bahn)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let invoiceId: string;

  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    const run = await runMonthly(sql, '2026-09', 'test');
    invoiceId = run.created[0]!.invoiceId;
    await issueInvoice(deps, invoiceId, 'test');
    await addAttachment(deps, invoiceId, 'Arbeitsschein.pdf', 'application/pdf', await onePagePdf(), 'test');
    await addAttachment(
      deps,
      invoiceId,
      'Stundennachweis.pdf',
      'application/pdf',
      await onePagePdf(),
      'test',
    );
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('Rechnungsgruppe mit „eine Datei“: genau ein Anhang, ohne eingebettete Bilder', async () => {
    const [inv] = await sql<
      { customer_id: string }[]
    >`select customer_id from app.invoices where id = ${invoiceId}`;
    await sql`insert into app.invoice_groups (id, customer_id, name, bill_format, bill_emails, single_file)
              values (gen_random_uuid(), ${inv!.customer_id}, 'Standard', 'zugferd', '{rechnung@kunde.example}', true)`;
    await sendInvoice(deps, invoiceId, 'test');
    const mail = deps.mailer.sent.at(-1)!;
    expect(mail.attachments).toHaveLength(1);
    expect(mail.inline ?? []).toHaveLength(0);
    expect(mail.html).toBeUndefined();
    const [d] = await listDeliveries(sql, invoiceId);
    const files = d!.files as unknown as { filename: string; enthaelt: string[] }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.enthaelt).toEqual(expect.arrayContaining(['Arbeitsschein.pdf', 'Stundennachweis.pdf']));
    const fmt = (await getInvoice(sql, invoiceId))!.invoice.invoice_format;
    if (fmt !== 'xrechnung') {
      const pdf = await PDFDocument.load(mail.attachments[0]!.content, { ignoreEncryption: true });
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3); // Rechnung + 2 Anlagen
    }
  });

  it('XRechnung mit eingebetteter PDF und Anlagen besteht KoSIT; PDF und ZUGFeRD enthalten alle Seiten', async () => {
    const docs = await ensureDocuments(deps, invoiceId);
    const doc = await loadDocument(sql, invoiceId);
    const pdf = docs.find((x) => x.kind === 'pdf')!;
    const atts = docs.filter((x) => x.kind === 'attachment');
    const common = {
      doc,
      pdf,
      attachments: atts,
      baseName: doc.number,
      archiveBase: `test/${doc.number}`,
      get: (p: string) => deps.archive.get(p),
      put: (p: string, b: Uint8Array) => deps.archive.put(p, b),
      kositUrl: deps.env.KOSIT_VALIDATOR_URL,
    };
    const xr = await buildMailBundle({
      ...common,
      format: 'xrechnung',
      main: docs.filter((x) => x.kind === 'xrechnung_xml'),
    });
    const xml = Buffer.from(xr.content).toString('utf8');
    expect(xr.filename).toMatch(/_xrechnung\.xml$/);
    expect((xml.match(/EmbeddedDocumentBinaryObject /g) ?? []).length).toBe(3);

    const zf = await buildMailBundle({
      ...common,
      format: 'zugferd',
      main: docs.filter((x) => x.kind === 'zugferd_pdf'),
    });
    const zpdf = await PDFDocument.load(zf.content, { ignoreEncryption: true });
    const pdfPages = (await PDFDocument.load(await deps.archive.get(pdf.storage_path))).getPageCount();
    expect(zpdf.getPageCount()).toBe(pdfPages + 2);

    const pl = await buildMailBundle({ ...common, format: 'pdf', main: [pdf] });
    expect((await PDFDocument.load(pl.content)).getPageCount()).toBe(pdfPages + 2);
  });

  it('nicht einbettbare Anlage → klare Meldung, kein Versand', async () => {
    const docs = await ensureDocuments(deps, invoiceId);
    const doc = await loadDocument(sql, invoiceId);
    const pdf = docs.find((x) => x.kind === 'pdf')!;
    await expect(
      buildMailBundle({
        doc,
        format: 'pdf',
        main: [pdf],
        pdf,
        attachments: [{ ...pdf, filename: 'liste.docx', content_type: 'application/msword' }],
        baseName: doc.number,
        archiveBase: `test/${doc.number}`,
        get: (p) => deps.archive.get(p),
        put: (p, b) => deps.archive.put(p, b),
        kositUrl: deps.env.KOSIT_VALIDATOR_URL,
      }),
    ).rejects.toThrow(/nur PDF, JPG oder PNG/);
  });
});

describe('Deutsche Bahn erkennen', async () => {
  const { needsSingleFile } = await import('./workflow.js');
  it('e-invoicing@deutschebahn.com → eine Datei', () => {
    expect(needsSingleFile(['e-invoicing@deutschebahn.com'])).toBe(true);
    expect(needsSingleFile(['rechnung@kunde.de'])).toBe(false);
  });
});
