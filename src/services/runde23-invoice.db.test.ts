import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import type { Cents, Quantity } from '../domain/money/money.js';
import { generateXRechnungUbl } from '../einvoice/generate.js';
import { copyInvoice, getInvoice, loadDocument, saveDraft } from './invoices.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, kositAvailable, testDeps } from './testing.js';
import { type Deps, issueInvoice, resendInvoice, reviseInvoiceAddress, sendInvoice } from './workflow.js';

const available = (await kositAvailable()) && (await dbAvailable());

describe.skipIf(!available)('Runde 23: Einzelrechnung wie Fortytools', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const id = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const line = (description: string, qty: bigint, price: bigint, ps?: string) => ({
    description,
    quantity: qty as Quantity,
    unitCode: 'LS',
    unitPrice: price as Cents,
    vatRate: 1900,
    ...(ps ? { periodStart: ps, periodEnd: ps } : {}),
  });

  it('Entwurf mit eigener Anschrift, Kundenreferenz, Zeitraum je Position und Minus-Position', async () => {
    await expect(
      saveDraft(
        sql,
        randomUUID(),
        {
          customerId: DEMO.company,
          siteId: null,
          kind: 'invoice',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          orderReference: null,
          introText: null,
          closingText: null,
          lines: [line('Abzug', -1000n, 5000n)],
        },
        't',
      ),
    ).rejects.toThrow(/insgesamt positiv/);
    await saveDraft(
      sql,
      id,
      {
        customerId: DEMO.company,
        siteId: null,
        kind: 'invoice',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        orderReference: 'MW-4711',
        introText: null,
        closingText: null,
        lines: [
          line('Sonderreinigung Whg. 12', 1000n, 18000n, '2026-09-03'),
          line('Nachlass', -1000n, 2000n),
          line('Abzug Material', 1000n, -1000n), // negativer Einzelpreis (BR-27) → Vorzeichen in die Menge
        ],
        billAddress: {
          name: 'Münchner Test GmbH',
          name2: 'Abteilung Bestand',
          contactName: 'Frau Muster',
          street: 'Teststr. 1',
          postalCode: '80331',
          city: 'München',
        },
        customerReference: 'KST 815',
        paymentTermsDays: 14,
        noSkonto: true,
      },
      't',
    );
    const doc = await loadDocument(sql, id, { number: 'X', issueDate: '2026-10-01', dueDate: '2026-10-15' });
    expect(doc.buyer.name).toBe('Münchner Test GmbH');
    expect(doc.netTotal).toBe(15000n);
    const xml = await generateXRechnungUbl(doc);
    expect(xml).toContain('<cbc:StartDate>2026-09-03</cbc:StartDate>');
    expect(xml).toContain('Münchner Test GmbH');
    expect(xml).not.toMatch(/<cbc:PriceAmount[^>]*>-/);
  });

  it('Position außerhalb des Rechnungszeitraums: Zeitraum wird erweitert (PEPPOL-EN16931-R110)', async () => {
    const wid = randomUUID();
    await saveDraft(
      sql,
      wid,
      {
        customerId: DEMO.company,
        siteId: null,
        kind: 'invoice',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [line('Sonderreinigung', 1000n, 10000n, '2026-08-28')],
      },
      't',
    );
    await issueInvoice(deps, wid, 't');
    const { invoice } = (await getInvoice(sql, wid))!;
    expect(invoice.status).not.toBe('draft');
    expect(invoice.period_start).toBe('2026-08-28');
    expect(invoice.period_end).toBe('2026-09-30');
  });

  it('ausstellen: Zahlungsziel je Rechnung, kein Skonto; Kopie als Entwurf; Anschrift berichtigen', async () => {
    await issueInvoice(deps, id, 't');
    const { invoice } = (await getInvoice(sql, id))!;
    const days = (Date.parse(invoice.due_date!) - Date.parse(invoice.issue_date!)) / 86400000;
    expect(days).toBe(14);
    expect(invoice.skonto_percent_bp).toBeNull();
    expect(invoice.buyer_snapshot!.name2).toBe('Abteilung Bestand');

    const copy = await copyInvoice(sql, id, randomUUID(), 't');
    const c = (await getInvoice(sql, copy))!;
    expect(c.invoice.status).toBe('draft');
    expect(c.lines).toHaveLength(3);
    expect(c.invoice.customer_reference).toBe('KST 815');

    await sendInvoice(deps, id, 't');
    const rev = randomUUID();
    await reviseInvoiceAddress(
      deps,
      id,
      {
        name: 'Münchner Test GmbH',
        name2: 'Abteilung Neubau',
        contactName: null,
        street: 'Neuweg 2',
        postalCode: '80333',
        city: 'München',
      },
      'Anschrift laut Kunde',
      't',
      rev,
    );
    // zweimal absenden → nur eine Fassung
    await reviseInvoiceAddress(
      deps,
      id,
      { name: 'x', name2: null, contactName: null, street: 'y', postalCode: '80333', city: 'z' },
      'x',
      't',
      rev,
    );
    const revs = await sql<
      { revision: number }[]
    >`select revision from app.invoice_revisions where invoice_id = ${id}`;
    expect(revs).toHaveLength(1);
    const docs = await sql<{ revision: number; filename: string }[]>`
      select revision, filename from app.invoice_documents where invoice_id = ${id} order by revision, filename`;
    expect(docs.filter((d) => d.revision === 0)).toHaveLength(5);
    expect(docs.filter((d) => d.revision === 1).map((d) => d.filename)).toContain(
      `${invoice.number}_berichtigt-1.pdf`,
    );
    expect((await loadDocument(sql, id)).buyer.street).toBe('Neuweg 2');
    // Original unverändert
    expect((await getInvoice(sql, id))!.invoice.buyer_snapshot!.street).toBe('Teststr. 1');
    // berichtigte Fassung kann einmal gesendet werden
    await sendInvoice(deps, id, 't');
    expect(deps.mailer.sent.length).toBe(2);
    expect(deps.mailer.sent.at(-1)!.subject).toMatch(/Berichtigte Fassung/);
    // erneut an eine neue Adresse: genau einmal je Formular, Adresse optional in der Gruppe gespeichert
    await expect(
      resendInvoice(deps, id, 't', { resendId: randomUUID(), recipients: 'kein-at', saveToGroup: false }),
    ).rejects.toThrow(/ungültig/);
    const rid = randomUUID();
    const p = { resendId: rid, recipients: 'Neu@Kunde.de; zweite@kunde.de', saveToGroup: true };
    const r1 = await resendInvoice(deps, id, 't', p);
    const r2 = await resendInvoice(deps, id, 't', p);
    expect([r1.alreadySent, r2.alreadySent]).toEqual([false, true]);
    expect(deps.mailer.sent.length).toBe(3);
    expect(deps.mailer.sent.at(-1)!.subject).toMatch(/^\[TEST\] Erneute Zusendung/);
    expect(r1.delivery.intended_recipients).toEqual(['neu@kunde.de', 'zweite@kunde.de']);
    const [g] = await sql<{ e: string[] }[]>`
      select coalesce(g.bill_emails, c.invoice_emails) as e from app.invoices i
        join app.customers c on c.id = i.customer_id
        left join app.sites s on s.id = i.site_id
        left join app.invoice_groups g on g.id = coalesce(i.invoice_group_id, s.invoice_group_id)
       where i.id = ${id}`;
    expect(g!.e).toEqual(['neu@kunde.de', 'zweite@kunde.de']);
  });
});
