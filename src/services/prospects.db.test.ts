import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import {
  addActivity,
  dueState,
  followups,
  getProspect,
  importLegacyProspects,
  legacyStatus,
  listProspects,
  saveProspect,
} from './prospects.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const input = (over = {}) => ({
  company: 'Muster GmbH',
  contact: 'Frau Test',
  phone: null,
  email: null,
  city: 'München',
  source: 'Kaltakquise',
  object: 'Büro 400 m²',
  status: 'erstkontakt',
  followupOn: null,
  followupReason: null,
  expectedVersion: null,
  ...over,
});

describe('Akquise-Regeln', () => {
  it('Status der alten App und Fälligkeit', () => {
    expect(legacyStatus('kalt')).toBe('erstkontakt');
    expect(legacyStatus('warm')).toBe('interesse_leicht');
    expect(legacyStatus('verhandlung')).toBe('interesse_stark');
    expect(legacyStatus('pause')).toBe('kein_interesse');
    expect(legacyStatus('gewonnen')).toBe('gewonnen');
    expect(dueState({ followup_on: '2026-01-01', status: 'erstkontakt' }, '2026-01-02')).toBe('overdue');
    expect(dueState({ followup_on: '2026-01-02', status: 'erstkontakt' }, '2026-01-02')).toBe('today');
    expect(dueState({ followup_on: '2026-01-01', status: 'gewonnen' }, '2026-01-02')).toBeNull();
  });
});

describe.skipIf(!available)('Akquise', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('anlegen, Aktivität mit Status/Wiedervorlage, Wiedervorlagen auf der Startseite', async () => {
    const today = todayBerlin();
    const id = randomUUID();
    await expect(saveProspect(sql, id, input({ company: ' ' }), 't')).rejects.toThrow(/Firma/);
    await saveProspect(sql, id, input({ followupOn: today }), 't');
    const aid = randomUUID();
    const act = {
      id: aid,
      kind: 'call_out',
      at: `${today}T09:30`,
      note: 'Angebot gewünscht',
      newStatus: 'interesse_stark',
      followupOn: addDays(today, 3),
    };
    await addActivity(sql, id, act, 't');
    await addActivity(sql, id, act, 't'); // doppelt absenden
    const d = await getProspect(sql, id);
    expect(d!.acts).toHaveLength(1);
    expect(d!.p.status).toBe('interesse_stark');
    expect(d!.p.followup_on).toBe(addDays(today, 3));
    const [l] = await listProspects(sql);
    expect(l).toMatchObject({ activity_count: 1, last_kind: 'call_out', last_note: 'Angebot gewünscht' });
    expect((await followups(sql)).week.map((f) => f.id)).toEqual([id]);
    await expect(saveProspect(sql, id, input({ expectedVersion: 1 }), 't')).rejects.toThrow(
      /zwischenzeitlich/,
    );
  });

  it('Import der alten App ist idempotent', async () => {
    const rows = [
      {
        id: 7,
        firma: 'Alt AG',
        status: 'kalt',
        wiedervorlage: '2026-05-01',
        activities: [{ id: 'x', typ: 'call_out', datum: '2026-04-01T10:00', notiz: 'nicht erreicht' }],
      },
    ];
    expect(await importLegacyProspects(sql, rows, 't')).toEqual({ n: 1, acts: 1 });
    expect(await importLegacyProspects(sql, rows, 't')).toEqual({ n: 0, acts: 0 });
    const p = (await listProspects(sql)).find((x) => x.company === 'Alt AG')!;
    expect(p.status).toBe('erstkontakt');
    expect(p.last_at!.toISOString()).toBe('2026-04-01T08:00:00.000Z');
  });
});
