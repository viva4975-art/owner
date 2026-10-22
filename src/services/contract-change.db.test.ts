import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { applyContractChange, type ContractChangeInput, contractChangePdf } from './contract-change.js';
import { getEmployee } from './employees.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

const base: ContractChangeInput = {
  validFrom: '2026-11-01',
  contractDate: null,
  weeklyHours: null,
  daysPerWeek: null,
  pay: null,
  siteOld: null,
  siteNew: null,
  taskOld: null,
  taskNew: null,
  other: null,
  signDate: '2026-10-22',
};

describe.skipIf(!available)('Vertragsänderung', () => {
  let sql: Sql;
  const emp = randomUUID();
  const mini = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours, salutation, pay_model, hourly_wage_cents)
              values (${emp}, '9891', 'Vera', 'Ändern', '2025-01-01', 'teilzeit', 20, 'Frau', 'individuell', 1500),
                     (${mini}, '9892', 'Max', 'Mini', '2025-01-01', 'minijob', 8, 'Herr', 'individuell', 1500)`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('PDF nur mit Änderungen, ohne Änderung abgelehnt', async () => {
    await expect(contractChangePdf(sql, emp, base)).rejects.toThrow(/nichts geändert/);
    const r = await contractChangePdf(sql, emp, {
      ...base,
      weeklyHours: 25,
      pay: { model: 'individuell', wageCents: 1650n },
    });
    expect(r.rows.map((x) => x.label)).toEqual(['Wöchentliche Arbeitszeit', 'Vergütung']);
    expect(r.rows[1]).toMatchObject({ old: '15,00 € brutto / Std.', neu: '16,50 € brutto / Std.' });
    expect(Buffer.from(r.pdf).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('Übernehmen: Stunden ab Stichtag, Vergütung als Aufgabe (Zukunft) bzw. sofort', async () => {
    const future = addDays(todayBerlin(), 10);
    const done = await applyContractChange(
      sql,
      emp,
      { ...base, validFrom: future, weeklyHours: 25, pay: { model: 'individuell', wageCents: 1650n } },
      'test',
    );
    expect(done).toHaveLength(2);
    const [h] =
      await sql`select weekly_hours::text from app.employee_hours where employee_id = ${emp} and valid_from = ${future}`;
    expect(h?.weekly_hours).toBe('25.00');
    const [t] = await sql`select title from app.tasks where entity_id = ${emp} and due_date = ${future}`;
    expect(t?.title).toMatch(/Vergütung ändern/);
    // doppelt → keine zweite Aufgabe
    await applyContractChange(
      sql,
      emp,
      { ...base, validFrom: future, pay: { model: 'individuell', wageCents: 1650n } },
      'test',
    );
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from app.tasks where entity_id = ${emp}`;
    expect(n?.n).toBe(1);
    await applyContractChange(
      sql,
      emp,
      { ...base, validFrom: todayBerlin(), pay: { model: 'individuell', wageCents: 1700n } },
      'test',
    );
    const e = await getEmployee(sql, emp);
    expect(BigInt(e!.employee.hourly_wage_cents!)).toBe(1700n);
  });

  it('Minijob über Verdienstgrenze → Hinweis', async () => {
    const { contractChangeRows } = await import('./contract-change.js');
    const e = await getEmployee(sql, mini);
    const r = await contractChangeRows(sql, e!.employee, { ...base, weeklyHours: 12 });
    expect(r.hints.join(' ')).toMatch(/Verdienstgrenze/);
  });
});
