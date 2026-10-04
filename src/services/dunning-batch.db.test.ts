import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays } from '../domain/time/holidays.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { batchCandidates, createDunningBatch } from './dunning.js';
import { issue, saveDraft } from './invoices.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Mahnwesen – Stapelverarbeitung', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const invoice = async (customerId: string, siteId: string, issueDate: string, price = '1.000,00') => {
    const id = randomUUID();
    await saveDraft(
      sql,
      id,
      {
        customerId,
        siteId,
        kind: 'invoice',
        periodStart: null,
        periodEnd: null,
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhaltsreinigung',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro(price),
            vatRate: 1900,
          },
        ],
      },
      'test',
    );
    await issue(sql, id, 'test', issueDate);
    return id;
  };

  it('zeigt alle überfälligen Rechnungen je Kunde mit Grund, erstellt je Kunde eine Mahnung, nichts doppelt', async () => {
    const today = todayBerlin();
    // Musterfirma: Zahlungsziel 20 Tage → weit überfällig (mahnbar) und knapp überfällig (noch nicht mahnbar)
    const old = await invoice(DEMO.company, DEMO.siteHq, '2026-06-01');
    const fresh = await invoice(DEMO.company, DEMO.siteHq, addDays(today, -22));
    // Behörde: Zahlungsziel 30 Tage
    const auth = await invoice(DEMO.authority, DEMO.siteSchool, '2026-05-01', '500,00');

    const list = await batchCandidates(sql);
    const company = list.find((c) => c.customer_id === DEMO.company)!;
    const oldItem = company.items.find((i) => i.invoice_id === old)!;
    const freshItem = company.items.find((i) => i.invoice_id === fresh)!;
    expect(oldItem.eligible).toBe(true);
    expect(oldItem.dunning_count).toBe(0);
    expect(freshItem.eligible).toBe(false);
    expect(freshItem.reason).toMatch(/ab 7 Tagen/);
    expect(company.open_cents).toBe(119000n * 2n);

    const idA = randomUUID();
    const idB = randomUUID();
    const entries = [
      { id: idA, customerId: DEMO.company, invoiceIds: [old] },
      { id: idB, customerId: DEMO.authority, invoiceIds: [auth] },
    ];
    const r = await createDunningBatch(deps, entries, true, 'test');
    expect(r.created).toHaveLength(2);
    expect(r.failed).toHaveLength(0);
    expect(deps.mailer.sent).toHaveLength(2);
    // doppelt abgeschickt → keine neuen Mahnungen, kein zweiter Versand
    const again = await createDunningBatch(deps, entries, true, 'test');
    expect(again.created).toHaveLength(2);
    expect(deps.mailer.sent).toHaveLength(2);
    expect(
      ((await sql`select count(*)::int as n from app.dunnings`) as unknown as [{ n: number }])[0].n,
    ).toBe(2);

    // danach: bisherige Mahnungen = 1, Mindestabstand → nicht mahnbar
    const after = (await batchCandidates(sql)).find((c) => c.customer_id === DEMO.company)!;
    const o2 = after.items.find((i) => i.invoice_id === old)!;
    expect(o2.dunning_count).toBe(1);
    expect(o2.eligible).toBe(false);
    expect(o2.reason).toMatch(/zuletzt gemahnt/);

    // Fehler bei einem Kunden bricht den Lauf nicht ab
    const r2 = await createDunningBatch(
      deps,
      [{ id: randomUUID(), customerId: DEMO.company, invoiceIds: [fresh] }],
      false,
      'test',
    );
    expect(r2.created).toHaveLength(0);
    expect(r2.failed[0]!.error).toMatch(/noch nicht mahnbar/);
  });
});
