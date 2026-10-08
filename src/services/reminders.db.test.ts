import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { collectReminders, saveReminderSettings, sendDailyReminders } from './reminders.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Erinnerungen (Datenbank)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const today = todayBerlin();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.tasks (id, title, due_date, created_by) values (${randomUUID()}, 'Vertrag prüfen', ${addDays(today, -2)}, 't')`;
    await sql`insert into app.vehicles (id, plate, hu_due) values (${randomUUID()}, 'M-VD 123', ${addDays(today, 10)})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('sammelt Fristen: überfällige Aufgabe rot, HU in 10 Tagen gelb', async () => {
    const l = await collectReminders(sql, today);
    const task = l.find((r) => r.area === 'Aufgaben' && r.text.includes('Vertrag prüfen'))!;
    expect(task.level).toBe('rot');
    expect(task.text).toMatch(/seit 2 Tg/);
    const hu = l.find((r) => r.area === 'Fahrzeuge')!;
    expect(hu).toMatchObject({ level: 'gelb', days: 10 });
    expect(l[0]!.level).toBe('rot');
  });

  it('tägliche Mail höchstens einmal, nur wenn eingeschaltet', async () => {
    const noon = new Date(`${today}T10:00:00Z`);
    expect(await sendDailyReminders(deps, noon)).toBe('aus');
    await expect(
      saveReminderSettings(sql, { enabled: true, emails: ['kein-mail'], sendHour: 7 }, 't'),
    ).rejects.toThrow(/ungültig/);
    await saveReminderSettings(sql, { enabled: true, emails: ['buero@example.org'], sendHour: 7 }, 't');
    expect(await sendDailyReminders(deps, new Date(`${today}T03:00:00Z`))).toBe('aus'); // 05:00 Berlin, zu früh
    expect(await sendDailyReminders(deps, noon)).toBe('gesendet');
    expect(await sendDailyReminders(deps, noon)).toBe('aus');
    expect(deps.mailer.sent).toHaveLength(1);
    expect(deps.mailer.sent[0]!.to).toEqual(['test@viva-deluxe.local']);
    expect(deps.mailer.sent[0]!.text).toContain('Vertrag prüfen');
  });
});
