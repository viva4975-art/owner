import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import type { Env } from '../config/env.js';
import type { OutgoingMail } from '../mail/mailer.js';
import { leaveExitPreview } from './absences.js';
import { greetingMail, greetingsBetween, getGreetingSettings, sendGreetings } from './greetings.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Glückwünsche und Urlaub bei Austritt', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours, email, salutation)
              values (${emp}, '9872', 'Maria', 'Gruß', '2021-03-15', 'vollzeit', 40, 'maria@example.org', 'Frau')`;
    await sql`insert into app.employee_private (employee_id, birth_date) values (${emp}, '1992-02-29')`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('findet Geburtstag (29.02. → 28.02.) und Jubiläum, Text ohne Alter', async () => {
    const b = await greetingsBetween(sql, '2027-02-28', '2027-02-28');
    expect(b.map((x) => x.kind)).toEqual(['geburtstag']);
    const j = await greetingsBetween(sql, '2026-03-15', '2026-03-15');
    expect(j[0]).toMatchObject({ kind: 'jubilaeum', years: 5 });
    const m = greetingMail(j[0]!, await getGreetingSettings(sql));
    expect(m.text).toContain('Liebe Maria,');
    expect(m.text).toContain('seit 5 Jahren');
    expect(m.text).not.toContain('34');
  });

  it('sendet je Anlass und Jahr genau einmal, von info@', async () => {
    await sql`update app.greeting_settings set enabled = true, send_hour = 0 where id = 1`;
    const sent: OutgoingMail[] = [];
    const deps = {
      sql,
      env: { APP_ENV: 'test', MAIL_TEST_RECIPIENT: 't@example.org' } as Env,
      mailer: { send: async (m: OutgoingMail) => (sent.push(m), { messageId: m.messageId }) },
    };
    const day = new Date('2026-03-15T10:00:00Z');
    expect(await sendGreetings(deps, day)).toBe(1);
    expect(await sendGreetings(deps, day)).toBe(0);
    expect(sent[0]!.from).toContain('info@viva-deluxe-reinigung.de');
    expect(sent[0]!.to).toEqual(['t@example.org']);
  });

  it('Vorschau Austritt: anteilig, Urlaub danach zählt nicht', async () => {
    // Urlaub im Januar und Mai; Austritt 31.03. (erste Jahreshälfte → 30 × 3/12 = 7,5)
    await sql`insert into app.absences (id, employee_id, kind, start_date, end_date, status, requested_by)
              values (${randomUUID()}, ${emp}, 'urlaub', '2027-05-03', '2027-05-21', 'genehmigt', 't'),
                     (${randomUUID()}, ${emp}, 'urlaub', '2027-01-04', '2027-01-08', 'genehmigt', 't')`;
    await sql`update app.employees set carry_over_leave = false where id = ${emp}`;
    const p = await leaveExitPreview(sql, emp, '2027-03-31');
    expect(p!.entitlement).toBe(7.5);
    expect(p!.taken).toBe(4); // 06.01. Feiertag
    expect(p!.rest).toBe(3.5);
    expect(p!.laterLeave).toBe(1);
    // Austritt 31.10. (zweite Jahreshälfte): 30 × 10/12 = 25 (≥ 20 gesetzlich)
    const q = await leaveExitPreview(sql, emp, '2027-10-31');
    expect(q!.entitlement).toBe(25);
    expect(q!.taken).toBe(17); // 13.05. Christi Himmelfahrt, 17.05. Pfingstmontag
  });
});
