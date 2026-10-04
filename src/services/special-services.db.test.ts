import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { getInvoice } from './invoices.js';
import { getWorkReport } from './orders.js';
import { DEMO } from './seed.js';
import {
  addMonths,
  cancelRun,
  completeRun,
  getRun,
  getSpecialService,
  listSpecialServices,
  noticePdf,
  planRun,
  runToInvoice,
  saveSpecialService,
} from './special-services.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe('Monate addieren', () => {
  it('kappt am Monatsende', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-08-15', 6)).toBe('2027-02-15');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });
});

describe.skipIf(!available)('Sonderdienste (Glasreinigung, Tiefgarage)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const svc = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const input = (over = {}) => ({
    siteId: DEMO.siteSchool,
    kind: 'tiefgarage' as const,
    title: 'Tiefgaragenreinigung nass',
    scope: '42 Stellplätze, Kehrsaugmaschine',
    intervalMonths: 12,
    nextDue: addDays(todayBerlin(), -3),
    priceCents: 89000n,
    vatRateBp: 1900,
    noticeDays: 14,
    active: true,
    note: null,
    expectedVersion: null,
    ...over,
  });

  it('anlegen, als fällig gelistet, Prüfungen', async () => {
    await expect(saveSpecialService(sql, randomUUID(), input({ intervalMonths: 0 }), 't')).rejects.toThrow(
      /Intervall/,
    );
    await saveSpecialService(sql, svc, input(), 't');
    const rows = await listSpecialServices(sql);
    expect(rows.map((r) => r.id)).toContain(svc);
    expect(rows.find((r) => r.id === svc)!.days_left).toBe(-3);
    expect(await listSpecialServices(sql, { scope: [] })).toEqual([]);
  });

  it('Termin: nur einer offen, Verschieben nach Aushang setzt zurück auf „geplant“, Aushang-PDF', async () => {
    const run = randomUUID();
    const today = todayBerlin();
    await planRun(
      sql,
      run,
      svc,
      { date: today, start: '06:00', end: '10:00', employeeIds: [], note: null, expectedVersion: null },
      't',
    );
    await expect(
      planRun(
        sql,
        randomUUID(),
        svc,
        { date: today, start: null, end: null, employeeIds: [], note: null, expectedVersion: null },
        't',
      ),
    ).rejects.toThrow(/offenen Termin/);
    await sql`update app.special_service_runs set status = 'angekuendigt', announced_at = now() where id = ${run}`;
    const r1 = (await getRun(sql, run))!;
    await planRun(
      sql,
      run,
      svc,
      {
        date: addDays(today, 1),
        start: '06:00',
        end: '10:00',
        employeeIds: [],
        note: null,
        expectedVersion: r1.version,
      },
      't',
    );
    expect((await getRun(sql, run))!.status).toBe('geplant');
    await planRun(
      sql,
      run,
      svc,
      { date: today, start: '06:00', end: '10:00', employeeIds: [], note: null, expectedVersion: null },
      't',
    );
    const pdf = await PDFDocument.load(await noticePdf(sql, run));
    expect(pdf.getPageCount()).toBe(1);
  });

  it('erledigt → Arbeitsschein, nächste Fälligkeit + 12 Monate; doppelt → nichts doppelt; Rechnung einmal', async () => {
    const [first] = await sql<
      { id: string }[]
    >`select id from app.special_service_runs where special_service_id = ${svc}`;
    const run = first!.id;
    const wr1 = await completeRun(sql, run, 't');
    const wr2 = await completeRun(sql, run, 't');
    expect(wr2).toBe(wr1);
    const w = (await getWorkReport(sql, wr1))!;
    expect(w.report.description).toContain('Tiefgaragenreinigung');
    const s = (await getSpecialService(sql, svc))!.service;
    expect(s.next_due).toBe(addMonths(todayBerlin(), 12));
    const inv1 = await runToInvoice(deps, run, 't');
    const inv2 = await runToInvoice(deps, run, 't');
    expect(inv2).toBe(inv1);
    const inv = (await getInvoice(sql, inv1))!;
    expect(inv.invoice.net_cents).toBe(89000n);
    expect(inv.lines[0]!.detail).toContain('ausgeführt am');
    await expect(cancelRun(sql, run, 'Regen', 't')).rejects.toThrow(/offene/);
  });

  it('Absage braucht Grund; danach neuer Termin möglich', async () => {
    const run = randomUUID();
    await planRun(
      sql,
      run,
      svc,
      {
        date: addDays(todayBerlin(), 30),
        start: null,
        end: null,
        employeeIds: [],
        note: null,
        expectedVersion: null,
      },
      't',
    );
    await expect(cancelRun(sql, run, '', 't')).rejects.toThrow(/Grund/);
    await cancelRun(sql, run, 'Objekt gesperrt', 't');
    await expect(completeRun(sql, run, 't')).rejects.toThrow(/abgesagt/);
    await planRun(
      sql,
      randomUUID(),
      svc,
      {
        date: addDays(todayBerlin(), 31),
        start: null,
        end: null,
        employeeIds: [],
        note: null,
        expectedVersion: null,
      },
      't',
    );
  });
});
