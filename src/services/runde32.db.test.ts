import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import type { Cents, Quantity } from '../domain/money/money.js';
import { feedIcs, feedToken } from './calendar-feed.js';
import { getInvoice, patchDraft, saveDraft } from './invoices.js';
import { payrollMonth } from './payroll.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { plannedShifts, saveShiftSeries } from './time.js';

const available = await dbAvailable();
const EMP = '00000000-0000-4000-8000-0000000003e1';

describe.skipIf(!available)(
  'Runde 32: Entwurf direkt ändern, Sonn-/Feiertage am Einsatz, Kalender-Abo',
  () => {
    let sql: Sql;
    beforeAll(async () => {
      sql = await freshDatabase();
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours, hourly_wage_cents)
              values (${EMP}, '3201', 'Sina', 'Sonntag', '2026-01-01', 20, 1500)`;
    });
    afterAll(async () => {
      await sql?.end();
    });

    it('Entwurf: Anschrift, Text und einzelne Position direkt ändern (Versionsschutz)', async () => {
      const id = randomUUID();
      await saveDraft(
        sql,
        id,
        {
          customerId: DEMO.company,
          siteId: null,
          kind: 'invoice',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          orderReference: null,
          introText: null,
          closingText: null,
          lines: [
            {
              description: 'A',
              quantity: 1000n as Quantity,
              unitCode: 'C62',
              unitPrice: 1000n as Cents,
              vatRate: 1900,
            },
            {
              description: 'B',
              quantity: 2000n as Quantity,
              unitCode: 'HUR',
              unitPrice: 2500n as Cents,
              vatRate: 1900,
            },
          ],
        },
        't',
      );
      let inv = (await getInvoice(sql, id))!.invoice;
      await patchDraft(
        sql,
        id,
        {
          what: 'position',
          index: 1,
          line: {
            description: 'B neu\nzweite Zeile',
            quantity: 3500n as Quantity,
            unitCode: 'HUR',
            unitPrice: 2980n as Cents,
          },
        },
        inv.version,
        't',
      );
      // veralteter Stand (anderer Tab) wird abgelehnt
      await expect(
        patchDraft(sql, id, { what: 'einleitung', text: 'x' }, inv.version, 't'),
      ).rejects.toThrow();
      inv = (await getInvoice(sql, id))!.invoice;
      await patchDraft(
        sql,
        id,
        {
          what: 'anschrift',
          billAddress: {
            name: 'Neu GmbH',
            name2: null,
            contactName: null,
            street: 'Weg 1',
            postalCode: '80331',
            city: 'München',
          },
        },
        inv.version,
        't',
      );
      inv = (await getInvoice(sql, id))!.invoice;
      await patchDraft(sql, id, { what: 'position_loeschen', index: 0 }, inv.version, 't');
      const d = (await getInvoice(sql, id))!;
      expect(d.lines.map((l) => [l.description, l.quantity_milli, l.net_cents])).toEqual([
        ['B neu\nzweite Zeile', 3500n, 10430n],
      ]);
      expect(d.invoice.net_cents).toBe(10430n);
      expect(d.invoice.bill_address?.name).toBe('Neu GmbH');
      await expect(
        patchDraft(sql, id, { what: 'position_loeschen', index: 0 }, d.invoice.version, 't'),
      ).rejects.toThrow(/letzte Position/);
    });

    it('Feiertag ohne Haken = frei (bezahlt), Zuschläge nur mit Haken', async () => {
      // Montag-Einsatz ohne Haken: Ostermontag 06.04.2026 frei; Zeit an dem Tag ohne Feiertagszuschlag
      await saveShiftSeries(
        sql,
        randomUUID(),
        {
          siteId: DEMO.siteSchool,
          employeeIds: [EMP],
          recurrence: 'woechentlich',
          every: 1,
          weekdays: [1],
          months: null,
          startTime: '06:00',
          endTime: '08:00',
          breakMinutes: 0,
          validFrom: '2026-03-30',
          validUntil: '2026-04-13',
          note: null,
          planningGroup: null,
        },
        't',
      );
      // Soll zählt erst ab Anlage → für den Test rückdatieren
      await sql`update app.shift_plans set created_at = '2026-01-01' where employee_id = ${EMP}`;
      const sh = await plannedShifts(sql, { from: '2026-04-06', to: '2026-04-06', employeeId: EMP });
      expect(sh[0]?.holiday).toBe('Ostermontag');
      await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
              values (${randomUUID()}, ${EMP}, ${DEMO.siteSchool}, '2026-04-06',
                      '2026-04-06 06:00 Europe/Berlin', '2026-04-06 08:00 Europe/Berlin', 0, 'buero', 'freigegeben', 't')`;
      let p = (await payrollMonth(sql, '2026-04', EMP))[0]!;
      expect(p.minutes.feiertag).toBe(0);
      expect(p.uncoveredSundayHolidayMinutes).toBe(120);
      // Sonntags-Einsatz (immer mit Haken) und Montag mit Haken → Zuschläge
      await saveShiftSeries(
        sql,
        randomUUID(),
        {
          siteId: DEMO.siteSchool,
          employeeIds: [EMP],
          recurrence: 'woechentlich',
          every: 1,
          weekdays: [1, 7],
          months: null,
          startTime: '06:00',
          endTime: '08:00',
          breakMinutes: 0,
          validFrom: '2026-04-05',
          validUntil: '2026-04-12',
          note: null,
          planningGroup: null,
          holidayWork: true,
        },
        't',
      );
      await sql`update app.shift_plans set created_at = '2026-01-01' where employee_id = ${EMP}`;
      const [sun] = await sql<{ holiday_work: boolean }[]>`
      select holiday_work from app.shift_plans where employee_id = ${EMP} and weekday = 7`;
      expect(sun!.holiday_work).toBe(true);
      p = (await payrollMonth(sql, '2026-04', EMP))[0]!;
      expect(p.minutes.feiertag + p.minutes.feiertag_hoch).toBe(120);
      expect(p.uncoveredSundayHolidayMinutes).toBe(0);
    });

    it('Kalender-Abo: ICS mit Einsätzen, falscher Link → nichts', async () => {
      const token = await feedToken(sql, { employeeId: EMP });
      expect(await feedToken(sql, { employeeId: EMP })).toBe(token);
      const r = await feedIcs(sql, token);
      expect(r!.ics).toMatch(/^BEGIN:VCALENDAR/);
      expect(r!.ics).toContain('BEGIN:VTIMEZONE');
      expect(r!.ics.split('\r\n').every((l) => l.length <= 75)).toBe(true);
      const renewed = await feedToken(sql, { employeeId: EMP }, true);
      expect(renewed).not.toBe(token);
      expect(await feedIcs(sql, token)).toBeNull();
      expect(await feedIcs(sql, 'x'.repeat(40))).toBeNull();
    });
  },
);
