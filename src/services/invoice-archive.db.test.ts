import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { archiveMonthZip, archiveYear } from './invoice-archive.js';
import { issue, saveDraft } from './invoices.js';
import { search } from './search.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Rechnungsarchiv nach Leistungszeitraum', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('gruppiert nach Monat des Leistungsbeginns, nicht nach Rechnungsdatum', async () => {
    const mk = async (start: string | null, issueDate: string) => {
      const id = await saveDraft(
        sql,
        randomUUID(),
        {
          customerId: DEMO.authority,
          siteId: DEMO.siteSchool,
          kind: 'invoice',
          periodStart: start,
          periodEnd: start ? `${start.slice(0, 8)}28` : null,
          orderReference: null,
          introText: null,
          closingText: null,
          lines: [
            {
              description: 'X',
              quantity: parseQuantity('1'),
              unitCode: 'MON',
              unitPrice: parseEuro('10,00'),
              vatRate: 1900,
            },
          ],
        },
        't',
      );
      return issue(sql, id, 't', issueDate);
    };
    const sep = await mk('2026-09-01', '2026-10-02'); // Leistung September, Rechnung Oktober
    const noPeriod = await mk(null, '2026-10-03');
    const { months } = await archiveYear(sql, 2026);
    expect(months.find((m) => m.month === '2026-09')!.rows.map((r) => r.number)).toContain(sep);
    expect(months.find((m) => m.month === '2026-10')!.rows.map((r) => r.number)).toEqual([noPeriod]);
    expect((await archiveYear(sql, 2026, sep)).months.flatMap((m) => m.rows).map((r) => r.number)).toEqual([
      sep,
    ]);
    await expect(archiveMonthZip(deps, '2026-09')).rejects.toThrow(/Keine Belege/); // Belege erst nach Erzeugung
    await expect(archiveYear(sql, 1800)).rejects.toThrow(/Jahr/);
  });

  it('Suche nach Rechnungsnummer über alle Jahre, auch Rechnungen von vor der Umstellung (Ahmed 09.10.)', async () => {
    const old = randomUUID();
    await sql`insert into app.legacy_invoices (id, number, issue_date, customer_id, net_cents, gross_cents, paid)
              values (${old}, '1037001', '2025-03-15', ${DEMO.authority}, 10000, 11900, true)`;
    // im Jahr 2026 gesucht → trotzdem gefunden (Suche ignoriert das Jahr)
    const hit = (await archiveYear(sql, 2026, '1037001')).months.flatMap((m) => m.rows);
    expect(hit.map((r) => [r.number, r.legacy])).toEqual([['1037001', true]]);
    // Leerzeichen in der Nummer stören nicht
    expect((await archiveYear(sql, 2026, '1037 001')).months.flatMap((m) => m.rows)).toHaveLength(1);
    // globale Suche oben findet sie ebenfalls (gleiche Adresse wie eigene Rechnungen)
    const g = await search(sql, '1037001');
    const r = g.groups.find((x) => x.type === 'Rechnung')!.hits;
    expect(r[0]!.href).toBe(`/rechnungen/${old}`);
    expect(r[0]!.label).toMatch(/^Rechnung 1037001 - 15\.03\.2025/);
  });
});
