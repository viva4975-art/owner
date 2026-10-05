import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import QRCode from 'qrcode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  bookStock,
  closeHandoverWithoutSignature,
  getHandover,
  handoverPdf,
  type HandoverInput,
  holdings,
  saveHandover,
  signHandover,
  stock,
} from './handovers.js';
import { keyLog, saveKey } from './inventory.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const SHIRT = '00000000-0000-4000-8000-0000000c7001';
const SHOES = '00000000-0000-4000-8000-0000000c7008';

describe.skipIf(!available)('Übergaben mit Unterschrift', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let png: Uint8Array;
  let emp: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    png = new Uint8Array(await QRCode.toBuffer('Unterschrift', { type: 'png', width: 200 }));
    emp = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, 'T901', 'Ana', 'Popescu', '2026-01-01')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const input = (over: Partial<HandoverInput> = {}): HandoverInput => ({
    kind: 'kleidung',
    direction: 'ausgabe',
    employeeId: emp,
    supplierId: null,
    recipientName: null,
    siteId: DEMO.siteSchool,
    date: '2026-10-01',
    title: null,
    items: [],
    bodyText: null,
    wageDeduction: false,
    relatedId: null,
    note: null,
    issuerName: 'Objektleitung Test',
    ...over,
  });

  it('Kleidung: Bestand erst mit Unterschrift, PSA ohne Lohnabzug, unveränderbar, doppelt = einmal', async () => {
    await bookStock(
      sql,
      { id: randomUUID(), articleId: SHIRT, size: 'M', delta: 10, reason: 'zugang', note: null },
      't',
    );
    const id = randomUUID();
    await expect(
      saveHandover(
        deps,
        id,
        input({
          wageDeduction: true,
          items: [
            { label: '', article_id: SHIRT, size: 'M', qty: 2 },
            { label: '', article_id: SHOES, size: '40', qty: 1 },
          ],
        }),
        't',
      ),
    ).rejects.toThrow(/Schutzausrüstung/);
    await expect(
      saveHandover(deps, id, input({ items: [{ label: '', article_id: SHIRT, size: 'Q', qty: 1 }] }), 't'),
    ).rejects.toThrow(/Größe/);
    await saveHandover(
      deps,
      id,
      input({
        items: [
          { label: '', article_id: SHIRT, size: 'M', qty: 2 },
          { label: '', article_id: SHOES, size: '40', qty: 1 },
        ],
      }),
      't',
    );
    const h = (await getHandover(sql, id))!;
    expect(h.number).toMatch(/^UE-2026-\d{4}$/);
    expect(h.recipient_name).toBe('Ana Popescu');
    const qty = async (a: string, s: string) =>
      (await stock(sql)).find((r) => r.article_id === a && r.size === s)?.qty;
    expect(await qty(SHIRT, 'M')).toBe(10); // Entwurf bucht nichts

    await signHandover(deps, id, { name: 'Ana Popescu', png }, 'ol');
    await signHandover(deps, id, { name: 'Ana Popescu', png }, 'ol'); // doppelt gesendet
    expect(await qty(SHIRT, 'M')).toBe(8);
    expect(await qty(SHOES, '40')).toBe(-1); // ohne Bestand ausgegeben → sichtbar negativ
    expect((await getHandover(sql, id))!.status).toBe('unterschrieben');
    await expect(sql`update app.handovers set note = 'x' where id = ${id}`).rejects.toThrow(/unveränderbar/);
    await expect(sql`delete from app.handovers where id = ${id}`).rejects.toThrow(/gelöscht/);
    await expect(saveHandover(deps, id, input({ items: [] }), 't')).rejects.toThrow();

    const pdf = await PDFDocument.load(await handoverPdf(deps, id));
    expect(pdf.getTitle()).toMatch(/Übergabeprotokoll UE-2026/);
    expect((await sql`select pdf_path from app.handovers where id = ${id}`)[0]!.pdf_path).toMatch(
      /Protokoll_UE/,
    );

    const held = await holdings(sql, emp);
    expect(held.clothing.map((c) => [c.name, c.size, c.qty])).toEqual([
      ['Sicherheitsschuhe', '40', 1],
      ['T-Shirt grau', 'M', 2],
    ]);

    // Rückgabe eines T-Shirts → Bestand +1, Bestand beim Mitarbeiter −1
    const back = randomUUID();
    await saveHandover(
      deps,
      back,
      input({
        direction: 'rueckgabe',
        relatedId: id,
        items: [{ label: '', article_id: SHIRT, size: 'M', qty: 1 }],
      }),
      't',
    );
    await closeHandoverWithoutSignature(deps, back, 'Mitarbeiterin ausgeschieden, nicht erreichbar', 't');
    expect(await qty(SHIRT, 'M')).toBe(9);
    expect((await holdings(sql, emp)).clothing.find((c) => c.name === 'T-Shirt grau')!.qty).toBe(1);
  });

  it('Lohnabzug nur bei Kleidung ohne PSA, steht im Protokoll', async () => {
    const id = randomUUID();
    await saveHandover(
      deps,
      id,
      input({ wageDeduction: true, items: [{ label: '', article_id: SHIRT, size: 'L', qty: 1 }] }),
      't',
    );
    expect((await getHandover(sql, id))!.wage_deduction).toBe(true);
    await expect(
      saveHandover(
        deps,
        randomUUID(),
        input({ kind: 'sonstiges', wageDeduction: true, items: [{ label: 'Handy', qty: 1 }] }),
        't',
      ),
    ).rejects.toThrow(/nur bei der Ausgabe von Arbeitskleidung/);
  });

  it('Schlüssel: Schlüsselbuch wird mit der Unterschrift gebucht, Rückgabe nur vom Inhaber', async () => {
    const key = randomUUID();
    await saveKey(
      sql,
      key,
      { key_no: 'GS-7', site_id: DEMO.siteSchool, description: 'Hausmeisterraum', quantity: '1' },
      null,
      't',
    );
    const id = randomUUID();
    await expect(
      saveHandover(
        deps,
        id,
        input({ kind: 'schluessel', siteId: DEMO.siteOffice, items: [{ label: '', key_id: key, qty: 1 }] }),
        't',
      ),
    ).rejects.toThrow(/anderen Objekt/);
    await saveHandover(
      deps,
      id,
      input({ kind: 'schluessel', items: [{ label: '', key_id: key, qty: 1 }] }),
      't',
    );
    expect((await keyLog(sql, key)).length).toBe(0);
    await signHandover(deps, id, { name: 'Ana Popescu', png }, 'ol');
    const log = await keyLog(sql, key);
    expect(log.map((l) => [l.action, l.note])).toEqual([
      ['ausgabe', `Übergabe ${(await getHandover(sql, id))!.number}`],
    ]);
    expect((await holdings(sql, emp)).keys.map((k) => k.key_no)).toEqual(['GS-7']);

    // zweite Ausgabe desselben Schlüssels scheitert beim Unterschreiben – nichts wird gebucht
    const other = randomUUID();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${other}, 'T902', 'Mehmet', 'Yilmaz', '2026-01-01')`;
    const id2 = randomUUID();
    await saveHandover(
      deps,
      id2,
      input({ kind: 'schluessel', employeeId: other, items: [{ label: '', key_id: key, qty: 1 }] }),
      't',
    );
    await expect(signHandover(deps, id2, { name: 'Mehmet Yilmaz', png }, 'ol')).rejects.toThrow(
      /bereits ausgegeben/,
    );
    expect((await getHandover(sql, id2))!.status).toBe('entwurf');

    const ret = randomUUID();
    await saveHandover(
      deps,
      ret,
      input({
        kind: 'schluessel',
        direction: 'rueckgabe',
        relatedId: id,
        items: [{ label: '', key_id: key, qty: 1 }],
      }),
      't',
    );
    await signHandover(deps, ret, { name: 'Ana Popescu', png }, 'ol');
    expect((await holdings(sql, emp)).keys).toEqual([]);
  });

  it('Dokument: PDF wird mit dem Protokoll zusammengeführt', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    const id = randomUUID();
    await expect(
      saveHandover(
        deps,
        id,
        input({ kind: 'dokument', document: { name: 'x.pdf', data: new Uint8Array([1, 2, 3]) } }),
        't',
      ),
    ).rejects.toThrow(/PDF/);
    await saveHandover(
      deps,
      id,
      input({
        kind: 'dokument',
        title: 'Unterweisung Gefahrstoffe',
        document: { name: 'Unterweisung.pdf', data: await doc.save() },
      }),
      't',
    );
    await signHandover(deps, id, { name: 'Ana Popescu', png }, 'ol');
    const pdf = await PDFDocument.load(await handoverPdf(deps, id));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
  });
});
