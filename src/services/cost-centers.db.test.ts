import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { type Cents, parseEuro } from '../domain/money/money.js';
import { costCenterReport, getAllocations, saveAllocations, splitEvenly } from './cost-centers.js';
import { siteCostDetails, siteCosting } from './costing.js';
import { saveIncoming } from './purchasing.js';
import { DEMO } from './seed.js';
import { saveSubcontract } from './subcontractors.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const NU = '00000000-0000-4000-8000-0000000c0a01';
const OFFICE_CC = '00000000-0000-4000-8000-0000000cc001';

describe.skipIf(!available)('Kostenstellen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${NU}, '70999', 'Test NU', 'nachunternehmer')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const incoming = (id: string, over: Partial<Parameters<typeof saveIncoming>[2]> = {}) =>
    saveIncoming(
      sql,
      id,
      {
        supplierId: NU,
        invoiceNo: `R-${id.slice(0, 6)}`,
        invoiceDate: '2026-09-30',
        dueDate: null,
        serviceMonth: '2026-09',
        net: parseEuro('3.000,00') as Cents,
        vat: 0n as Cents,
        reverseCharge: true,
        category: 'nachunternehmer',
        siteId: null,
        purchaseOrderId: null,
        skontoUntil: null,
        skontoPercentBp: null,
        note: null,
        expectedVersion: null,
        ...over,
      },
      't',
    );

  it('Cent-genaue Verteilung', () => {
    expect(splitEvenly(100n, 3)).toEqual([34n, 33n, 33n]);
    expect(splitEvenly(-100n, 3)).toEqual([-34n, -33n, -33n]);
    expect(splitEvenly(120000n, 12).reduce((a, b) => a + b, 0n)).toBe(120000n);
  });

  it('NU-Auftrag setzt Objekt, automatische Zuordnung, Aufteilung auf mehrere Objekte, Nachkalkulation', async () => {
    // NU-Auftrag ohne Nachweisprüfung direkt als erteilt markieren (Test)
    const sc = randomUUID();
    await saveSubcontract(
      sql,
      sc,
      {
        supplierId: NU,
        siteId: DEMO.siteSchool,
        serviceKind: 'Unterhaltsreinigung',
        frequency: 'monatlich',
        billing: 'pauschale_monat',
        priceCents: 300000n,
        maxHours: null,
        validFrom: '2026-01-01',
        validTo: null,
        description: null,
        note: null,
      },
      't',
    );
    await sql`update app.subcontracts set status = 'erteilt' where id = ${sc}`;
    const a = randomUUID();
    await incoming(a, { subcontractId: sc });
    const auto = await getAllocations(sql, a);
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({
      site_id: DEMO.siteSchool,
      net_cents: 300000n,
      auto: true,
      month: '2026-09-01',
    });
    let cost = (await siteCosting(sql, '2026-09', DEMO.siteSchool)).rows[0]!;
    expect(cost.subcontractor).toBe(300000n);

    // eine Rechnung für zwei Objekte + Gemeinkosten aufteilen
    await expect(
      saveAllocations(
        sql,
        a,
        [{ target: `site:${DEMO.siteSchool}`, month: '2026-09', net: 100000n, note: null }],
        't',
      ),
    ).rejects.toThrow(/angleichen/);
    await saveAllocations(
      sql,
      a,
      [
        { target: `site:${DEMO.siteSchool}`, month: '2026-09', net: 200000n, note: null },
        { target: `site:${DEMO.siteOffice}`, month: '2026-09', net: 90000n, note: null },
        { target: `cc:${OFFICE_CC}`, month: '2026-09', net: 10000n, note: 'Anfahrt' },
      ],
      't',
    );
    cost = (await siteCosting(sql, '2026-09', DEMO.siteSchool)).rows[0]!;
    expect(cost.subcontractor).toBe(200000n);
    expect((await siteCosting(sql, '2026-09', DEMO.siteOffice)).rows[0]!.subcontractor).toBe(90000n);

    // eigene Aufteilung bleibt beim erneuten Speichern der Rechnung erhalten
    await incoming(a, { subcontractId: sc, note: 'geändert' });
    expect((await getAllocations(sql, a)).filter((x) => !x.auto)).toHaveLength(3);

    const rep = await costCenterReport(sql, '2026-09', '2026-09');
    expect(rep.rows.find((r) => r.key === `cc:${OFFICE_CC}`)!.total).toBe(10000n);
    // Rechnung ohne Objekt → „nicht zugeordnet“
    const b = randomUUID();
    await incoming(b, { reverseCharge: false, vat: parseEuro('570,00') as Cents, category: 'sonstiges' });
    expect((await costCenterReport(sql, '2026-09', '2026-09')).unallocated.map((u) => u.id)).toContain(b);
  });

  it('Geräte (z. B. Hebebühne) als eigene Spalte, schon ab „erfasst“, Detailliste je Objekt', async () => {
    const h = randomUUID();
    await incoming(h, {
      reverseCharge: false,
      vat: parseEuro('57,00') as Cents,
      net: parseEuro('300,00') as Cents,
      category: 'geraete',
      siteId: DEMO.siteOffice,
      serviceMonth: '2026-10',
    });
    const row = (await siteCosting(sql, '2026-10', DEMO.siteOffice)).rows[0]!;
    expect(row.equipment).toBe(30000n);
    expect(row.other).toBe(0n);
    expect(row.customer_id).toBeTruthy();
    const d = await siteCostDetails(sql, DEMO.siteOffice, { from: '2026-10', to: '2026-10' });
    expect(d.map((x) => [x.id, x.category, x.net])).toEqual([[h, 'geraete', 30000n]]);
  });
});
