import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { autoConfirmPlanned, officeConfirmPlanned } from './time.js';
import { payrollCorrections, payrollMonth, recordPayrollExport } from './payroll.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 26: Plan-Zeiten als Ist-Zeiten (Datenbank)', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '8801', 'Plan', 'Ist', '2024-01-01')`;
    // montags 06:00–09:00 seit Januar 2025, angelegt vorher (Soll zählt erst ab Anlage)
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, valid_until, created_at)
              values (${randomUUID()}, ${emp}, ${DEMO.siteSchool}, 1, '06:00', '09:00', '2025-01-01', '2025-01-31', '2024-12-01')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('trägt jeden vergangenen Einsatz ohne Zeit ein, freigegeben, doppelt ausführen legt nichts doppelt an', async () => {
    const r = await officeConfirmPlanned(sql, {
      employeeId: emp,
      from: '2025-01-01',
      to: '2025-01-31',
      actor: 'buero',
    });
    expect(r.created).toBe(3); // 13., 20., 27. Januar 2025 – der 06.01. ist Feiertag (Hl. Drei Könige)
    const rows = await sql<{ status: string; source: string; n: number }[]>`
      select status::text, source::text, count(*)::int as n from app.time_entries where employee_id = ${emp} group by 1, 2`;
    expect(rows).toEqual([{ status: 'freigegeben', source: 'soll_bestaetigt', n: 3 }]);
    const [log] =
      await sql`select reason from app.time_entry_log l join app.time_entries t on t.id = l.entry_id
                             where t.employee_id = ${emp} limit 1`;
    expect(log?.reason).toBe('Plan als Ist (Büro)');
    expect(
      (
        await officeConfirmPlanned(sql, {
          employeeId: emp,
          from: '2025-01-01',
          to: '2025-01-31',
          actor: 'buero',
        })
      ).created,
    ).toBe(0);
  });

  it('Soll als Ist automatisch nach 2 Tagen, nur ab dem Stichtag', async () => {
    const e2 = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${e2}, '8802', 'Auto', 'Ist', '2024-01-01')`;
    // täglich (alle Wochentage) 07:00–08:00 ab 01.03.2027
    for (let wd = 1; wd <= 7; wd++)
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, created_at)
                values (${randomUUID()}, ${e2}, ${DEMO.siteSchool}, ${wd}, '07:00', '08:00', '2026-03-01', '2026-02-01')`;
    await sql`update app.time_settings set auto_confirm_days = 2, auto_confirm_since = '2026-03-03'`;
    // „heute“ = 10.03.2027 → Einsätze 03.03.–08.03. (6 Tage), 01./02.03. vor dem Stichtag, 09./10.03. noch zu frisch
    expect(await autoConfirmPlanned(sql, '2026-03-10')).toBe(6);
    expect(await autoConfirmPlanned(sql, '2026-03-10')).toBe(0);
    const [log] = await sql<{ reason: string; actor: string }[]>`
      select l.reason, l.actor from app.time_entry_log l join app.time_entries t on t.id = l.entry_id
       where t.employee_id = ${e2} limit 1`;
    expect(log).toMatchObject({ actor: 'automatisch' });
    expect(log!.reason).toMatch(/automatisch/);
    await sql`update app.time_settings set auto_confirm_days = null`;
    expect(await autoConfirmPlanned(sql, '2026-03-20')).toBe(0);
  });

  it('Vorab-Lohnabrechnung: Ist bis Stichtag + Plan bis Monatsende, Korrektur im Folgemonat', async () => {
    const [e2] = await sql<{ id: string }[]>`select id from app.employees where personnel_no = '8802'`;
    const [r] = await payrollMonth(sql, '2026-03', e2!.id, { cutoff: '2026-03-08' });
    // 03.–08.03. erfasst (6 Std.), 09.–31.03. geplant (23 Std.)
    expect(r!.forecastMinutes).toBe(23 * 60);
    expect(r!.minutes.normal).toBe(29 * 60);
    await recordPayrollExport(sql, '2026-03', '2026-03-08', [r!], 't');
    const corr = await payrollCorrections(sql, '2026-03');
    expect(corr.cutoff).toBe('2026-03-08');
    const mine = corr.rows.find((x) => x.employee_id === e2!.id)!;
    expect(mine.minutes.normal).toBe(-23 * 60); // es wurde nach dem Stichtag nichts mehr erfasst
  });
});
