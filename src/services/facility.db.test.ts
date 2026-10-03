import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  addReading,
  closeQualityCheck,
  createQualityCheck,
  getQualityCheck,
  hourTarget,
  qcScore,
  qualityCheckPdf,
  readingsWithConsumption,
  saveMeter,
  saveQualityCheck,
  saveRoom,
} from './facility.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const OFFICE = '00000000-0000-4000-8000-0000000a0001'; // Büro 200 m²/h
const WC = '00000000-0000-4000-8000-0000000a0006'; // Sanitär 80 m²/h

describe('Prozent ohne Fließkomma-Überraschungen', () => {
  it('rundet kaufmännisch', () => {
    const r = (ok: number, bad: number, ng = 0) =>
      qcScore([
        ...Array(ok).fill({ rating: 'ok' }),
        ...Array(bad).fill({ rating: 'mangel' }),
        ...Array(ng).fill({ rating: 'nicht_geprueft' }),
      ]);
    expect(r(7, 1).score).toBe(88); // 87,5 → 88
    expect(r(2, 1, 5)).toEqual({ checked: 3, defects: 1, score: 67 });
    expect(r(0, 0, 3).checked).toBe(0);
  });
});

describe.skipIf(!available)('Raumbuch, Qualitätskontrolle, Zähler', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const room = (over: Partial<Parameters<typeof saveRoom>[2]> = {}) => ({
    siteId: DEMO.siteSchool,
    roomNo: '0.01',
    name: 'Sekretariat',
    floor: 'EG',
    roomTypeId: OFFICE,
    floorCovering: 'Linoleum',
    areaCenti: 4000n, // 40 m²
    visitsPerYear: 260,
    performanceOverride: null,
    notes: null,
    active: true,
    expectedVersion: null,
    ...over,
  });

  it('Stundenvorgabe aus Fläche, Leistungswert und Intervall', async () => {
    await saveRoom(sql, randomUUID(), room());
    await saveRoom(
      sql,
      randomUUID(),
      room({ roomNo: '0.02', name: 'WC Damen', roomTypeId: WC, areaCenti: 1600n }),
    );
    // 40 m² / 200 m²/h = 12 min; 16 m² / 80 m²/h = 12 min; je 260× → 24 min × 260 = 104 h/Jahr
    const t = await hourTarget(sql, DEMO.siteSchool);
    expect(t.rooms.map((r) => r.minutesPerVisit)).toEqual([12, 12]);
    expect(t.hoursPerYear).toBeCloseTo(104, 10);
    expect(t.hoursPerWeek).toBeCloseTo(2, 10);
    expect(t.areaCenti).toBe(5600n);
    // Abweichender Leistungswert
    const id = randomUUID();
    await saveRoom(
      sql,
      id,
      room({
        roomNo: '1.01',
        name: 'Flur OG',
        floor: 'OG',
        performanceOverride: 400,
        areaCenti: 8000n,
        visitsPerYear: 52,
      }),
    );
    const t2 = await hourTarget(sql, DEMO.siteSchool);
    expect(t2.rooms.find((r) => r.id === id)!.minutesPerVisit).toBe(12);
    await expect(saveRoom(sql, id, room({ expectedVersion: 99 }))).rejects.toThrow(/zwischenzeitlich/);
  });

  it('Qualitätskontrolle: Bereiche aus Raumbuch, Mängel → Aufgaben (einmal), danach unveränderbar', async () => {
    const id = randomUUID();
    await createQualityCheck(
      sql,
      id,
      { siteId: DEMO.siteSchool, checkDate: '2026-10-02', inspector: 'A. Chomontek', attendee: null },
      'test',
    );
    await createQualityCheck(
      sql,
      id,
      { siteId: DEMO.siteSchool, checkDate: '2026-10-02', inspector: 'A. Chomontek', attendee: null },
      'test',
    );
    const d = (await getQualityCheck(sql, id))!;
    expect(d.check.number).toBe('QK-2026-0001');
    expect(d.items.map((i) => i.area)).toEqual([
      'EG · 0.01 Sekretariat',
      'EG · 0.02 WC Damen',
      'OG · 1.01 Flur OG',
    ]);
    await expect(closeQualityCheck(deps, id, { signature: null }, 'test')).rejects.toThrow(
      /mindestens einen/,
    );
    await saveQualityCheck(sql, id, {
      attendee: 'Hausmeister Maier',
      summary: 'Insgesamt gut',
      items: [
        { id: d.items[0]!.id, rating: 'ok', defects: ['Boden'], note: null },
        {
          id: d.items[1]!.id,
          rating: 'mangel',
          defects: ['Sanitärobjekte', 'Verbrauchsmaterial'],
          note: 'Seife leer',
        },
        { id: d.items[2]!.id, rating: 'ok', defects: [], note: null },
      ],
      extraArea: 'Außenbereich',
      expectedVersion: d.check.version,
    });
    const d2 = (await getQualityCheck(sql, id))!;
    expect(d2.items).toHaveLength(4);
    expect(d2.items[0]!.defects).toEqual([]); // Kategorien nur bei Mangel
    const png = new Uint8Array(await QRCode.toBuffer('sig', { type: 'png', width: 200 }));
    await closeQualityCheck(deps, id, { signature: { name: 'Hausmeister Maier', png } }, 'test');
    await closeQualityCheck(deps, id, { signature: null }, 'test'); // zweimal → nichts
    const done = (await getQualityCheck(sql, id))!;
    expect(done.check.status).toBe('abgeschlossen');
    expect(done.check.score_percent).toBe(67);
    expect(done.check.signed_by_name).toBe('Hausmeister Maier');
    expect(done.check.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    const tasks = await sql<{ title: string; description: string }[]>`
      select title, description from app.tasks where entity_id = ${DEMO.siteSchool} and title like 'Nachbesserung%'`;
    expect(tasks).toEqual([
      {
        title: 'Nachbesserung: EG · 0.02 WC Damen (QK-2026-0001)',
        description: 'Sanitärobjekte, Verbrauchsmaterial – Seife leer',
      },
    ]);
    expect(done.items[1]!.task_id).toBeTruthy();
    const pdf = await qualityCheckPdf(deps, id);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    await expect(
      saveQualityCheck(sql, id, {
        attendee: null,
        summary: null,
        items: [],
        extraArea: null,
        expectedVersion: null,
      }),
    ).rejects.toThrow(/unveränderbar/);
    await expect(sql`update app.quality_checks set score_percent = 100 where id = ${id}`).rejects.toThrow(
      /unveränderbar/,
    );
    await expect(
      sql`update app.quality_check_items set rating = 'ok' where check_id = ${id}`,
    ).rejects.toThrow(/unveränderbar/);
  });

  it('Zählerstände: nur anhängen, nicht rückwärts (außer Zählertausch), Verbrauch je Zeitraum', async () => {
    const m = randomUUID();
    await saveMeter(sql, m, {
      siteId: DEMO.siteSchool,
      kind: 'strom',
      meterNo: '1ESY1160012345',
      location: 'Keller',
      unit: null,
      active: true,
      expectedVersion: null,
    });
    await expect(
      saveMeter(sql, randomUUID(), {
        siteId: DEMO.siteSchool,
        kind: 'strom',
        meterNo: '1ESY1160012345',
        location: null,
        unit: null,
        active: true,
        expectedVersion: null,
      }),
    ).rejects.toThrow(/gibt es/);
    const r1 = randomUUID();
    await addReading(
      sql,
      r1,
      { meterId: m, readOn: '2026-08-31', valueMilli: 1_000_000n, isReplacement: false, note: null },
      't',
    );
    await addReading(
      sql,
      r1,
      { meterId: m, readOn: '2026-08-31', valueMilli: 1_000_000n, isReplacement: false, note: null },
      't',
    );
    await addReading(
      sql,
      randomUUID(),
      { meterId: m, readOn: '2026-09-30', valueMilli: 1_450_500n, isReplacement: false, note: null },
      't',
    );
    await expect(
      addReading(
        sql,
        randomUUID(),
        { meterId: m, readOn: '2026-10-01', valueMilli: 1_400_000n, isReplacement: false, note: null },
        't',
      ),
    ).rejects.toThrow(/kleiner als die vorige/);
    await expect(
      addReading(
        sql,
        randomUUID(),
        { meterId: m, readOn: '2026-09-15', valueMilli: 1_500_000n, isReplacement: false, note: null },
        't',
      ),
    ).rejects.toThrow(/größer als eine spätere/);
    await addReading(
      sql,
      randomUUID(),
      { meterId: m, readOn: '2026-10-01', valueMilli: 0n, isReplacement: true, note: 'Tausch' },
      't',
    );
    await expect(
      addReading(
        sql,
        randomUUID(),
        { meterId: m, readOn: '2099-01-01', valueMilli: 5n, isReplacement: false, note: null },
        't',
      ),
    ).rejects.toThrow(/Zukunft/);
    const rows = await readingsWithConsumption(sql, m);
    expect(rows.map((r) => [r.read_on, r.consumption_milli, r.days])).toEqual([
      ['2026-10-01', null, null],
      ['2026-09-30', 450_500n, 30],
      ['2026-08-31', null, null],
    ]);
    await expect(sql`delete from app.meter_readings where meter_id = ${m}`).rejects.toThrow();
  });
});
