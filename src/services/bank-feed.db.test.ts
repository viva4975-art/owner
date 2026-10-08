import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import {
  assignIncoming,
  assignInvoices,
  assignParty,
  closeBefore,
  getTransaction,
  importStatement,
  listTransactions,
  reopenTransaction,
  suggestions,
} from './bank.js';
import {
  accountOverview,
  decimalToCents,
  fetchAll,
  finishConnect,
  makeJwt,
  mapTransaction,
  saveFeedConfig,
  setBankFetcher,
  startConnect,
  statement,
} from './bank-feed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const OWN = 'DE39701900000003297837';
const FOREIGN = 'DE02120300000000202051';
const today = todayBerlin();
const d = (n: number) => addDays(today, n);

describe('Enable Banking: Bausteine', () => {
  it('Betrag als Text → Cent ohne Gleitkomma', () => {
    expect(decimalToCents('476.00')).toBe(47600n);
    expect(decimalToCents('-10.45')).toBe(-1045n);
    expect(decimalToCents('0.1')).toBe(10n);
    expect(decimalToCents('1234')).toBe(123400n);
    expect(() => decimalToCents('1e3')).toThrow();
  });
  it('Umsatz: Vorzeichen aus CRDT/DBIT, Gegenpartei, nur gebuchte', () => {
    const base = {
      transaction_amount: { amount: '836.32', currency: 'EUR' },
      booking_date: '2026-10-08',
      creditor: { name: 'HORNBACH' },
      creditor_account: { iban: 'DE44 5004 0000 0600 1788 06' },
      debtor: { name: 'Viva' },
      remittance_information: ['HORNBACH BAUMARKT', ' A/HANS-STEINKOHL-STR.'],
    };
    const l = mapTransaction({ ...base, credit_debit_indicator: 'DBIT', status: 'BOOK' }, OWN)!;
    expect(l.amountCents).toBe(-83632n);
    expect(l.counterpartyName).toBe('HORNBACH');
    expect(l.counterpartyIban).toBe('DE44500400000600178806');
    expect(l.purpose).toBe('HORNBACH BAUMARKT A/HANS-STEINKOHL-STR.');
    expect(mapTransaction({ ...base, credit_debit_indicator: 'DBIT', status: 'PDNG' }, OWN)).toBeNull();
    expect(mapTransaction({ ...base, credit_debit_indicator: 'CRDT' }, OWN)!.counterpartyName).toBe('Viva');
  });
  it('JWT mit RS256 und kid = Application-ID', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t = makeJwt('11111111-2222-3333-4444-555555555555', privateKey, Date.UTC(2026, 9, 8));
    const [h, b, s] = t.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toMatchObject({
      alg: 'RS256',
      kid: '11111111-2222-3333-4444-555555555555',
    });
    const body = JSON.parse(Buffer.from(b!, 'base64url').toString());
    expect(body).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com' });
    expect(body.exp - body.iat).toBe(3600);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(
      true,
    );
  });
});

describe.skipIf(!available)('Enable Banking: Verbinden, Abrufen, Zuordnen', () => {
  let sql: Sql;
  let deps: Deps;
  const APP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const calls: { method: string; path: string; body: unknown; auth: string }[] = [];
  let txs: Record<string, unknown>[] = [];
  const reply = (path: string, body: unknown): unknown => {
    if (path === '/aspsps?country=DE')
      return {
        aspsps: [
          {
            name: 'Münchner Bank',
            country: 'DE',
            maximum_consent_validity: 15552000,
            psu_types: ['business', 'personal'],
          },
        ],
      };
    if (path === '/auth') return { url: 'https://auth.enablebanking.com/start?x=1' };
    if (path === '/sessions')
      return {
        session_id: 'sess-1',
        access: { valid_until: new Date(Date.now() + 180 * 86400_000).toISOString() },
        accounts: [
          { uid: 'acc-own', account_id: { iban: OWN }, currency: 'EUR' },
          { uid: 'acc-foreign', account_id: { iban: FOREIGN }, currency: 'EUR' },
        ],
      };
    if (path === '/accounts/acc-foreign/balances') return { balances: [] };
    if (path.startsWith('/accounts/acc-foreign/transactions')) return { transactions: [] };
    if (path === '/accounts/acc-own/balances')
      return {
        balances: [{ balance_amount: { amount: '101621.13' }, balance_type: 'CLBD', reference_date: today }],
      };
    if (path.startsWith('/accounts/acc-own/transactions')) {
      const cont = new URLSearchParams(path.split('?')[1]).get('continuation_key');
      return cont
        ? { transactions: txs.slice(2) }
        : { transactions: txs.slice(0, 2), continuation_key: 'k2' };
    }
    throw new Error(`unerwartet ${path} ${JSON.stringify(body)}`);
  };

  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    setBankFetcher(async (url, init) => {
      const path = url.replace('https://api.enablebanking.com', '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: String(init.method),
        path,
        body,
        auth: String((init.headers as Record<string, string>).Authorization),
      });
      return new Response(JSON.stringify(reply(path, body)), { status: 200 });
    });
  });
  afterEach(() => {
    calls.length = 0;
  });
  afterAll(async () => {
    setBankFetcher(null);
    await sql?.end();
  });

  it('Schlüssel: falsche Datei abgelehnt, gespeichert nur verschlüsselt', async () => {
    await expect(saveFeedConfig(deps, { appId: APP, pem: 'kein schlüssel', actor: 't' })).rejects.toThrow(
      /nicht lesbar/,
    );
    await expect(saveFeedConfig(deps, { appId: 'xyz', pem: '', actor: 't' })).rejects.toThrow(
      /Application ID/,
    );
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await saveFeedConfig(deps, { appId: APP, pem, actor: 't' });
    const [row] = await sql<{ key_enc: string }[]>`select key_enc from app.bank_feed_config`;
    expect(row!.key_enc).not.toContain('PRIVATE KEY');
  });

  it('Bank verbinden: Rückkehr mit Code → Sitzung, alle Konten der Anmeldung aktiv (auch IBAN nicht in Firmendaten); fremder state abgelehnt', async () => {
    const url = await startConnect(deps, {
      aspsp: 'Münchner Bank',
      redirectUrl: 'https://app.example/transfer/bank/rueckkehr',
      actor: 't',
    });
    expect(url).toMatch(/^https:\/\/auth\.enablebanking\.com/);
    const auth = calls.find((c) => c.path === '/auth')!;
    expect(auth.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(auth.body).toMatchObject({
      aspsp: { name: 'Münchner Bank', country: 'DE' },
      psu_type: 'business',
    });
    const state = (auth.body as { state: string }).state;
    await expect(
      finishConnect(deps, { state: 'falsch', code: 'c', error: null, actor: 't' }),
    ).rejects.toThrow(/Unbekannte/);
    const r = await finishConnect(deps, { state, code: 'code-1', error: null, actor: 't' });
    expect(r.accounts).toBe(2);
    const acc = await sql<
      { uid: string; active: boolean }[]
    >`select uid, active from app.bank_feed_accounts order by uid`;
    expect(acc).toEqual([
      { uid: 'acc-foreign', active: true },
      { uid: 'acc-own', active: true },
    ]);
    // Code nur einmal
    expect((await finishConnect(deps, { state, code: 'code-1', error: null, actor: 't' })).already).toBe(
      true,
    );
  });

  it('Abruf: Seiten, Kontostand, doppelt abrufen und CAMT-Überschneidung legen nichts doppelt an', async () => {
    const cust = randomUUID();
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '20017', 'Münchner Wohnen GmbH', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.customer_bank_accounts (id, customer_id, holder, iban, created_by)
              values (${randomUUID()}, ${cust}, 'MW', 'DE20701500001002088670', 't')`;
    await sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, customer_no, net_cents, gross_cents, paid)
              values (${randomUUID()}, '1038233', '2026-09-25', ${d(10)}, ${cust}, '20017', 40000, 47600, false)`;
    txs = [
      {
        entry_reference: 'e1',
        transaction_amount: { amount: '476.00', currency: 'EUR' },
        credit_debit_indicator: 'CRDT',
        status: 'BOOK',
        booking_date: today,
        debtor: { name: 'Munchner Wohnen Service GmbH' },
        debtor_account: { iban: 'DE20701500001002088670' },
        remittance_information: ['/RE/ 1038233 /TRH-Reinigung 09/2026, WE4010'],
      },
      {
        entry_reference: 'e2',
        transaction_amount: { amount: '10.45' },
        credit_debit_indicator: 'DBIT',
        status: 'BOOK',
        booking_date: today,
        creditor: { name: 'Nexi Germany GmbH' },
        remittance_information: ['BAECKEREI ZIEGLE'],
      },
      {
        entry_reference: 'e3',
        transaction_amount: { amount: '309.58' },
        credit_debit_indicator: 'DBIT',
        status: 'BOOK',
        booking_date: d(-1),
        creditor: { name: 'ARCORA HANDELS GmbH' },
        creditor_account: { iban: FOREIGN },
        remittance_information: ['ER157203 SecureGo plus'],
      },
      {
        transaction_amount: { amount: '99.00' },
        credit_debit_indicator: 'CRDT',
        status: 'PDNG',
        booking_date: today,
        remittance_information: ['vorgemerkt'],
      },
    ];
    // ARCORA schon per CAMT eingelesen (andere Referenzen) → darf nicht doppelt kommen
    const camt = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>1</MsgId></GrpHdr>
<Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct><Ntry><Amt Ccy="EUR">309.58</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${d(-1)}</Dt></BookgDt><AcctSvcrRef>XYZ</AcctSvcrRef><NtryDtls><TxDtls>
<RltdPties><Cdtr><Pty><Nm>ARCORA HANDELS GmbH</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>ER157203 SecureGo  plus</Ustrd></RmtInf>
</TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'a.xml',
      bytes: new TextEncoder().encode(camt),
      accountIban: null,
      actor: 't',
    });
    const r1 = await fetchAll(deps, { actor: 't' });
    expect(r1.errors).toEqual([]);
    expect(r1.accounts).toBe(2);
    expect(r1.created).toBe(2); // ohne vorgemerkten, ohne CAMT-Dublette
    expect(calls.filter((c) => c.path.includes('acc-own/transactions')).length).toBe(2); // zwei Seiten
    expect(calls.some((c) => c.path.includes('acc-foreign'))).toBe(true); // Konto aus der Bank-Anmeldung
    const r2 = await fetchAll(deps, { actor: 't' });
    expect(r2.created).toBe(0);
    const [acc] = await accountOverview(sql);
    expect(acc!.balance_cents).toBe(10162113n);
    expect(acc!.open).toBe(3);
    // Automatik: zu kurz nach dem letzten Abruf → nichts
    calls.length = 0;
    await fetchAll(deps, { actor: 'auto', auto: true });
    expect(calls.length).toBe(0);
  });

  it('Vorschlag Fortytools-Rechnung über Nummer im Zweck, Zuordnen bucht Zahlung, Rechnung bezahlt', async () => {
    const list = await listTransactions(sql, { status: 'offen' });
    const mw = list.find((t) => t.amount_cents === 47600n)!;
    const [s] = await suggestions(sql, mw);
    expect(s).toMatchObject({ kind: 'invoices', confidence: 'sicher' });
    if (s!.kind !== 'invoices') throw new Error();
    expect(s!.items[0]).toMatchObject({ number: '1038233', legacy: true, customer_no: '20017' });
    await assignInvoices(
      sql,
      mw.id,
      s!.items.map((i) => ({ invoiceId: i.invoice_id, amount: i.amount, skonto: i.skonto, legacy: true })),
      't',
    );
    await assignInvoices(
      sql,
      mw.id,
      s!.items.map((i) => ({ invoiceId: i.invoice_id, amount: i.amount, skonto: i.skonto, legacy: true })),
      't',
    );
    const [inv] = await sql<
      { paid: boolean }[]
    >`select paid from app.legacy_invoices where number = '1038233'`;
    expect(inv!.paid).toBe(true);
    const pays = await sql`select * from app.legacy_payments where bank_transaction_id = ${mw.id}`;
    expect(pays.length).toBe(1);
    const t = await getTransaction(sql, mw.id);
    expect(t).toMatchObject({ status: 'zugeordnet', assigned_kind: 'kunde' });
  });

  it('Ausgang: Eingangsrechnung als bezahlt, Mitarbeiter ohne Buchung (wieder öffnen), ältere abhaken', async () => {
    const sup = randomUUID();
    await sql`insert into app.suppliers (id, supplier_no, name, iban) values (${sup}, '79002', 'ARCORA HANDELS GmbH', ${FOREIGN})`;
    const inc = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                gross_cents, category, status, created_by)
              values (${inc}, ${sup}, 'ER157203', ${d(-10)}, ${d(10)}, 26015, 4943, 30958, 'material', 'freigegeben', 't')`;
    const list = await listTransactions(sql, { status: 'offen' });
    const arc = list.find((t) => t.amount_cents === -30958n)!;
    const [s] = await suggestions(sql, arc);
    expect(s).toMatchObject({ kind: 'incoming', confidence: 'sicher', supplierId: sup });
    await assignIncoming(sql, arc.id, [{ id: inc }], 't');
    const [i] = await sql<{ status: string; paid_amount_cents: bigint; bank_transaction_id: string }[]>`
      select status, paid_amount_cents, bank_transaction_id from app.incoming_invoices where id = ${inc}`;
    expect(i).toMatchObject({ status: 'bezahlt', paid_amount_cents: 30958n, bank_transaction_id: arc.id });

    const emp = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type)
              values (${emp}, '9901', 'Max', 'Muster', '2020-01-01', 'vollzeit')`;
    const nexi = list.find((t) => t.amount_cents === -1045n)!;
    await assignParty(sql, nexi.id, { kind: 'mitarbeiter', id: emp, note: 'Auslagenerstattung' }, 't');
    expect((await getTransaction(sql, nexi.id))!.note).toBe(
      'Mitarbeiter 9901 Max Muster: Auslagenerstattung',
    );
    await reopenTransaction(sql, nexi.id, 't');
    expect(await getTransaction(sql, nexi.id)).toMatchObject({ status: 'offen', assigned_kind: null });
    expect(await closeBefore(sql, today, OWN, 't')).toBe(1);
  });

  it('Kontoauszug: Salden rückwärts aus dem Kontostand errechnet', async () => {
    const st = await statement(sql, { iban: OWN, from: d(-1), to: today });
    expect(st.end).toBe(10162113n);
    // vor gestern: Kontostand − (476,00 − 10,45 − 309,58)
    expect(st.start).toBe(10162113n - (47600n - 1045n - 30958n));
    expect(st.income).toBe(47600n);
    expect(st.outgo).toBe(-1045n - 30958n);
    expect((await statement(sql, { iban: OWN, from: d(-1), to: today, q: 'nexi' })).rows.length).toBe(1);
  });
});
