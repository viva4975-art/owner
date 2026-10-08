import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { monthPdf } from './cashbook.js';
import { siteCosting } from './costing.js';
import { saveException } from './planning.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import QRCode from 'qrcode';
import { signSubcontract } from './subcontractors.js';

const available = await dbAvailable();

describe.skipIf(!available)('Runde 31 (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Nachkalkulation = Kostenstellen: Fortytools-Erlös, inaktive Objekte mit Kosten, allgemeine Kostenstellen', async () => {
    const inactive = randomUUID();
    await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city, active)
              select ${inactive}, customer_id, '9999901', 'Altobjekt', 'Weg 1', '80331', 'München', false
                from app.sites where id = ${DEMO.siteSchool}`;
    const sup = randomUUID();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79311', 'NU Test', 'nachunternehmer')`;
    const inv = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents, gross_cents, category, created_by)
              values (${inv}, ${sup}, 'NU-1', '2026-09-30', '2026-10-30', 80000, 0, 80000, 'nachunternehmer', 't')`;
    const [cc] = await sql<{ id: string }[]>`select id from app.cost_centers where number = '9000'`;
    await sql`delete from app.cost_allocations where incoming_invoice_id = ${inv}`;
    await sql`insert into app.cost_allocations (id, incoming_invoice_id, site_id, cost_center_id, month, net_cents, created_by)
              values (${randomUUID()}, ${inv}, ${inactive}, null, '2026-09-01', 50000, 't'),
                     (${randomUUID()}, ${inv}, null, ${cc!.id}, '2026-09-01', 30000, 't')`;
    // übernommene Fortytools-Rechnung mit Leistungszeitraum September
    const li = randomUUID();
    await sql`insert into app.legacy_invoices (id, number, issue_date, net_cents, gross_cents, paid)
              values (${li}, 'FT-31', '2026-10-01', 120000, 142800, false)`;
    await sql`insert into app.legacy_invoice_lines (id, invoice_id, position, quantity_milli, unit_price_cents, net_cents, period_start, period_end, site_id)
              values (${randomUUID()}, ${li}, 1, 1000, 120000, 120000, '2026-09-01', '2026-09-30', ${DEMO.siteSchool})`;

    const r = await siteCosting(sql, { from: '2026-09', to: '2026-09' });
    const school = r.rows.find((x) => x.site_id === DEMO.siteSchool)!;
    expect(school.revenue).toBeGreaterThanOrEqual(120000n);
    const old = r.rows.find((x) => x.site_id === inactive)!;
    expect(old.subcontractor).toBe(50000n);
    expect(old.revenue).toBe(0n);
    const g = r.general.find((x) => x.cost_center_id === cc!.id)!;
    expect(g.total).toBe(30000n);
  });

  it('Einsatz eines abwesenden Mitarbeiters: nicht notwendig / Nachunternehmer-Bestellung', async () => {
    const emp = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '3101', 'Ab', 'Wesend', '2024-01-01')`;
    const plan = randomUUID();
    await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from, created_at)
              values (${plan}, ${emp}, ${DEMO.siteSchool}, 1, '06:00', '08:00', '2026-01-01', '2025-12-01')`;
    const sup = randomUUID();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79312', 'NU Vertretung', 'nachunternehmer')`;
    const sc = randomUUID();
    await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents, valid_from, status, created_by)
              values (${sc}, 'BE-2026-3101', ${sup}, ${DEMO.siteSchool}, 'Unterhaltsreinigung', 'monatlich', 'stunde', 3000, '2026-01-01', 'entwurf', 't')`;
    const base = {
      planId: plan,
      date: '2026-11-02',
      kind: 'ausfall' as const,
      substituteId: null,
      start: null,
      end: null,
      note: 'Nachunternehmer',
      expectedVersion: null,
    };
    await expect(saveException(sql, randomUUID(), { ...base, subcontractId: sc }, 't')).rejects.toThrow(
      /nicht erteilt/,
    );
    await sql`update app.subcontracts set status = 'erteilt' where id = ${sc}`;
    await saveException(sql, randomUUID(), { ...base, subcontractId: sc }, 't');
    const [ex] = await sql<{ kind: string; subcontract_id: string }[]>`
      select kind::text, subcontract_id from app.shift_exceptions where shift_plan_id = ${plan}`;
    expect(ex).toEqual({ kind: 'ausfall', subcontract_id: sc });
  });

  it('Kassenbuch-PDF im neuen Formular-Stil', async () => {
    const pdf = await monthPdf(sql, '2026-09');
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('Nachunternehmer unterschreibt die Bestellung am Handy – genau einmal, nur erteilt', async () => {
    const deps = await testDeps(sql);
    const png = new Uint8Array(await QRCode.toBuffer('Unterschrift', { type: 'png', width: 200 }));
    const sup = randomUUID();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${sup}, '79313', 'NU Sign', 'nachunternehmer')`;
    const sc = randomUUID();
    await sql`insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents, valid_from, status, created_by)
              values (${sc}, 'BE-2026-3102', ${sup}, ${DEMO.siteSchool}, 'Unterhaltsreinigung', 'monatlich', 'pauschale_monat', 90000, '2026-10-01', 'entwurf', 't')`;
    await expect(signSubcontract(deps, sc, { name: 'Max Muster', png }, 't')).rejects.toThrow(/erteilen/);
    await sql`update app.subcontracts set status = 'erteilt' where id = ${sc}`;
    await expect(signSubcontract(deps, sc, { name: 'M', png }, 't')).rejects.toThrow(/Namen/);
    await signSubcontract(deps, sc, { name: 'Max Muster', png }, 't');
    const [row] = await sql<
      { signed_file_path: string }[]
    >`select signed_file_path from app.subcontracts where id = ${sc}`;
    expect(row!.signed_file_path).toMatch(/signiert-.*\.pdf$/);
    const pdf = await deps.archive.get(row!.signed_file_path);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    await expect(signSubcontract(deps, sc, { name: 'Max Muster', png }, 't')).rejects.toThrow(/bereits/);
  });
});
