import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { syncExitReturnTasks } from './exit-returns.js';
import { bookStock, closeHandoverWithoutSignature, saveHandover, type HandoverInput } from './handovers.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import { createUser } from './users.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const SHIRT = '00000000-0000-4000-8000-0000000c7001';

describe.skipIf(!available)('Austritt: Arbeitskleidung zurückholen', () => {
  let sql: Sql;
  let deps: Deps;
  let emp: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    emp = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, 'T951', 'Ana', 'Austritt', '2026-01-01')`;
    await sql`insert into app.employee_sites (employee_id, site_id) values (${emp}, ${DEMO.siteSchool})`;
    const { id: uid } = await createUser(
      sql,
      {
        login: 'olga.r',
        name: 'Olga Rückgabe',
        email: null,
        role: 'objektleitung',
        password: 'Start12345x',
        mustChange: false,
      },
      'ahmed',
    );
    await sql`update app.sites set manager_user_id = ${uid} where id = ${DEMO.siteSchool}`;
    await bookStock(
      sql,
      { id: randomUUID(), articleId: SHIRT, size: 'M', delta: 10, reason: 'zugang', note: null },
      't',
    );
  });
  afterAll(async () => {
    await sql?.end();
  });

  const input = (dir: 'ausgabe' | 'rueckgabe'): HandoverInput => ({
    kind: 'kleidung',
    direction: dir,
    employeeId: emp,
    supplierId: null,
    recipientName: null,
    siteId: DEMO.siteSchool,
    date: todayBerlin(),
    title: null,
    items: [{ label: '', article_id: SHIRT, size: 'M', qty: 2 }],
    bodyText: null,
    wageDeduction: false,
    relatedId: null,
    note: null,
    issuerName: 'Test',
  });

  it('Aufgabe für Büro + Objektleitung vor dem Austritt, erledigt sich nach der Rückgabe', async () => {
    // Auf Papier unterschrieben → nur hinterlegen (abschließen ohne Handy-Unterschrift)
    const out = randomUUID();
    await saveHandover(deps, out, input('ausgabe'), 't');
    await closeHandoverWithoutSignature(deps, out, 'Auf Papier unterschrieben', 't');

    // Austritt weit in der Zukunft → noch keine Aufgabe
    await sql`update app.employees set exit_date = ${addDays(todayBerlin(), 400)} where id = ${emp}`;
    expect((await syncExitReturnTasks(sql)).created).toBe(0);

    const exit = addDays(todayBerlin(), 20);
    await sql`update app.employees set exit_date = ${exit} where id = ${emp}`;
    expect((await syncExitReturnTasks(sql)).created).toBe(2);
    expect((await syncExitReturnTasks(sql)).created).toBe(0); // nichts doppelt
    const tasks = await sql<{ assignee: string | null; title: string; due_date: string; status: string }[]>`
      select assignee, title, due_date::text, status from app.tasks
       where entity_type = 'employee' and entity_id = ${emp} order by assignee nulls first`;
    expect(tasks.map((t) => t.assignee)).toEqual([null, 'Olga Rückgabe']);
    expect(tasks[0]!.title).toMatch(/Arbeitskleidung zurückholen: Ana Austritt/);
    expect(tasks[0]!.due_date).toBe(exit);

    // Rückgabe erfasst → Aufgaben erledigt
    const back = randomUUID();
    await saveHandover(deps, back, { ...input('rueckgabe'), relatedId: out }, 't');
    await closeHandoverWithoutSignature(deps, back, 'Auf Papier unterschrieben', 't');
    expect((await syncExitReturnTasks(sql)).closed).toBe(2);
    const open = await sql`select 1 from app.tasks where entity_id = ${emp} and status = 'open'`;
    expect(open).toHaveLength(0);
  });
});
