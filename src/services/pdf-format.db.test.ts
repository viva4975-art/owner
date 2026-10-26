import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { saveDraft } from './invoices.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import { type Deps, preflight } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Format „PDF“ nachträglich in der Rechnungsgruppe gewählt', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Entwurf mit altem Format ZUGFeRD ohne E-Mail: Meldung nennt die Gruppe; nach Umstellen auf PDF geht es', async () => {
    await sql`update app.customers set invoice_emails = '{}' where id = ${DEMO.company}`;
    const g = randomUUID();
    await sql`insert into app.invoice_groups (id, customer_id, name, combine, bill_emails, bill_format)
              values (${g}, ${DEMO.company}, 'Hausverwaltung', false, '{}', 'zugferd')`;
    await sql`update app.sites set invoice_group_id = ${g} where id = ${DEMO.siteHq}`;
    const id = randomUUID();
    await saveDraft(
      sql,
      id,
      {
        customerId: DEMO.company,
        siteId: DEMO.siteHq,
        kind: 'invoice',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhaltsreinigung',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('100,00'),
            vatRate: 1900,
          },
        ],
      },
      't',
    );
    await expect(preflight(deps, id)).rejects.toThrow(/Rechnungsgruppe „Hausverwaltung“: ZUGFeRD/);
    await sql`update app.invoice_groups set bill_format = 'pdf' where id = ${g}`;
    expect((await preflight(deps, id)).valid).toBe(true);
    const [i] = await sql<
      { invoice_format: string }[]
    >`select invoice_format::text from app.invoices where id = ${id}`;
    expect(i!.invoice_format).toBe('pdf');
  });
});
