import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { subcontractEstimates } from './costing.js';
import { listTasks } from './crm.js';
import { DEMO } from './seed.js';
import { addSubcontractHours, deleteSubcontractHours, listSubcontractHours } from './subcontract-hours.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Objektleitung-Aufgaben, NU-Stundennachweis (Datenbank)', () => {
  let sql: Sql;
  const sup = randomUUID();
  const sc = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79101', 'Stunden-NU GmbH', 'nachunternehmer')`;
    await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents, valid_from, status, created_by)
              values (${sc}, 'BE-2026-0991', ${sup}, ${DEMO.siteSchool}, 'Sonderreinigung', 'einmalig', 'stunde', 2550, '2026-09-01', 'erteilt', 't')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Objektleitung sieht nur ihr zugeordnete Aufgaben (keine Ausschreibungs-Fristen, keine Büro-Aufgaben)', async () => {
    const mk = (title: string, assignee: string | null, by: string) =>
      sql`insert into app.tasks (id, title, assignee, status, created_by) values (${randomUUID()}, ${title}, ${assignee}, 'open', ${by})`;
    await mk('Abgabe Ausschreibung', null, 'buero');
    await mk('Büro-Aufgabe', 'Anna Büro', 'buero');
    await mk('Nachbesserung', 'Olga Leitung', 'buero');
    await mk('Eigene Notiz', null, 'olga');
    const viewer = { names: ['Olga Leitung', 'olga'], actor: 'olga' };
    const mine = await listTasks(sql, { status: 'open', onlyFor: viewer });
    expect(mine.map((t) => t.title).sort()).toEqual(['Eigene Notiz', 'Nachbesserung']);
    expect((await listTasks(sql, { status: 'open' })).length).toBeGreaterThanOrEqual(4);
  });

  it('Stunden je Tag: Personen × Std. × Satz, cent-genau, nichts doppelt, Schätzung in der Nachkalkulation', async () => {
    const id = randomUUID();
    const p = {
      id,
      subcontractId: sc,
      workDate: '2026-09-15',
      persons: 3,
      minutesPerPerson: 150,
      note: 'TH',
      actor: 'b',
    };
    await addSubcontractHours(sql, p);
    await addSubcontractHours(sql, p); // doppelt absenden
    await addSubcontractHours(sql, {
      ...p,
      id: randomUUID(),
      workDate: '2026-09-16',
      persons: 1,
      minutesPerPerson: 20,
    });
    const rows = await listSubcontractHours(sql, sc);
    expect(rows.length).toBe(2);
    // 3 × 2,5 Std. × 25,50 € = 191,25 €; 1 × 20 Min. × 25,50 € = 8,50 €
    expect(rows.map((r) => Number(r.amount_cents)).sort((a, b) => a - b)).toEqual([850, 19125]);
    await expect(
      addSubcontractHours(sql, { ...p, id: randomUUID(), workDate: '2026-08-31' }),
    ).rejects.toThrow(/außerhalb/);
    const est = await subcontractEstimates(sql, '2026-09-01', '2026-09-30', DEMO.siteSchool);
    expect(Number(est[0]!.cost)).toBe(19975);
    await deleteSubcontractHours(sql, id, sc, 'b');
    expect((await listSubcontractHours(sql, sc)).length).toBe(1);
  });
});
