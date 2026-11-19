import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseQuantity } from '../domain/money/money.js';
import { addRegieRates } from './masterdata.js';
import { closeWithoutSignature, reportsToInvoice, saveWorkReport } from './orders.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Regiestundensätze je Objekt', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('mehrere Sätze, idempotent, je Stundenzeile gewählt und je Satz eine Rechnungsposition', async () => {
    const form = randomUUID();
    const input = {
      description: 'Regiestunde Vorarbeiter/in',
      priceCents: 3850n,
      validFrom: '2026-01-01',
      validTo: null,
    };
    const r1 = await addRegieRates(sql, [DEMO.siteSchool], input, form, 'test');
    const r2 = await addRegieRates(sql, [DEMO.siteSchool], input, form, 'test');
    expect(r1.created).toBe(1);
    expect(r2).toEqual({ created: 0, skipped: 1 });
    await addRegieRates(
      sql,
      [DEMO.siteSchool],
      {
        description: 'Regiestunde Reinigungskraft',
        priceCents: 2990n,
        validFrom: '2026-01-01',
        validTo: null,
      },
      randomUUID(),
      'test',
    );
    const rates = await sql<{ id: string; description: string; unit_price_cents: bigint }[]>`
      select id, description, unit_price_cents from app.site_services
       where site_id = ${DEMO.siteSchool} and kind = 'hourly' and description like 'Regiestunde %'`;
    expect(rates).toHaveLength(2);
    const vor = rates.find((x) => x.description.includes('Vorarbeiter'))!;
    const rk = rates.find((x) => x.description.includes('Reinigungskraft'))!;

    const id = randomUUID();
    await saveWorkReport(
      sql,
      id,
      {
        orderId: null,
        siteId: DEMO.siteSchool,
        workDate: '2026-10-05',
        startTime: null,
        endTime: null,
        employeeIds: [],
        description: 'Sonderreinigung',
        materials: null,
        remarks: null,
        lines: [
          {
            description: '',
            quantity: parseQuantity('3'),
            unitCode: 'HUR',
            serviceId: vor.id,
            person: 'A. Muster',
          },
          {
            description: '',
            quantity: parseQuantity('4'),
            unitCode: 'HUR',
            serviceId: rk.id,
            person: 'B. Muster',
          },
          {
            description: '',
            quantity: parseQuantity('2'),
            unitCode: 'HUR',
            serviceId: rk.id,
            person: 'C. Muster',
          },
        ],
        expectedVersion: null,
      },
      'test',
    );
    await closeWithoutSignature(deps, id, 'Test', 'test');
    const inv = await reportsToInvoice(deps, DEMO.siteSchool, [id], 'test');
    const lines = await sql<{ description: string; quantity_milli: bigint; unit_price_cents: bigint }[]>`
      select description, quantity_milli, unit_price_cents from app.invoice_lines
       where invoice_id = ${inv} order by position`;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.description.includes('Vorarbeiter'))).toMatchObject({
      quantity_milli: 3000n,
      unit_price_cents: 3850n,
    });
    expect(lines.find((l) => l.description.includes('Reinigungskraft'))).toMatchObject({
      quantity_milli: 6000n,
      unit_price_cents: 2990n,
    });
  });
});
