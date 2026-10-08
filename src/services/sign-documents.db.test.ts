import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import QRCode from 'qrcode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  createSignDocument,
  deleteSignDocument,
  getSignDocument,
  requestsForEmployee,
  signRequest,
  signedPdf,
  withdrawRequest,
} from './sign-documents.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Dokumente digital unterschreiben', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let pdf: Uint8Array;
  let png: Uint8Array;
  const anna = randomUUID();
  const ion = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date) values
      (${anna}, '7001', 'Anna', 'Nowak', '2025-01-01'), (${ion}, '7002', 'Ion', 'Popescu', '2025-01-01')`;
    const d = await PDFDocument.create();
    d.addPage();
    d.addPage();
    pdf = await d.save();
    png = new Uint8Array(await QRCode.toBuffer('sig', { type: 'png', width: 200 }));
  });
  afterAll(async () => {
    await sql?.end();
  });

  const doc = (over: Partial<Parameters<typeof createSignDocument>[2]> = {}) => ({
    title: 'Unterweisung Arbeitsschutz 2026',
    category: 'unterweisung' as const,
    description: 'Jährliche Unterweisung',
    dueDate: '2026-10-31',
    fileName: 'unterweisung.pdf',
    pdf,
    employeeIds: [anna, ion],
    ...over,
  });

  it('Kündigung, Aufhebungsvertrag, Befristung werden abgelehnt (Schriftform)', async () => {
    for (const title of [
      'Kündigung zum 31.12.',
      'Aufhebungsvertrag',
      'Befristeter Arbeitsvertrag',
      'Arbeitszeugnis',
    ]) {
      await expect(createSignDocument(deps, randomUUID(), doc({ title }), 't')).rejects.toThrow(
        /Schriftform/,
      );
    }
    await expect(
      createSignDocument(deps, randomUUID(), doc({ pdf: new Uint8Array([1, 2, 3]) }), 't'),
    ).rejects.toThrow(/PDF/);
  });

  it('Anforderung je Mitarbeiter, Unterschrift nur eigene, danach unveränderbar mit Nachweisblatt', async () => {
    const id = randomUUID();
    await createSignDocument(deps, id, doc(), 't');
    await createSignDocument(deps, id, doc(), 't'); // doppelt abgeschickt
    const d = (await getSignDocument(sql, id))!;
    expect(d.doc.page_count).toBe(2);
    expect(d.requests).toHaveLength(2);
    const [mine] = await requestsForEmployee(sql, anna);
    expect(mine!.title).toBe('Unterweisung Arbeitsschutz 2026');

    // fremde Anforderung
    await expect(
      signRequest(deps, mine!.id, ion, { png, confirmed: true, ip: null, userAgent: null }),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(
      signRequest(deps, mine!.id, anna, { png, confirmed: false, ip: null, userAgent: null }),
    ).rejects.toThrow(/gelesen/);
    await signRequest(deps, mine!.id, anna, {
      png,
      confirmed: true,
      ip: '10.0.0.7',
      userAgent: 'iPhone Safari',
    });
    await signRequest(deps, mine!.id, anna, { png, confirmed: true, ip: null, userAgent: null }); // nochmal → nichts

    const signed = await signedPdf(deps, mine!.id);
    const loaded = await PDFDocument.load(signed);
    expect(loaded.getPageCount()).toBe(3); // Original + Nachweisblatt
    await expect(sql`update app.sign_requests set signed_name = 'X' where id = ${mine!.id}`).rejects.toThrow(
      /unveränderbar/,
    );
    await expect(sql`delete from app.sign_requests where id = ${mine!.id}`).rejects.toThrow();
    await expect(sql`update app.sign_documents set title = 'X' where id = ${id}`).rejects.toThrow();

    // Zurückziehen nur offene; danach kann Ion nicht mehr unterschreiben
    const ionReq = d.requests.find((r) => r.employee_id === ion)!;
    await withdrawRequest(sql, ionReq.id, 'buero');
    await withdrawRequest(sql, mine!.id, 'buero'); // unterschrieben → bleibt
    await expect(
      signRequest(deps, ionReq.id, ion, { png, confirmed: true, ip: null, userAgent: null }),
    ).rejects.toThrow(/zurückgezogen/);
    const after = (await getSignDocument(sql, id))!.requests;
    expect(after.map((r) => r.status).sort()).toEqual(['unterschrieben', 'zurueckgezogen']);
  });

  it('Löschen: ohne Unterschrift ganz weg, mit Unterschrift nur beendet (Nachweis bleibt)', async () => {
    const leer = randomUUID();
    await createSignDocument(deps, leer, doc({ title: 'Unterweisung leer' }), 't');
    expect(await deleteSignDocument(sql, leer, 't')).toBe('geloescht');
    expect(await getSignDocument(sql, leer)).toBeUndefined();
    const mit = randomUUID();
    await createSignDocument(deps, mit, doc({ title: 'Unterweisung mit' }), 't');
    const r = (await getSignDocument(sql, mit))!.requests.find((x) => x.employee_id === anna)!;
    await signRequest(deps, r.id, anna, { png, confirmed: true, ip: null, userAgent: null });
    expect(await deleteSignDocument(sql, mit, 't')).toBe('beendet');
    const g = (await getSignDocument(sql, mit))!;
    expect(g.doc.archived_at).not.toBeNull();
    expect(g.requests.map((x) => x.status).sort()).toEqual(['unterschrieben', 'zurueckgezogen']);
    await expect(sql`delete from app.sign_documents where id = ${mit}`).rejects.toThrow();
    await expect(sql`update app.sign_documents set title = 'x' where id = ${mit}`).rejects.toThrow(/unveränderbar/);
  });
});
