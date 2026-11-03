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
import {
  addExtra,
  deleteExtra,
  deleteExtraDay,
  listExtraDays,
  setExtraDay,
  listExtras,
  planPersons,
  setExtraEnd,
  timesheetRows,
} from './site-timesheet.js';
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
    // Einsatzplanung: Mo + Di 06:00–10:30, 30 Min. Pause, nur 07./08.09. (= 2 × 4:00 Std.)
    for (const wd of [1, 2])
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from, valid_until)
                values (${randomUUID()}, ${EMP}, ${DEMO.siteSchool}, ${wd}, '06:00', '10:30', 30, '2026-09-07', '2026-09-08')`;
    // erfasste Zeit zählt nicht (Nachweis = Einsatzplanung)
    await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
              values (${randomUUID()}, ${EMP}, ${DEMO.siteSchool}, '2026-09-09',
                      ('2026-09-09'::date + time '06:00') at time zone 'Europe/Berlin',
                      ('2026-09-09'::date + time '10:30') at time zone 'Europe/Berlin', 30, 'buero', 'erfasst', 'buero')`;
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
    expect(text).not.toContain('09.09.2026'); // nur erfasst, nicht geplant
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

  it('berichtigte Fassung kommt zusätzlich dazu, doppelt absenden hängt nichts doppelt an', async () => {
    expect(await attachRedactedTimesheets(deps, invoiceId, 'test', '2026-10-25_120000')).toBe(1);
    expect(await attachRedactedTimesheets(deps, invoiceId, 'test', '2026-10-25_120000')).toBe(0);
    const docs = await sql`select filename from app.invoice_documents
                            where invoice_id = ${invoiceId} and kind = 'attachment' order by filename`;
    expect(docs.map((d) => d.filename)).toEqual([
      'Stundennachweis_2990101_2026-09-01_2026-09-30.pdf',
      'Stundennachweis_2990101_2026-09-01_2026-09-30_berichtigt_2026-10-25_120000.pdf',
    ]);
  });

  it('ohne Häkchen kein Stundennachweis', async () => {
    const run = await runMonthly(sql, '2026-10', 'test');
    const other = run.created.find((c) => c.siteName !== 'Grundschule Musterweg');
    if (other) expect(await timesheetSitesOf(sql, other.invoiceId)).toHaveLength(0);
  });

  it('Einsatzplanung + Nachunternehmer als Dauereintrag, auch über Mitternacht', async () => {
    const site = DEMO.siteSchool;
    const persons = await planPersons(sql, site, '2026-09-01', '2026-09-30');
    expect(persons).toEqual([
      { person: 'Person 1', times: ['Mo, Di 06:00–10:30 (Pause 30 Min.)'], shifts: 2, minutes: 480 },
    ]);
    const add = {
      token: randomUUID(),
      siteId: site,
      person: 'Nachunternehmer – Person 1',
      start: '18:30',
      end: '00:30',
      breakMinutes: 0,
      weekdays: [1, 3, 5],
      from: '2026-09-07',
      to: null,
    };
    expect(await addExtra(sql, add, 't')).toBe(1);
    expect(await addExtra(sql, add, 't')).toBe(0); // gleiches Formular doppelt
    await expect(addExtra(sql, { ...add, token: randomUUID(), end: '18:30' }, 't')).rejects.toThrow(/gleich/);
    const [x] = await listExtras(sql, site);
    // ab 07.09. Mo/Mi/Fr bis 30.09. = 11 Tage; Ende 11.09. → 3 Tage
    let rows = await timesheetRows(sql, site, '2026-09-01', '2026-09-30');
    expect(rows.filter((r) => r.source === 'nu')).toHaveLength(11);
    await setExtraEnd(sql, site, x!.id, '2026-09-11', 't');
    rows = await timesheetRows(sql, site, '2026-09-01', '2026-09-30');
    expect(rows.filter((r) => r.overnight)).toHaveLength(3);
    expect(rows.reduce((a, r) => a + r.minutes, 0)).toBe(2 * 240 + 3 * 360);
    const pdf = (await previewRedactedTimesheet(sql, invoiceId))!;
    const text = (await extractText(await getDocumentProxy(pdf), { mergePages: true })).text;
    expect(text).not.toContain('Person 1'); // geschwärzt
    expect(text).not.toContain('Nachunternehmer');
    expect(text).toContain('00:30 (+1)');
    expect(text).not.toContain('Geheimname');
    expect(text).toContain('26:00'); // 8:00 + 18:00
    // Abweichende Tage: Mi 09.09. nicht ausgeführt, Fr 11.09. 19:00–21:00, Sa 12.09. liegt nach dem Ende → abgelehnt
    await setExtraDay(sql, { siteId: site, extraId: x!.id, day: '2026-09-09', kind: 'entfaellt' }, 't');
    await setExtraDay(
      sql,
      {
        siteId: site,
        extraId: x!.id,
        day: '2026-09-11',
        kind: 'anders',
        start: '19:00',
        end: '21:00',
        breakMinutes: 15,
      },
      't',
    );
    await expect(
      setExtraDay(sql, { siteId: site, extraId: x!.id, day: '2026-09-12', kind: 'entfaellt' }, 't'),
    ).rejects.toThrow(/außerhalb/);
    rows = await timesheetRows(sql, site, '2026-09-01', '2026-09-30');
    const nu = rows.filter((r) => r.source === 'nu');
    expect(nu.map((r) => r.date)).toEqual(['2026-09-07', '2026-09-11']);
    expect(nu[1]).toMatchObject({ start: '19:00', end: '21:00', brk: 15, minutes: 105, overnight: false });
    // gleicher Tag erneut = ersetzt; Entfernen = wieder wie geplant
    await setExtraDay(sql, { siteId: site, extraId: x!.id, day: '2026-09-11', kind: 'entfaellt' }, 't');
    const days = (await listExtraDays(sql, site)).get(x!.id)!;
    expect(days.size).toBe(2);
    expect(await deleteExtraDay(sql, site, days.get('2026-09-09')!.id, 't')).toBe(1);
    rows = await timesheetRows(sql, site, '2026-09-01', '2026-09-30');
    expect(rows.filter((r) => r.source === 'nu').map((r) => r.date)).toEqual(['2026-09-07', '2026-09-09']);
    expect(await deleteExtra(sql, site, x!.id, 't')).toBe(1);
    expect(await timesheetRows(sql, site, '2026-09-01', '2026-09-30')).toHaveLength(2);
  });
});
