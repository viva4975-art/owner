import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  assignCosts,
  getTransaction,
  importStatement,
  lastCostAssignment,
  reopenTransaction,
} from './bank.js';
import { costCenterReport } from './cost-centers.js';
import { siteCostDetails, siteCosting } from './costing.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const OWN = 'DE39701900000003297837';
const OFFICE_CC = '00000000-0000-4000-8000-0000000cc001';
const today = todayBerlin();
const month = today.slice(0, 7);

const camt = (cents: string, purpose: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>${randomUUID()}</MsgId></GrpHdr>
<Stmt><Id>1</Id><Acct><Id><IBAN>${OWN}</IBAN></Id></Acct><Ntry><Amt Ccy="EUR">${cents}</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${today}</Dt></BookgDt><NtryDtls><TxDtls><RltdPties><Cdtr><Pty><Nm>Baumarkt Huber</Nm></Pty></Cdtr>
<CdtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>${purpose}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

describe.skipIf(!available)('Kontoumsatz direkt als Kosten zuordnen', () => {
  let sql: Sql;
  let deps: Deps;
  const load = async (amount: string, purpose: string) => {
    await importStatement(deps, {
      id: randomUUID(),
      filename: 'x.xml',
      bytes: new TextEncoder().encode(camt(amount, purpose)),
      accountIban: null,
      actor: 't',
    });
    const [r] = await sql<{ id: string }[]>`select id from app.bank_transactions where purpose = ${purpose}`;
    return (await getTransaction(sql, r!.id))!;
  };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('auf zwei Objekte + Kostenstelle verteilt, netto in Nachkalkulation, Kostenstellen, Details', async () => {
    const t = await load('119.00', 'Kassenbon 4711');
    await expect(
      assignCosts(
        sql,
        t.id,
        {
          lines: [{ target: `s:${DEMO.siteSchool}`, gross: 50_00n }],
          category: 'material',
          vatBp: 1900,
          month,
          note: null,
        },
        't',
      ),
    ).rejects.toThrow(/Summe/);
    await assignCosts(
      sql,
      t.id,
      {
        lines: [
          { target: `s:${DEMO.siteSchool}`, gross: 59_50n },
          { target: `s:${DEMO.siteOffice}`, gross: 35_70n },
          { target: `c:${OFFICE_CC}`, gross: 23_80n },
        ],
        category: 'material',
        vatBp: 1900,
        month,
        note: 'Reinigungsmittel',
      },
      't',
    );
    const after = (await getTransaction(sql, t.id))!;
    expect(after).toMatchObject({
      status: 'ignoriert',
      assigned_kind: 'kosten',
      expense_category: 'material',
    });
    const school = (await siteCosting(sql, month, DEMO.siteSchool)).rows[0]!;
    expect(school.material).toBe(50_00n);
    // Kostenstellen-Auswertung: Büro 20,00 netto (Material an allgemeinen Kostenstellen zählt in der
    // Nachkalkulation bewusst nicht – kommt über die Materialausgabe am Objekt, Entscheidung 27.10.)
    const rep = await costCenterReport(sql, month, month);
    expect(JSON.stringify(rep, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toContain('"2000"');
    const det = await siteCostDetails(sql, DEMO.siteOffice, { from: month, to: month });
    expect(det.some((d) => d.href === `/transfer/kontoumsaetze/${t.id}` && d.net === 30_00n)).toBe(true);
    // Vorschlag für den nächsten Umsatz desselben Empfängers
    const t2 = await load('20.00', 'Kassenbon 4712');
    expect(await lastCostAssignment(sql, t2)).toMatchObject({
      target: `s:${DEMO.siteSchool}`,
      category: 'material',
    });
    // eine Zeile ohne Betrag = ganzer Umsatz, ohne USt
    await assignCosts(
      sql,
      t2.id,
      {
        lines: [{ target: `s:${DEMO.siteSchool}`, gross: 0n }],
        category: 'geraete',
        vatBp: 0,
        month,
        note: null,
      },
      't',
    );
    expect((await siteCosting(sql, month, DEMO.siteSchool)).rows[0]!.equipment).toBe(20_00n);
    // wieder öffnen → Kosten weg
    await reopenTransaction(sql, t.id, 't');
    expect((await siteCosting(sql, month, DEMO.siteSchool)).rows[0]!.material).toBe(0n);
    const [n] = await sql<
      { n: number }[]
    >`select count(*)::int as n from app.bank_cost_allocations where bank_transaction_id = ${t.id}`;
    expect(n!.n).toBe(0);
  });
});
