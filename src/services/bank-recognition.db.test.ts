import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import {
  assignIncoming,
  assignInvoices,
  assignParty,
  type BankTx,
  ignoreTransaction,
  importStatement,
  listTransactions,
  quickSupplier,
  subsetSum,
  suggestions,
} from './bank.js';
import { expenseStats, guessCategory } from './expense-stats.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const OWN = 'DE39701900000003297837';
const SUP_IBAN = 'DE02120300000000202051';
const today = todayBerlin();
const d = (n: number) => addDays(today, n);

const eur = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
const entry = (cents: bigint, ind: 'CRDT' | 'DBIT', name: string, ibanNo: string | null, purpose: string) => {
  const role = ind === 'CRDT' ? 'Dbtr' : 'Cdtr';
  return `<Ntry><Amt Ccy="EUR">${eur(cents)}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>${today}</Dt></BookgDt><NtryDtls><TxDtls><RltdPties><${role}><Pty><Nm>${name}</Nm></Pty></${role}>
${ibanNo ? `<${role}Acct><Id><IBAN>${ibanNo}</IBAN></Id></${role}Acct>` : ''}</RltdPties>
<RmtInf><Ustrd>${purpose}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
};
const camt = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>${randomUUID()}</MsgId></GrpHdr>
<Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`;

describe('Kostenart automatisch erkennen', () => {
  it('Name/Verwendungszweck → Kostenart', () => {
    expect(guessCategory('DEVK Versicherungen', 'Beitrag 10/2026')).toBe('versicherung');
    expect(guessCategory('ARAL Station 1234', null)).toBe('fahrzeuge');
    expect(guessCategory('Finanzamt München', 'USt-VA 09/2026')).toBe('steuern');
    expect(guessCategory('HORNBACH MUENCHEN-FREIHAM', 'HORNBACH BAUMARKT')).toBe('material');
    expect(guessCategory('Münchner Bank', 'Entgelt Kontoführung')).toBe('bank');
    expect(guessCategory('Max Muster', 'Lohn 09/2026')).toBe('personal');
    expect(guessCategory('Irgendwer GmbH', 'Rechnung 123')).toBeNull();
    // „TK“ nur als eigenes Wort
    expect(guessCategory('Kontakt Service', null)).toBeNull();
  });
});

describe('Teilmengen-Summe (Verrechnung)', () => {
  it('findet die kleinste Auswahl, auch mit Minusbeträgen', () => {
    const r = subsetSum([100n, 250n, -50n, 400n], (x) => x, 300n);
    expect(r?.sort()).toEqual([-50n, 100n, 250n].sort());
    expect(subsetSum([100n, 200n], (x) => x, 150n)).toBeNull();
  });
});

describe.skipIf(!available)('Kontoumsätze: alles erkennen', () => {
  let sql: Sql;
  let deps: Deps;
  const sup = randomUUID();
  const inc = (
    no: string,
    gross: bigint,
    status = 'freigegeben',
    extra: { until?: string; bp?: number } = {},
  ) => {
    const net = (gross * 100n) / 119n;
    const id = randomUUID();
    return sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                 gross_cents, category, status, skonto_until, skonto_percent_bp, created_by)
               values (${id}, ${sup}, ${no}, ${d(-10)}, ${d(20)}, ${net}, ${gross - net}, ${gross}, 'material', ${status},
                       ${extra.until ?? null}, ${extra.bp ?? null}, 't')`.then(() => id);
  };
  const load = async (entries: string) => {
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'x.xml',
      bytes: new TextEncoder().encode(camt(entries)),
      accountIban: null,
      actor: 't',
    });
    return listTransactions(sql, { status: 'offen' });
  };
  const find = (list: BankTx[], purpose: string) => list.find((t) => t.purpose.includes(purpose))!;

  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.suppliers (id, supplier_no, name, iban) values (${sup}, '79100', 'Reinigungsbedarf Huber GmbH', ${SUP_IBAN})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Eingangsrechnung: Nummer anders geschrieben, nicht freigegeben, Skonto 3 % als Differenz → sicher', async () => {
    const id = await inc('RE-2026/0815', 100000n, 'erfasst');
    const list = await load(entry(97000n, 'DBIT', 'Huber', null, 'Rechnung RE 2026 0815 abzgl. Skonto'));
    const t = find(list, '0815');
    const [s] = await suggestions(sql, t);
    expect(s).toMatchObject({ kind: 'incoming', confidence: 'sicher' });
    if (s!.kind !== 'incoming') throw new Error();
    expect(s!.items[0]).toMatchObject({ id, amount: 97000n, skonto: 3000n });
    expect(s!.label).toContain('3,00 %');
    await assignIncoming(
      sql,
      t.id,
      s!.items.map((i) => ({ id: i.id, skonto: i.skonto })),
      't',
    );
    const [r] =
      await sql`select status, paid_amount_cents, paid_skonto_cents, approved_by from app.incoming_invoices where id = ${id}`;
    expect(r).toMatchObject({
      status: 'bezahlt',
      paid_amount_cents: 97000n,
      paid_skonto_cents: 3000n,
      approved_by: 't',
    });
  });

  it('Verrechnung: zwei Rechnungen abzüglich Korrektur, erkannt über IBAN', async () => {
    const a = await inc('H-101', 50000n);
    const b = await inc('H-102', 30000n);
    const k = await inc('H-K7', -11900n);
    await inc('H-103', 77700n);
    const list = await load(
      entry(68100n, 'DBIT', 'Reinigungsbedarf Huber', SUP_IBAN, 'Sammelzahlung Oktober'),
    );
    const t = find(list, 'Sammelzahlung');
    const [s] = await suggestions(sql, t);
    expect(s?.kind).toBe('incoming');
    if (s!.kind !== 'incoming') throw new Error();
    expect(s!.items.map((i) => i.id).sort()).toEqual([a, b, k].sort());
    expect(s!.label).toContain('abzgl. Korrektur H-K7');
    await assignIncoming(
      sql,
      t.id,
      s!.items.map((i) => ({ id: i.id })),
      't',
    );
    const rows = await sql<{ invoice_no: string; paid_amount_cents: bigint; paid_method: string }[]>`
      select invoice_no, paid_amount_cents, paid_method from app.incoming_invoices where bank_transaction_id = ${t.id} order by invoice_no`;
    expect(rows.map((r) => [r.invoice_no, r.paid_amount_cents])).toEqual([
      ['H-101', 50000n],
      ['H-102', 30000n],
      ['H-K7', -11900n],
    ]);
    expect(rows.find((r) => r.invoice_no === 'H-K7')!.paid_method).toBe('verrechnung');
  });

  it('Kunde: Skonto-Abzug ohne Vereinbarung erkannt (2 %), Zahlung + Skonto gebucht, IBAN gelernt', async () => {
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '20555', 'Hausverwaltung Test', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, customer_no, net_cents, gross_cents, paid)
              values (${randomUUID()}, '1038999', ${d(-20)}, ${d(-6)}, ${cust}, '20555', 100000, 119000, false)`;
    const list = await load(entry(116620n, 'CRDT', 'HV Test', 'DE89370400440532013000', 'RE 1038999'));
    const t = find(list, '1038999');
    const s = await suggestions(sql, t);
    expect(s[0]).toMatchObject({ kind: 'invoices', confidence: 'wahrscheinlich' });
    expect(s[0]!.label).toContain('2,00 %');
    expect(s[1]!.label).toContain('Teilzahlung');
    if (s[0]!.kind !== 'invoices') throw new Error();
    await assignInvoices(
      sql,
      t.id,
      s[0]!.items.map((i) => ({
        invoiceId: i.invoice_id,
        amount: i.amount,
        skonto: i.skonto,
        legacy: true,
        free: true,
      })),
      't',
    );
    const [inv] = await sql`select paid from app.legacy_invoices where number = '1038999'`;
    expect(inv!.paid).toBe(true);
    const learned =
      await sql`select 1 from app.customer_bank_accounts where customer_id = ${cust} and iban = 'DE89370400440532013000'`;
    expect(learned.length).toBe(1);
  });

  it('Lieferant schnell anlegen (nur Name, IBAN übernommen), Kostenart, Nicht zuordnen, Ausgaben-Statistik', async () => {
    const list = await load(
      entry(4990n, 'DBIT', 'TANKSTELLE ARAL', 'DE44500400000600178806', 'ARAL Karte 1234') +
        entry(1250n, 'DBIT', 'Münchner Bank', null, 'Kontoführung'),
    );
    const t = find(list, 'ARAL');
    const sid = await quickSupplier(sql, 'Tankstelle Aral', t, 't');
    expect(await quickSupplier(sql, 'tankstelle aral', t, 't')).toBe(sid);
    const [sp] = await sql`select iban, supplier_no from app.suppliers where id = ${sid}`;
    expect(sp!.iban).toBe('DE44500400000600178806');
    await assignParty(sql, t.id, { kind: 'lieferant', id: sid, note: 'Tanken', category: 'fahrzeuge' }, 't');
    const fee = find(list, 'Kontoführung');
    await ignoreTransaction(sql, fee.id, 'nicht zugeordnet', 't', 'bank');
    const st = await expenseStats(sql, { from: d(-1), to: today, group: 'monat', basis: 'konto' });
    const cat = Object.fromEntries(st.categories.map((c) => [c.key, c.cents]));
    expect(cat.material).toBe(97000n + 68100n);
    expect(cat.fahrzeuge).toBe(4990n);
    expect(cat.bank).toBe(1250n);
    expect(st.total).toBe(97000n + 68100n + 4990n + 1250n);
    expect(st.payees.find((p) => p.id === sid)?.cents).toBe(4990n);
    const inv = await expenseStats(sql, { from: d(-30), to: today, group: 'jahr', basis: 'rechnung' });
    expect(inv.categories[0]!.key).toBe('material');
  });
});
