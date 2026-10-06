import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { workingDays } from '../domain/time/holidays.js';
import { leaveBalance, requestAbsence } from './absences.js';
import {
  allTags,
  effectiveWage,
  employeeInput,
  fillTemplate,
  getEmployee,
  listEmployees,
  saveEmployee,
  saveWageLevel,
} from './employees.js';
import { createFromTemplate, serialLetter } from './hr-docs.js';
import { sollPlanIst } from './hr-month.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { saveShiftPlan } from './time.js';
import { listFiles } from './uploads.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const TEMPLATE = '00000000-0000-4000-8000-0000000c1001'; // Bescheinigung über das Beschäftigungsverhältnis

describe.skipIf(!available)('Personal wie Fortytools', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const amar = randomUUID();
  const lena = randomUUID();
  const level = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const emp = (id: string, over: Record<string, string>) =>
    saveEmployee(
      sql,
      id,
      employeeInput.parse({
        personnel_no: '',
        first_name: '',
        last_name: '',
        employment_type: 'teilzeit',
        entry_date: '2025-01-01',
        exit_date: '',
        weekly_hours: '30',
        hourly_wage: '',
        phone: '',
        email: '',
        languages: '',
        version: '',
        private_version: '',
        annual_leave_days: '30',
        carry_over_leave: 'on',
        street: 'Hauptstr. 12',
        postal_code: '84101',
        city: 'Obersüßbach',
        birth_date: '2003-01-01',
        ...over,
      }),
      'test',
    );

  it('Stammdaten mit Anrede, Tags, Warnhinweis; Lohnstufe als wirksamer Lohn', async () => {
    await saveWageLevel(sql, level, {
      name: 'Stundenlohn Tarif 1 NEU',
      wageCents: 1450n,
      validFrom: '2026-01-01',
      note: null,
      active: true,
      expectedVersion: null,
    });
    await emp(amar, {
      personnel_no: '1392',
      first_name: 'Amar',
      last_name: 'Abas',
      salutation: 'Herr',
      tags: 'Teilzeit, Objektleitung, Teilzeit',
      warning_note: 'kein Einsatz in Schulen',
      wage_level_id: level,
      birth_place: 'Damaskus',
      marital_status: 'ledig',
    });
    await emp(lena, {
      personnel_no: '1393',
      first_name: 'Lena',
      last_name: 'Berg',
      salutation: 'Frau',
      tags: 'Minijob',
      employment_type: 'minijob',
      hourly_wage: '15,00',
      carry_over_leave: '',
    });
    const a = (await getEmployee(sql, amar))!;
    expect(a.employee.tags).toEqual(['Teilzeit', 'Objektleitung']);
    expect(a.employee.warning_note).toBe('kein Einsatz in Schulen');
    expect(a.priv!.birth_place).toBe('Damaskus');
    expect(await effectiveWage(sql, amar)).toBe(1450n);
    expect(await effectiveWage(sql, lena)).toBe(1500n); // individuell vor Stufe
    expect((await listEmployees(sql, { tag: 'Objektleitung' })).map((e) => e.personnel_no)).toEqual(['1392']);
    expect((await allTags(sql)).map((t) => t.tag)).toEqual(['Minijob', 'Objektleitung', 'Teilzeit']);
  });

  it('Vorlage: Platzhalter, Ablage als Personaldokument (einmal), Serienbrief mit einer Seite je Person', async () => {
    const a = (await getEmployee(sql, amar))!;
    expect(fillTemplate('{{anrede_name}}, {{eintritt}}, {{unbekannt}}', a.employee, a.priv)).toBe(
      'Herr Amar Abas, 01.01.2025, {{unbekannt}}',
    );
    const fid = randomUUID();
    const cfg = { dir: deps.env.FILES_DIR, maxBytes: 1e9 };
    await createFromTemplate(deps, cfg, fid, TEMPLATE, amar, 'test');
    await createFromTemplate(deps, cfg, fid, TEMPLATE, amar, 'test');
    const files = await listFiles(sql, { type: 'employee', id: amar });
    expect(files).toHaveLength(1);
    expect(files[0]!.category).toBe('Bescheinigung');
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const pdf = await PDFDocument.load(await serialLetter(deps, TEMPLATE, [amar, lena]));
    expect(pdf.getPageCount()).toBe(2);
  });

  it('Soll/Plan/Ist im Monat', async () => {
    await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: amar,
        siteId: DEMO.siteSchool,
        weekdays: [1, 2, 3, 4, 5],
        startTime: '07:00',
        endTime: '13:00',
        breakMinutes: 0,
        validFrom: '2025-01-01',
        validUntil: null,
        note: null,
      },
      'test',
    );
    await sql`update app.shift_plans set created_at = '2025-01-01' where employee_id = ${amar}`;
    const r = await sollPlanIst(sql, amar, '2025-09');
    const days = workingDays('2025-09-01', '2025-09-30');
    expect(r.soll).toBe(6 * 60 * days); // 30 Std./Woche = 6 Std. je Arbeitstag
    expect(r.plan).toBe(6 * 60 * days);
    expect(r.ist).toBe(0);
  });

  it('Resturlaub: Übertrag aus dem Vorjahr, Verbrauch im 1. Quartal, Rest verfällt nach dem 31.03.', async () => {
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: amar,
      kind: 'urlaub',
      start: '2025-08-04',
      end: '2025-08-29',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    });
    const taken2025 = workingDays('2025-08-04', '2025-08-29'); // 20
    await requestAbsence(sql, {
      id: randomUUID(),
      employeeId: amar,
      kind: 'urlaub',
      start: '2026-02-16',
      end: '2026-02-18',
      halfDay: false,
      note: null,
      actor: 't',
      approved: true,
    });
    const b = await leaveBalance(sql, amar, 2026);
    expect(b.carried).toBe(30 - taken2025);
    expect(b.carriedExpired).toBe(30 - taken2025 - 3); // Heute liegt nach dem 31.03.2026
    expect(b.rest).toBe(30 + b.carried - b.carriedExpired - 3);
    // ohne Übertrag-Einstellung kein Übertrag
    expect((await leaveBalance(sql, lena, 2026)).carried).toBe(0);
  });
});
