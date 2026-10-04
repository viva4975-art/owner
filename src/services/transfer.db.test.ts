import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  assignDebitRun,
  assignInvoices,
  assignReturn,
  importStatement,
  suggestions,
  getTransaction,
} from './bank.js';
import {
  createDebitRun,
  debitProposal,
  debitRunXml,
  earliestCollectionDate,
  saveMandate,
  validCreditorId,
} from './direct-debit.js';
import { assignInboxFile, INBOX_ID, inboxFiles, outbox } from './documents.js';
import { getInvoice, issue, runMonthly } from './invoices.js';
import { listPayments } from './payments.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { storeFile } from './uploads.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const OWN = 'DE39701900000003297837';

const camt = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>1</MsgId></GrpHdr>
<Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`;
const entry = (amount: string, ind: 'CRDT' | 'DBIT', date: string, purpose: string, extra = '') => `
<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${date}</Dt></BookgDt>
<NtryDtls><TxDtls>${extra}<RltdPties><Dbtr><Pty><Nm>Kunde</Nm></Pty></Dbtr></RltdPties><RmtInf><Ustrd>${purpose}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
const eur = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

describe.skipIf(!available)('Transfer: Kontoumsätze, Lastschrift, Dokumenteneingang', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let invA = '';
  let invB = '';
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    // Skonto 3 % / 7 Tage für die Behörde, dann zwei Monatsrechnungen ausstellen
    await sql`update app.customers set skonto_percent_bp = 300, skonto_days = 7 where id = ${DEMO.authority}`;
    const run = await runMonthly(sql, '2026-09', 't', { siteIds: [DEMO.siteSchool, DEMO.siteHq] });
    [invA, invB] = run.created.map((x) => x.invoiceId) as [string, string];
    await issue(sql, invA, 't', '2026-09-30');
    await issue(sql, invB, 't', '2026-09-30');
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Kontoauszug: fremdes Konto abgelehnt, doppelt einlesen legt nichts doppelt an', async () => {
    const a = (await getInvoice(sql, invA))!.invoice;
    const xml = camt(entry(eur(a.payable_cents), 'CRDT', '2026-10-01', `RE ${a.number}`));
    await expect(
      importStatement(deps, {
        id: randomUUID(),
        filename: 'x.xml',
        bytes: new TextEncoder().encode(xml.replace(OWN, 'DE02120300000000202051')),
        accountIban: null,
        actor: 't',
      }),
    ).rejects.toThrow(/nicht zu unseren Konten/);
    const r1 = await importStatement(deps, {
      id: randomUUID(),
      filename: 'a.xml',
      bytes: new TextEncoder().encode(xml),
      accountIban: null,
      actor: 't',
    });
    const r2 = await importStatement(deps, {
      id: randomUUID(),
      filename: 'a2.xml',
      bytes: new TextEncoder().encode(xml),
      accountIban: null,
      actor: 't',
    });
    expect([r1.created, r2.created]).toEqual([1, 0]);
  });

  it('Vorschlag „vollständig“ → Zahlung gebucht, zweites Zuordnen bucht nichts doppelt', async () => {
    const [t] = await sql<{ id: string }[]>`select id from app.bank_transactions`;
    const tx = (await getTransaction(sql, t!.id))!;
    const s = await suggestions(sql, tx);
    expect(s[0]).toMatchObject({ kind: 'invoices', confidence: 'sicher' });
    if (s[0]!.kind !== 'invoices') throw new Error();
    const items = s[0]!.items.map((i) => ({ invoiceId: i.invoice_id, amount: i.amount, skonto: i.skonto }));
    await assignInvoices(sql, tx.id, items, 't');
    await assignInvoices(sql, tx.id, items, 't');
    const pays = await listPayments(sql, invA);
    expect(pays).toHaveLength(1);
    expect((await sql`select open_cents from app.open_items where invoice_id = ${invA}`)[0]!.open_cents).toBe(
      0n,
    );
    await expect(sql`update app.bank_transactions set status = 'offen' where id = ${tx.id}`).rejects.toThrow(
      /abgeschlossen/,
    );
    await expect(sql`delete from app.bank_transactions where id = ${tx.id}`).rejects.toThrow(
      /nicht gelöscht/,
    );
  });

  it('Teilzahlung ohne Skontoberechtigung: Vorschlag „prüfen“, Skonto abgelehnt', async () => {
    const b = (await getInvoice(sql, invB))!.invoice;
    // Rechnung B: Firma ohne Skonto-Vereinbarung
    const part = b.payable_cents - 1000n;
    const xml = camt(entry(eur(part), 'CRDT', '2026-10-02', `Rechnung ${b.number}`));
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'b.xml',
      bytes: new TextEncoder().encode(xml),
      accountIban: null,
      actor: 't',
    });
    const [t] = await sql<{ id: string }[]>`select id from app.bank_transactions where status = 'offen'`;
    const tx = (await getTransaction(sql, t!.id))!;
    const s = await suggestions(sql, tx);
    expect(s[0]).toMatchObject({ kind: 'invoices', confidence: 'prüfen' });
    await expect(
      assignInvoices(sql, tx.id, [{ invoiceId: invB, amount: part, skonto: 1000n }], 't'),
    ).rejects.toThrow(/Skonto nicht zulässig/);
    await expect(
      assignInvoices(sql, tx.id, [{ invoiceId: invB, amount: part - 1n, skonto: 0n }], 't'),
    ).rejects.toThrow(/Summe/);
    await assignInvoices(sql, tx.id, [{ invoiceId: invB, amount: part, skonto: 0n }], 't');
    expect((await sql`select open_cents from app.open_items where invoice_id = ${invB}`)[0]!.open_cents).toBe(
      1000n,
    );
  });

  it('Lastschrift: Mandat, Einzug (pain.008), Sammelgutschrift, Rücklastschrift', async () => {
    expect(validCreditorId('DE98ZZZ09999999999')).toBe(true);
    expect(validCreditorId('DE99ZZZ09999999999')).toBe(false);
    // neue Rechnung für die Firma (Oktober), Mandat anlegen
    const run = await runMonthly(sql, '2026-10', 't', { siteIds: [DEMO.siteHq] });
    const inv = run.created[0]!.invoiceId;
    await issue(sql, inv, 't', '2026-10-02');
    const mandate = randomUUID();
    await expect(
      saveMandate(
        sql,
        mandate,
        {
          customerId: DEMO.company,
          mandateRef: 'M-29902-1',
          signedOn: '2026-09-01',
          accountHolder: 'Musterfirma GmbH',
          iban: 'DE02120300000000202052',
          bic: null,
          scheme: 'CORE',
          active: true,
          note: null,
          expectedVersion: null,
        },
        't',
      ),
    ).rejects.toThrow(/IBAN/);
    await saveMandate(
      sql,
      mandate,
      {
        customerId: DEMO.company,
        mandateRef: 'M-29902-1',
        signedOn: '2026-09-01',
        accountHolder: 'Musterfirma GmbH',
        iban: 'DE02120300000000202051',
        bic: null,
        scheme: 'CORE',
        active: true,
        note: null,
        expectedVersion: null,
      },
      't',
    );
    const prop = await debitProposal(sql);
    expect(prop.map((p) => p.invoice_id).sort()).toEqual([invB, inv].sort());
    const id = randomUUID();
    const earliest = earliestCollectionDate();
    const due = (await getInvoice(sql, inv))!.invoice.due_date!;
    const date = due > earliest ? due : earliest;
    await expect(
      createDebitRun(deps, { id, invoiceIds: [inv], collectionDate: date, creditorIban: OWN, actor: 't' }),
    ).rejects.toThrow(/Gläubiger/);
    await sql`update app.company set creditor_id = 'DE98ZZZ09999999999'`;
    if (earliest < due) {
      await expect(
        createDebitRun(deps, {
          id: randomUUID(),
          invoiceIds: [inv],
          collectionDate: earliest,
          creditorIban: OWN,
          actor: 't',
        }),
      ).rejects.toThrow(/vor Fälligkeit/);
    }
    await createDebitRun(deps, {
      id,
      invoiceIds: [inv],
      collectionDate: date,
      creditorIban: OWN,
      actor: 't',
    });
    await createDebitRun(deps, {
      id,
      invoiceIds: [inv],
      collectionDate: date,
      creditorIban: OWN,
      actor: 't',
    });
    await expect(
      createDebitRun(deps, {
        id: randomUUID(),
        invoiceIds: [inv],
        collectionDate: date,
        creditorIban: OWN,
        actor: 't',
      }),
    ).rejects.toThrow(/nicht \(mehr\) einziehbar/);
    const xml = await debitRunXml(sql, id);
    expect(xml).toContain('<SeqTp>FRST</SeqTp>');
    expect(xml).toContain('<MndtId>M-29902-1</MndtId>');
    expect(xml).toContain('<Id>DE98ZZZ09999999999</Id>');
    const [{ total_cents, e2e }] = (await sql`
      select r.total_cents, d.end_to_end_id as e2e from app.direct_debit_runs r join app.direct_debit_items d on d.run_id = r.id where r.id = ${id}`) as unknown as [
      { total_cents: bigint; e2e: string },
    ];
    // Sammelgutschrift im Auszug → Vorschlag Einzug
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'c.xml',
      bytes: new TextEncoder().encode(camt(entry(eur(total_cents), 'CRDT', date, 'SEPA Sammler'))),
      accountIban: null,
      actor: 't',
    });
    const [t] = await sql<
      { id: string }[]
    >`select id from app.bank_transactions where status = 'offen' and amount_cents = ${total_cents}`;
    const s = await suggestions(sql, (await getTransaction(sql, t!.id))!);
    expect(s.some((x) => x.kind === 'debit_run')).toBe(true);
    await assignDebitRun(sql, t!.id, id, 't');
    expect((await sql`select open_cents from app.open_items where invoice_id = ${inv}`)[0]!.open_cents).toBe(
      0n,
    );
    // Rücklastschrift mit Gebühr 3 €
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'd.xml',
      bytes: new TextEncoder().encode(
        camt(
          entry(
            eur(total_cents + 300n),
            'DBIT',
            date,
            'RUECKLASTSCHRIFT MD06',
            `<Refs><EndToEndId>${e2e}</EndToEndId></Refs>`,
          ),
        ),
      ),
      accountIban: null,
      actor: 't',
    });
    const [r] = await sql<
      { id: string }[]
    >`select id from app.bank_transactions where status = 'offen' and amount_cents < 0`;
    const rs = await suggestions(sql, (await getTransaction(sql, r!.id))!);
    const ret = rs.find((x) => x.kind === 'return');
    expect(ret).toBeDefined();
    await assignReturn(sql, r!.id, id, inv, 't');
    expect((await sql`select open_cents from app.open_items where invoice_id = ${inv}`)[0]!.open_cents).toBe(
      total_cents,
    );
    expect((await getTransaction(sql, r!.id))!.note).toContain('Bankgebühr 3,00');
    // nach Rücklastschrift wieder einziehbar
    expect((await debitProposal(sql)).some((p) => p.invoice_id === inv)).toBe(true);
  });

  it('Skonto: Zahlbetrag nach Skonto innerhalb der Frist → Zahlung + Skonto-Abzug', async () => {
    const run = await runMonthly(sql, '2026-10', 't', { siteIds: [DEMO.siteSchool] });
    const inv = run.created[0]!.invoiceId;
    await issue(sql, inv, 't', '2026-10-01');
    const i = (await getInvoice(sql, inv))!.invoice;
    const sk = (i.payable_cents * 300n + 5000n) / 10000n;
    const xml = camt(entry(eur(i.payable_cents - sk), 'CRDT', '2026-10-03', `Re.-Nr.${i.number}`));
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'e.xml',
      bytes: new TextEncoder().encode(xml),
      accountIban: null,
      actor: 't',
    });
    const [t] = await sql<
      { id: string }[]
    >`select id from app.bank_transactions where status = 'offen' and amount_cents = ${i.payable_cents - sk}`;
    const s = await suggestions(sql, (await getTransaction(sql, t!.id))!);
    expect(s[0]).toMatchObject({ kind: 'invoices', confidence: 'sicher' });
    if (s[0]!.kind !== 'invoices') throw new Error();
    expect(s[0]!.items[0]!.skonto).toBe(sk);
    await assignInvoices(sql, t!.id, [{ invoiceId: inv, amount: i.payable_cents - sk, skonto: sk }], 't');
    const pays = await listPayments(sql, inv);
    expect(pays.map((p) => p.method).sort()).toEqual(['skonto', 'ueberweisung']);
    expect((await sql`select open_cents from app.open_items where invoice_id = ${inv}`)[0]!.open_cents).toBe(
      0n,
    );
  });

  it('Dokumenteneingang: zuordnen hängt die Datei um, Versandprotokoll listet', async () => {
    const f = await storeFile(
      sql,
      { dir: deps.env.FILES_DIR, maxBytes: 1e9 },
      {
        id: randomUUID(),
        name: 'Brief.pdf',
        type: 'application/pdf',
        data: new TextEncoder().encode('%PDF-1.4 test'),
        link: { type: 'inbox', id: INBOX_ID },
        category: 'Eingang',
      },
      't',
    );
    expect((await inboxFiles(sql)).map((x) => x.id)).toEqual([f.id]);
    await assignInboxFile(sql, f.id, { type: 'customer', id: DEMO.company, category: 'Schriftverkehr' }, 't');
    await assignInboxFile(sql, f.id, { type: 'customer', id: DEMO.company, category: 'Schriftverkehr' }, 't');
    expect(await inboxFiles(sql)).toHaveLength(0);
    const [l] =
      await sql`select category from app.file_links where file_id = ${f.id} and entity_type = 'customer'`;
    expect(l!.category).toBe('Schriftverkehr');
    expect(await outbox(sql, { from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
  });
});
