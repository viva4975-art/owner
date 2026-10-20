import { randomUUID } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { runMonthly } from './invoices.js';
import {
  attachRedactedTimesheets,
  previewRedactedTimesheet,
  SPECIAL_STAFF_NOTE,
  timesheetSitesOf,
} from './redacted-timesheet.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const EMP = '00000000-0000-4000-8000-00000000cf01';

describe.skipIf(!available)('Geschwärzter Stundennachweis zur Rechnung', () => {
  let sql: Sql;
  let deps: Deps;
  let invoiceId: string;

  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type)
              values (${EMP}, '7791', 'Erika', 'Geheimname', '2026-01-01', 'vollzeit')`;
    for (const [day, status] of [
      ['2026-09-07', 'erfasst'],
      ['2026-09-08', 'freigegeben'],
      ['2026-09-09', 'abgelehnt'],
      ['2026-10-01', 'erfasst'],
    ] as const)
      await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
                values (${randomUUID()}, ${EMP}, ${DEMO.siteSchool}, ${day},
                        (${day}::date + time '06:00') at time zone 'Europe/Berlin',
                        (${day}::date + time '10:30') at time zone 'Europe/Berlin', 30, 'buero', ${status}, 'buero')`;
    // Unterhaltsreinigung der Schule: Stundennachweis anhängen
    await sql`update app.site_services set attach_timesheet = true
               where id = '00000000-0000-4000-8000-000000000101'`;
    const run = await runMonthly(sql, '2026-09', 'test');
    invoiceId = run.created.find((c) => c.siteName === 'Grundschule Musterweg')!.invoiceId;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('findet das Objekt mit Leistungszeitraum', async () => {
    const sites = await timesheetSitesOf(sql, invoiceId);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ site_no: '2990101', from: '2026-09-01', to: '2026-09-30' });
  });

  it('PDF: nur Zeiten im Zeitraum, Name geschwärzt, Hinweis Sonderreiniger', async () => {
    const pdf = (await previewRedactedTimesheet(sql, invoiceId))!;
    const text = (await extractText(await getDocumentProxy(pdf), { mergePages: true })).text;
    expect(text).toContain('Stundennachweis');
    expect(text).not.toContain('Geheimname');
    expect(text).not.toContain('Erika');
    expect(text).toContain('07.09.2026');
    expect(text).toContain('08.09.2026');
    expect(text).not.toContain('09.09.2026'); // abgelehnt
    expect(text).not.toContain('01.10.2026'); // außerhalb
    expect(text).toContain('8:00'); // 2 × 4:00 Std.
    expect(text.replace(/\s+/g, ' ')).toContain(SPECIAL_STAFF_NOTE.slice(0, 40));
  });

  it('hängt genau einmal an', async () => {
    expect(await attachRedactedTimesheets(deps, invoiceId, 'test')).toBe(1);
    expect(await attachRedactedTimesheets(deps, invoiceId, 'test')).toBe(0);
    const docs = await sql`select filename from app.invoice_documents
                            where invoice_id = ${invoiceId} and kind = 'attachment'`;
    expect(docs.map((d) => d.filename)).toEqual(['Stundennachweis_2990101_2026-09-01_2026-09-30.pdf']);
  });

  it('ohne Häkchen kein Stundennachweis', async () => {
    const run = await runMonthly(sql, '2026-10', 'test');
    const other = run.created.find((c) => c.siteName !== 'Grundschule Musterweg');
    if (other) expect(await timesheetSitesOf(sql, other.invoiceId)).toHaveLength(0);
  });
});
