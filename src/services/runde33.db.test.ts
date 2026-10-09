import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { feedIcs, feedToken } from './calendar-feed.js';
import { siteCosting } from './costing.js';
import { deleteDraft, getInvoice, saveDraft } from './invoices.js';
import {
  billableOrders,
  closeWithoutSignature,
  deleteWorkReport,
  dropWorkReportRequirement,
  getWorkReport,
  invoiceWorkReports,
  listWorkReports,
  reopenWorkReport,
  orderToInvoice,
  reportsToInvoice,
  saveOrder,
  saveWorkReport,
  setWorkReportDone,
  signWorkReport,
  workReportFromInvoice,
} from './orders.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { type Deps, issueInvoice } from './workflow.js';

const available = await dbAvailable();
const EMP = '00000000-0000-4000-8000-0000000033a1';

describe.skipIf(!available)(
  'Runde 33: Arbeitsschein-Pflicht, Einzelaufträge, Regie-Zeiten, NU in der Nachkalkulation',
  () => {
    let sql: Sql;
    let deps: Deps & { mailer: FakeMailer };
    let png: Uint8Array;
    beforeAll(async () => {
      sql = await freshDatabase();
      deps = await testDeps(sql);
      png = new Uint8Array(await QRCode.toBuffer('Unterschrift', { type: 'png', width: 200 }));
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, weekly_hours)
              values (${EMP}, '3301', 'Vera', 'Vorarbeiter', '2026-01-01', 39)`;
    });
    afterAll(async () => {
      await sql?.end();
    });

    const draft = async () => {
      const id = randomUUID();
      await saveDraft(
        sql,
        id,
        {
          customerId: DEMO.authority,
          siteId: DEMO.siteSchool,
          kind: 'invoice',
          periodStart: '2026-10-05',
          periodEnd: '2026-10-05',
          orderReference: null,
          introText: null,
          closingText: null,
          lines: [
            {
              description: 'Sonderreinigung Aula',
              quantity: parseQuantity('1'),
              unitCode: 'LS',
              unitPrice: parseEuro('480,00'),
              vatRate: 1900,
            },
          ],
        },
        't',
      );
      return id;
    };

    it('Arbeitsschein aus Rechnungsentwurf: Ausstellen gesperrt bis zur Unterschrift, PDF hängt dann an', async () => {
      const inv = await draft();
      const wr = await workReportFromInvoice(sql, inv, 't');
      expect(await workReportFromInvoice(sql, inv, 't')).toBe(wr); // doppelt → derselbe Schein
      const w = (await getWorkReport(sql, wr))!;
      expect(w.report.site_id).toBe(DEMO.siteSchool);
      expect(w.lines.map((l) => l.description)).toEqual(['Sonderreinigung Aula']);
      expect((await getInvoice(sql, inv))!.invoice.work_report_required).toBe(true);
      await expect(issueInvoice(deps, inv, 't')).rejects.toThrow(/noch nicht vom Kunden unterschrieben/);
      await signWorkReport(deps, wr, { name: 'Hausmeister Kurz', png }, 't');
      const [doc] = await sql<{ filename: string }[]>`
      select filename from app.invoice_documents where invoice_id = ${inv} and kind = 'attachment'`;
      expect(doc!.filename).toMatch(/^Arbeitsschein_AS-/);
      expect((await invoiceWorkReports(sql, inv))[0]!.attached).toBe(true);
      // Entwurf mit Anhang lässt sich löschen (Fund 09.10.), Schein wird wieder frei
      await deleteDraft(sql, inv, 't');
      const after = (await getWorkReport(sql, wr))!.report;
      expect(after.invoice_id).toBeNull();
      expect(after.draft_invoice_id).toBeNull();
    });

    it('Pflicht aufheben nur mit Grund', async () => {
      const inv = await draft();
      await workReportFromInvoice(sql, inv, 't');
      await expect(dropWorkReportRequirement(sql, inv, ' ', 't')).rejects.toThrow(/Grund/);
      await dropWorkReportRequirement(sql, inv, 'Kunde unterschreibt nicht digital', 't');
      expect((await getInvoice(sql, inv))!.invoice.work_report_required).toBe(false);
    });

    it('Rechnung aus Arbeitsschein: Regiestunden je Person zusammengefasst, Uhrzeit/Pause gespeichert', async () => {
      const wr = randomUUID();
      const base = { description: 'Regiestunden Grundreinigung', unitCode: 'HUR' };
      await saveWorkReport(
        sql,
        wr,
        {
          orderId: null,
          siteId: DEMO.siteSchool,
          workDate: '2026-10-06',
          startTime: null,
          endTime: null,
          employeeIds: [],
          description: 'Grundreinigung',
          materials: null,
          remarks: null,
          lines: [
            {
              ...base,
              quantity: parseQuantity('3,5'),
              person: 'Anna A',
              timeFrom: '07:00',
              timeTo: '11:00',
              breakMinutes: 30,
            },
            { ...base, quantity: parseQuantity('4'), person: 'Bernd B' },
          ],
          expectedVersion: null,
        },
        't',
      );
      const w = (await getWorkReport(sql, wr))!;
      expect([w.lines[0]!.time_from, w.lines[0]!.time_to, w.lines[0]!.break_minutes]).toEqual([
        '07:00',
        '11:00',
        30,
      ]);
      expect(w.lines[1]!.time_from).toBeNull();
      await closeWithoutSignature(deps, wr, '', 't');
      const inv = await reportsToInvoice(deps, DEMO.siteSchool, [wr], 't');
      const d = (await getInvoice(sql, inv))!;
      expect(d.lines.map((l) => [l.description, l.quantity_milli])).toEqual([
        ['Regiestunden Grundreinigung', 7500n],
      ]);
      expect(d.lines[0]!.description).not.toMatch(/Anna|Bernd/);
    });

    it('Arbeitsschein einzeln erledigt; abgeschlossenen Schein löscht nur Admin', async () => {
      const wr = randomUUID();
      await saveWorkReport(
        sql,
        wr,
        {
          orderId: null,
          siteId: DEMO.siteSchool,
          workDate: '2026-10-07',
          startTime: null,
          endTime: null,
          employeeIds: [],
          description: 'Kleinreparatur',
          materials: null,
          remarks: null,
          lines: [],
          expectedVersion: null,
        },
        't',
      );
      await expect(setWorkReportDone(sql, wr, true, null, 't')).rejects.toThrow(/abschließen/);
      await closeWithoutSignature(deps, wr, '', 't');
      await setWorkReportDone(sql, wr, true, 'in Pauschale', 't');
      const unbilled = await listWorkReports(sql, { siteId: DEMO.siteSchool, unbilled: true });
      expect(unbilled.some((r) => r.id === wr)).toBe(false);
      await setWorkReportDone(sql, wr, false, null, 't');
      expect(
        (await listWorkReports(sql, { siteId: DEMO.siteSchool, unbilled: true })).some((r) => r.id === wr),
      ).toBe(true);
      await expect(deleteWorkReport(sql, wr, 't')).rejects.toThrow(/Admin/);
      await deleteWorkReport(sql, wr, 't', { admin: true });
      expect(await getWorkReport(sql, wr)).toBeUndefined();
    });

    it('Einzelauftrag ohne Objekt: Termin im Kalender-Abo, Arbeitsschein für das Team, in „Aus Einzelleistungen“', async () => {
      const oid = randomUUID();
      await saveOrder(
        sql,
        oid,
        {
          customerId: DEMO.authority,
          siteId: null,
          offerId: null,
          title: 'Treppenhausreinigung nach Wasserschaden',
          description: 'Schlüssel beim Hausmeister',
          orderReference: '4500123',
          plannedDate: '2026-10-20',
          lines: [
            {
              description: 'Sonderreinigung Treppenhaus',
              quantity: parseQuantity('1'),
              unitCode: 'LS',
              unitPrice: parseEuro('260,00'),
              vatRate: 1900,
            },
          ],
          expectedVersion: null,
          place: 'Hansastr. 12, 80686 München',
          startTime: '08:00',
          endTime: '10:00',
          employeeIds: [EMP],
          workReportRequired: true,
        },
        't',
      );
      const reports = await listWorkReports(sql, { orderId: oid });
      expect(reports).toHaveLength(1);
      expect(reports[0]!.employee_ids).toEqual([EMP]);
      expect(reports[0]!.site_name).toBe('Allgemein');
      const bill = await billableOrders(sql);
      expect(bill.find((o) => o.id === oid)?.place).toBe('Hansastr. 12, 80686 München');
      // Kalender-Abo der Mitarbeiterin (Zeitraum relativ zu heute → Termin passend legen)
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
      await sql`update app.orders set planned_date = ${today} where id = ${oid}`;
      const ics = (await feedIcs(sql, await feedToken(sql, { employeeId: EMP })))!.ics;
      expect(ics).toContain(`UID:auftrag-${oid}`);
      expect(ics).toContain('Hansastr. 12');
      // Rechnung: Entwurf entsteht, Ausstellen erst mit unterschriebenem Arbeitsschein
      const inv = await orderToInvoice(deps, oid, 't');
      expect((await getInvoice(sql, inv))!.invoice.work_report_required).toBe(true);
      await expect(issueInvoice(deps, inv, 't')).rejects.toThrow(/nicht vom Kunden unterschrieben/);
      expect((await billableOrders(sql)).some((o) => o.id === oid)).toBe(false);
    });

    it('Nachkalkulation: Lohn ohne Vergütung = niedrigster Tariflohn; NU-Pauschale laut Bestellung', async () => {
      await sql`insert into app.wage_levels (id, name, hourly_wage_cents, active) values (${randomUUID()}, 'Tariflohn 1', 1500, true)
              on conflict do nothing`;
      await sql`insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, created_by)
              values (${randomUUID()}, ${EMP}, ${DEMO.siteSchool}, '2026-09-10',
                      '2026-09-10 06:00 Europe/Berlin', '2026-09-10 10:00 Europe/Berlin', 0, 'buero', 'freigegeben', 't')`;
      const sup = randomUUID();
      await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79901', 'Glas Sub GmbH', 'nachunternehmer')`;
      await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, status, billing,
                                            price_cents, valid_from, created_by)
              values (${randomUUID()}, 'BE-2026-9901', ${sup}, ${DEMO.siteSchool}, 'Glasreinigung', 'monatlich', 'erteilt',
                      'pauschale_monat', 50000, '2026-01-01', 't')`;
      const { rows } = await siteCosting(sql, '2026-09', DEMO.siteSchool);
      const r = rows.find((x) => x.site_id === DEMO.siteSchool)!;
      expect(r.labor).toBeGreaterThan(0n);
      expect(r.subcontractor_estimated).toBe(50000n);
      expect(r.subcontractor).toBeGreaterThanOrEqual(50000n);
    });

    it('Arbeitsschein wieder bearbeiten: unterschrieben → Entwurf, aus dem Rechnungsentwurf gelöst, neu unterschreiben hängt wieder an', async () => {
      const inv = await draft();
      const wr = await workReportFromInvoice(sql, inv, 't');
      await signWorkReport(deps, wr, { name: 'Frau Alt', png }, 't');
      expect((await invoiceWorkReports(sql, inv))[0]!.attached).toBe(true);
      await reopenWorkReport(sql, wr, 't');
      const w = (await getWorkReport(sql, wr))!.report;
      expect([w.status, w.signed_by_name, w.pdf_path, w.invoice_id]).toEqual(['entwurf', null, null, null]);
      expect(w.draft_invoice_id).toBe(inv);
      const docs =
        await sql`select 1 from app.invoice_documents where invoice_id = ${inv} and kind = 'attachment'`;
      expect(docs.length).toBe(0);
      await expect(issueInvoice(deps, inv, 't')).rejects.toThrow(/nicht vom Kunden unterschrieben/);
      // geändert und neu unterschrieben → hängt wieder an
      const cur = (await getWorkReport(sql, wr))!;
      await saveWorkReport(
        sql,
        wr,
        {
          orderId: null,
          siteId: cur.report.site_id,
          workDate: cur.report.work_date,
          startTime: null,
          endTime: null,
          employeeIds: [],
          description: 'geändert',
          materials: null,
          remarks: null,
          lines: [],
          expectedVersion: cur.report.version,
        },
        't',
      );
      await signWorkReport(deps, wr, { name: 'Frau Neu', png }, 't');
      expect((await getWorkReport(sql, wr))!.report.signed_by_name).toBe('Frau Neu');
      expect((await invoiceWorkReports(sql, inv))[0]!.attached).toBe(true);
      const [log] = await sql<{ details: { signed_by_name: string } }[]>`
        select details from app.audit_log where entity_id = ${wr} and action = 'reopen'`;
      expect(log!.details.signed_by_name).toBe('Frau Alt');
    });
  },
);
