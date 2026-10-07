import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { batchCandidates, createDunning, getDunning } from './dunning.js';
import { markLegacyPaid } from './fortytools-xml-import.js';
import { listBalances } from './payments.js';
import { invoiceStatistics } from './reports.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)(
  'Runde 22: Offene Posten und Mahnwesen mit Fortytools-Rechnungen (Datenbank)',
  () => {
    let sql: Sql;
    let deps: Deps & { mailer: FakeMailer };
    const cust = randomUUID();
    const today = todayBerlin();
    beforeAll(async () => {
      sql = await freshDatabase();
      deps = await testDeps(sql);
      await sql`insert into app.customers (id, customer_no, name, street, postal_code, city, invoice_emails)
              values (${cust}, '29966', 'Altkunde GmbH', 'Weg 1', '80331', 'München', ${['op@altkunde.example']})`;
    });
    afterAll(async () => {
      await sql?.end();
    });

    const legacy = (no: string, gross: bigint, opts: { paid?: boolean; root: string; due: string }) =>
      sql`insert into app.legacy_invoices (id, number, issue_date, due_date, customer_id, customer_no, net_cents,
                                         gross_cents, paid, ft_root_id)
        values (${randomUUID()}, ${no}, ${addDays(opts.due, -20)}, ${opts.due}, ${cust}, '29966', ${(gross * 100n) / 119n},
                ${gross}, ${opts.paid ?? false}, ${opts.root}) returning id`.then((r) => r[0]!.id as string);

    it('Storno-Gruppen wie Fortytools, Teilzahlung, Spalten offen/überfällig, Mahnung und Statistik', async () => {
      // A: überfällig 249,90 mit offener Korrektur −100,00 derselben Gruppe → 149,90
      const a = await legacy('9800001', 24990n, { root: 'r1', due: addDays(today, -30) });
      await legacy('9800002', -10000n, { root: 'r1', due: addDays(today, -10) });
      // B: bezahlte Rechnung mit offener Korrektur → kein offener Posten (Kochel)
      await legacy('9800003', 50000n, { root: 'r2', paid: true, due: addDays(today, -40) });
      await legacy('9800004', -35181n, { root: 'r2', due: addDays(today, 10) });
      // C: noch nicht fällig, Teilzahlung 100,00
      const c = await legacy('9800005', 30000n, { root: 'r3', due: addDays(today, 8) });
      await markLegacyPaid(sql, c, today, 't', 10000n);

      const [bal] = (await listBalances(sql)).filter((x) => x.customer_id === cust);
      expect(bal).toMatchObject({ overdue_cents: 14990n, due_cents: 20000n, open_cents: 34990n, days: -30 });

      // Mahnwesen: A erscheint (30 Tage überfällig), Mahnung enthält sie
      const cand = (await batchCandidates(sql)).find((x) => x.customer_id === cust)!;
      expect(cand.items.map((i) => [i.number, i.open_cents])).toEqual([['9800001', 14990n]]);
      const id = randomUUID();
      await createDunning(deps, id, cust, [a], 't');
      const d = await getDunning(sql, id);
      expect(d!.items.map((i) => i.number)).toEqual(['9800001']);

      // Rest bezahlen → bezahlt, nicht mehr offen
      await markLegacyPaid(sql, c, today, 't');
      const [p] = await sql<{ paid: boolean }[]>`select paid from app.legacy_invoices where id = ${c}`;
      expect(p!.paid).toBe(true);

      // Rechnungs-Statistik zählt Fortytools-Rechnungen mit (Korrekturen als Storno/Korrektur)
      const st = await invoiceStatistics(sql, Number(addDays(today, -60).slice(0, 4)));
      expect(st.months.reduce((n, m) => n + m.invoices + m.reversals, 0)).toBeGreaterThan(0);
    });
  },
);
