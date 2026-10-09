import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { saveSupplier } from './inventory.js';
import { DEMO } from './seed.js';
import {
  addPriceChange,
  complianceOverview,
  compliancePdf,
  createPortalAccess,
  criticalSupplierIds,
  docTypes,
  evaluate,
  getSubcontractor,
  monthOverview,
  portalLogin,
  reviewDocument,
  saveSubcontract,
  setSubcontractStatus,
  terminate,
  uploadDocument,
} from './subcontractors.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Nachunternehmer', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let pdf: Uint8Array;
  const nu = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    const d = await PDFDocument.create();
    d.addPage();
    pdf = await d.save();
    await saveSupplier(
      sql,
      nu,
      {
        supplier_no: '70100',
        name: 'Clean Partner GmbH',
        kind: 'nachunternehmer',
        legal_form: 'gmbh',
        payment_terms_days: '30',
        active: 'on',
      },
      null,
      't',
    );
  });
  afterAll(async () => {
    await sql?.end();
  });

  const doc = (type: string, validUntil: string | null, source: 'buero' | 'portal' = 'buero', data = pdf) =>
    uploadDocument(deps, {
      id: randomUUID(),
      supplierId: nu,
      docType: type,
      fileName: `${type}.pdf`,
      data,
      validUntil,
      source,
      actor: 't',
    });

  it('Ampel: HR-Auszug je Rechtsform, abgelaufen/läuft ab, optional ignoriert', async () => {
    const types = await docTypes(sql);
    const base = { active: true, terminated_on: null };
    expect(
      evaluate({ ...base, legal_form: 'gmbh' }, types, []).rows.some((r) => r.type.id === 'hr' && r.required),
    ).toBe(true);
    expect(
      evaluate({ ...base, legal_form: 'einzelunternehmen' }, types, []).rows.some((r) => r.type.id === 'hr'),
    ).toBe(false);
    expect(
      evaluate({ ...base, legal_form: 'sonstige' }, types, []).rows.find((r) => r.type.id === 'hr')!.required,
    ).toBe(false);

    const s0 = (await getSubcontractor(sql, nu))!;
    expect(s0.overall).toBe('kritisch');
    for (const r of s0.rows.filter((x) => x.required))
      await doc(r.type.id, r.type.valid_months ? '2027-06-30' : null);
    expect((await getSubcontractor(sql, nu))!.overall).toBe('ok');
    expect(await criticalSupplierIds(sql)).not.toContain(nu);

    // läuft in < 60 Tagen ab → Warnung; abgelaufen → kritisch
    await doc('haftpflicht', '2026-11-15');
    const s1 = (await getSubcontractor(sql, nu))!;
    expect(s1.overall).toBe('warnung');
    expect(s1.rows.find((r) => r.type.id === 'haftpflicht')!.state).toBe('laeuft_ab');
    await doc('haftpflicht', '2026-09-30');
    expect((await getSubcontractor(sql, nu))!.overall).toBe('kritisch');
    await doc('haftpflicht', '2027-09-30');
    // Versionen bleiben erhalten, Nachweise nie löschen
    expect(
      (await sql`select count(*)::int as n from app.supplier_documents where doc_type = 'haftpflicht'`)[0]!.n,
    ).toBe(4);
    await expect(sql`delete from app.supplier_documents where supplier_id = ${nu}`).rejects.toThrow(
      /nicht gelöscht/,
    );
    // alte Felder werden abgeleitet
    const [s] =
      await sql`select exemption_valid_until, clearance_valid_until from app.suppliers where id = ${nu}`;
    expect(s).toEqual({ exemption_valid_until: '2027-06-30', clearance_valid_until: '2027-06-30' });
  });

  it('Büro-Upload ohne Datum und falscher Dateityp werden abgelehnt', async () => {
    await expect(doc('ub_bg', null)).rejects.toThrow(/gültig bis/);
    await expect(doc('ub_bg', '2027-01-01', 'buero', new TextEncoder().encode('MZ…exe'))).rejects.toThrow(
      /PDF, JPG/,
    );
  });

  it('Portal: PIN mit Sperre, Upload zählt erst nach Prüfung', async () => {
    const { token, pin } = await createPortalAccess(sql, nu, 't');
    expect(pin).toMatch(/^\d{6}$/);
    await expect(portalLogin(sql, token, '000000')).rejects.toThrow(/PIN falsch/);
    expect(await portalLogin(sql, token, pin)).toBe(nu);
    // neue Version im Portal → noch nicht gültig; alte gilt weiter
    await doc('ub_kk_sv', '2027-12-31', 'portal');
    const s = (await getSubcontractor(sql, nu))!;
    const row = s.rows.find((r) => r.type.id === 'ub_kk_sv')!;
    expect(row.current!.valid_until).toBe('2027-06-30');
    expect(row.pending).not.toBeNull();
    await expect(
      reviewDocument(sql, row.pending!.id, { accept: false, validUntil: null, reason: null }, 't'),
    ).rejects.toThrow(/Grund/);
    await reviewDocument(
      sql,
      row.pending!.id,
      { accept: true, validUntil: '2027-12-31', reason: null },
      'buero',
    );
    expect(
      (await getSubcontractor(sql, nu))!.rows.find((r) => r.type.id === 'ub_kk_sv')!.current!.valid_until,
    ).toBe('2027-12-31');
    await expect(
      sql`update app.supplier_documents set valid_until = '2030-01-01' where id = ${row.pending!.id}`,
    ).rejects.toThrow(/bereits geprüft/);
    // 5 Fehlversuche → gesperrt, auch mit richtiger PIN
    for (let i = 0; i < 5; i++) await portalLogin(sql, token, '111111').catch(() => null);
    await expect(portalLogin(sql, token, pin)).rejects.toThrow(/Fehlversuche/);
  });

  it('Aufträge: erteilen nur mit Nachweisen, Preisnachtrag, Soll/Ist, Kündigung beendet Aufträge', async () => {
    const id = randomUUID();
    const input = {
      supplierId: nu,
      siteId: DEMO.siteSchool,
      serviceKind: 'Unterhaltsreinigung',
      frequency: 'monatlich',
      billing: 'pauschale_monat',
      priceCents: 150000n,
      maxHours: null,
      validFrom: '2026-08-01',
      validTo: null,
      description: 'Mo–Fr',
      note: null,
    };
    await saveSubcontract(sql, id, input, 't');
    const [sc] = await sql`select number from app.subcontracts where id = ${id}`;
    expect(sc!.number).toMatch(/^BE-2026-\d{4}$/);
    await setSubcontractStatus(sql, id, 'erteilt', 't');
    await addPriceChange(
      sql,
      { id: randomUUID(), subcontractId: id, month: '2026-10', priceCents: 157500n, reason: 'Tariflohn' },
      't',
    );
    await expect(
      addPriceChange(
        sql,
        { id: randomUUID(), subcontractId: id, month: '2026-08', priceCents: 1n, reason: 'x' },
        't',
      ),
    ).rejects.toThrow(/nach dem Beginnmonat/);

    // Eingangsrechnung September passt, Oktober fehlt
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, service_month, net_cents,
                                                 vat_cents, gross_cents, category, site_id, created_by)
              values (${randomUUID()}, ${nu}, 'R-9', '2026-09-30', '2026-10-30', '2026-09-01', 150000, 28500, 178500,
                      'nachunternehmer', ${DEMO.siteSchool}, 't')`;
    const sep = (await monthOverview(sql, '2026-09')).find((r) => r.id === id)!;
    expect(sep).toMatchObject({ soll: 150000n, ist_cents: 150000n, state: 'ok' });
    const oct = (await monthOverview(sql, '2026-10')).find((r) => r.id === id)!;
    expect(oct).toMatchObject({ soll: 157500n, ist_cents: null, state: 'fehlt' });

    // erteilte Bestellung korrigieren (Ahmed 09.10.): Häufigkeit/Abrechnung änderbar, Preis/Nachunternehmer bleiben
    const [cur] = await sql<{ version: number }[]>`select version from app.subcontracts where id = ${id}`;
    const version = cur!.version;
    await saveSubcontract(
      sql,
      id,
      { ...input, frequency: 'quartalsweise', billing: 'pauschale_einsatz', priceCents: 1n, version },
      't',
    );
    const [ed] =
      await sql`select frequency, billing, price_cents, status from app.subcontracts where id = ${id}`;
    expect(ed).toMatchObject({
      frequency: 'quartalsweise',
      billing: 'pauschale_einsatz',
      price_cents: 150000n,
      status: 'erteilt',
    });
    const [log] = await sql<{ details: Record<string, { alt: unknown; neu: unknown }> }[]>`
      select details from app.audit_log where entity = 'subcontract' and entity_id = ${id} and details is not null
       order by id desc limit 1`;
    expect(log!.details.frequency).toEqual({ alt: 'monatlich', neu: 'quartalsweise' });
    expect(Object.keys(log!.details).sort()).toEqual(['billing', 'frequency']);

    const pdfBytes = await compliancePdf(sql, nu);
    expect((await PDFDocument.load(pdfBytes)).getTitle()).toMatch(/Nachweisübersicht/);

    await terminate(sql, nu, { date: '2026-12-31', reasons: ['Qualitätsmängel'], note: null }, 't');
    const [after] = await sql`select valid_to from app.subcontracts where id = ${id}`;
    expect(after!.valid_to).toBe('2026-12-31');
    const ov = (await complianceOverview(sql)).find((r) => r.supplier.id === nu)!;
    expect(ov.overall).toBe('inaktiv');
    await expect(saveSubcontract(sql, randomUUID(), input, 't')).rejects.toThrow(/inaktiv/);
  });

  it('Erteilen erst ab 50 % gültiger Pflicht-Nachweise (Ahmed 09.10.)', async () => {
    const nu2 = randomUUID();
    await saveSupplier(
      sql,
      nu2,
      {
        supplier_no: '70177',
        name: 'Halb GmbH',
        kind: 'nachunternehmer',
        legal_form: 'gmbh',
        payment_terms_days: '30',
        active: 'on',
      },
      null,
      't',
    );
    const id = randomUUID();
    await saveSubcontract(
      sql,
      id,
      {
        supplierId: nu2,
        siteId: DEMO.siteSchool,
        serviceKind: 'Unterhaltsreinigung',
        frequency: 'monatlich',
        billing: 'pauschale_monat',
        priceCents: 100000n,
        maxHours: null,
        validFrom: '2026-10-01',
        validTo: null,
        description: null,
        note: null,
      },
      't',
    );
    await expect(setSubcontractStatus(sql, id, 'erteilt', 't')).rejects.toThrow(/unter 50 %/);
    const req = (await getSubcontractor(sql, nu2))!.rows.filter((r) => r.required);
    for (const r of req.slice(0, Math.ceil(req.length / 2)))
      await uploadDocument(deps, {
        id: randomUUID(),
        supplierId: nu2,
        docType: r.type.id,
        fileName: `${r.type.id}.pdf`,
        data: pdf,
        validUntil: r.type.valid_months ? '2027-06-30' : null,
        source: 'buero',
        actor: 't',
      });
    await setSubcontractStatus(sql, id, 'erteilt', 't');
    const [log] = await sql<{ details: { nachweise_fehlen?: string[] } }[]>`
      select details from app.audit_log where entity = 'subcontract' and entity_id = ${id} and action = 'status'`;
    expect(log!.details.nachweise_fehlen?.length).toBeGreaterThan(0);
  });
});
