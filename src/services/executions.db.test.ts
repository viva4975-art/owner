import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseQuantity } from '../domain/money/money.js';
import {
  deleteExecution,
  dueCycleServices,
  draftsFromExecutions,
  executableServices,
  executeServices,
  listOpenExecutions,
} from './executions.js';
import { deleteDraft, getInvoice, runMonthly } from './invoices.js';
import { serviceKindOf } from './masterdata.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const GLAS = '00000000-0000-4000-8000-000000000104';
const REGIE = '00000000-0000-4000-8000-000000000103';

describe.skipIf(!available)('Leistungen verrichten → Rechnungsentwürfe', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('nur Leistungen je Ausführung, Ausführung idempotent, nur „von“ = ein Tag', async () => {
    const list = await executableServices(sql, DEMO.siteSchool);
    expect(list.map((s) => s.id).sort()).toEqual([REGIE, GLAS].sort());
    const input = {
      siteId: DEMO.siteSchool,
      token: randomUUID(),
      dateFrom: '2026-09-10',
      dateTo: null,
      items: [
        { serviceId: GLAS, quantity: null },
        { serviceId: REGIE, quantity: parseQuantity('3,5') },
      ],
    };
    expect(await executeServices(sql, input, 'test')).toBe(2);
    expect(await executeServices(sql, input, 'test')).toBe(0); // doppelt abgeschickt
    const open = await listOpenExecutions(sql, { siteId: DEMO.siteSchool });
    expect(open).toHaveLength(2);
    expect(open.find((o) => o.service_id === GLAS)).toMatchObject({
      date_from: '2026-09-10',
      date_to: '2026-09-10',
    });
    expect(open.find((o) => o.service_id === REGIE)!.quantity_milli).toBe(3500n);
    await expect(
      executeServices(sql, { ...input, token: randomUUID(), dateFrom: '2025-01-01' }, 'test'),
    ).rejects.toThrow(/außerhalb/);
    await expect(
      executeServices(sql, { ...input, token: randomUUID(), siteId: DEMO.siteOffice }, 'test'),
    ).rejects.toThrow(/nicht zu diesem Objekt/);
  });

  it('Entwürfe je Objekt, jede Ausführung nur einmal, gelöschter Entwurf gibt frei', async () => {
    const open = await listOpenExecutions(sql, { siteId: DEMO.siteSchool });
    const ids = open.map((o) => o.id);
    const [inv] = await draftsFromExecutions(sql, ids, '2026-09-30', 'test');
    expect(await draftsFromExecutions(sql, ids, null, 'test')).toEqual([]); // nichts doppelt
    const d = (await getInvoice(sql, inv!))!;
    expect(d.invoice).toMatchObject({
      period_start: '2026-09-10',
      period_end: '2026-09-10',
      planned_issue_date: '2026-09-30',
    });
    expect(d.lines).toHaveLength(2);
    expect(d.lines.every((l) => l.vat_rate_bp === 1900)).toBe(true);
    expect(d.lines.find((l) => l.unit_code === 'HUR')!.net_cents).toBe(10430n); // 3,5 × 29,80
    expect(d.lines[0]!.detail).toContain('Objekt: Grundschule Musterweg');
    expect(await listOpenExecutions(sql, { siteId: DEMO.siteSchool })).toHaveLength(0);
    await expect(deleteExecution(sql, ids[0]!, 'test')).rejects.toThrow(/Rechnung/);
    await deleteDraft(sql, inv!, 'test');
    expect(await listOpenExecutions(sql, { siteId: DEMO.siteSchool })).toHaveLength(2);
    await deleteExecution(sql, ids[0]!, 'test');
    expect(await listOpenExecutions(sql, { siteId: DEMO.siteSchool })).toHaveLength(1);
  });

  it('einmalige Leistung mehrfach verrichtbar (je Datum)', async () => {
    await sql`update app.site_services set billing_cycle = 'einmalig' where id = ${GLAS}`;
    await executeServices(
      sql,
      {
        siteId: DEMO.siteSchool,
        token: randomUUID(),
        dateFrom: '2026-09-12',
        dateTo: null,
        items: [{ serviceId: GLAS, quantity: null }],
      },
      'test',
    ).catch(() => undefined);
    const n = await executeServices(
      sql,
      {
        siteId: DEMO.siteSchool,
        token: randomUUID(),
        dateFrom: '2026-09-13',
        dateTo: null,
        items: [{ serviceId: GLAS, quantity: null }],
      },
      'test',
    );
    expect(n).toBe(1);
  });
});

describe.skipIf(!available)('Zyklus-Leistungen nach Ausführung (Ahmed 09.10.)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('halbjährlich = nach Ausführung: nicht im Monatslauf, verrichtbar, Fälligkeit + Erinnerung', async () => {
    const id = randomUUID();
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli,
                unit_price_cents, vat_rate_bp, valid_from, billing_cycle)
              values (${id}, ${DEMO.siteSchool}, 'special', 'Glasreinigung halbjährlich', 'LS', 1000, 90000, 1900,
                      '2026-03-01', 'halbjaehrlich')`;
    const list = await executableServices(sql, DEMO.siteSchool);
    expect(list.find((s) => s.id === id)?.next_due).toBe('2026-03-01');
    const run = await runMonthly(sql, '2026-09', 'test', { siteIds: [DEMO.siteSchool] });
    for (const c of run.created) {
      const inv = await getInvoice(sql, c.invoiceId);
      expect(inv!.lines.some((l) => l.description.includes('halbjährlich'))).toBe(false);
    }
    expect((await dueCycleServices(sql, '2026-10-09')).map((d) => d.id)).toContain(id);
    await executeServices(
      sql,
      {
        siteId: DEMO.siteSchool,
        token: randomUUID(),
        dateFrom: '2026-09-20',
        dateTo: null,
        items: [{ serviceId: id, quantity: null }],
      },
      'test',
    );
    // vorgemerkt → keine Erinnerung; nächste Fälligkeit = Ausführung + 6 Monate
    expect((await dueCycleServices(sql, '2026-10-09')).map((d) => d.id)).not.toContain(id);
    expect((await executableServices(sql, DEMO.siteSchool)).find((s) => s.id === id)?.next_due).toBe(
      '2027-03-20',
    );
  });

  it('Formular: 2-monatlich … jährlich standardmäßig nach Ausführung, auf Wunsch automatisch', () => {
    expect(serviceKindOf('LS', 'jaehrlich')).toBe('special');
    expect(serviceKindOf('LS', 'quartalsweise', true)).toBe('monthly_flat');
    expect(serviceKindOf('LS', 'monatlich')).toBe('monthly_flat');
    expect(serviceKindOf('HUR', 'monatlich')).toBe('hourly');
  });
});
