import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { closeQualityCheck, createQualityCheck } from './facility.js';
import { listQmItems, saveRoomRatings } from './qm.js';
import {
  auditReport,
  deleteQualityCheck,
  qmStatistics,
  renderAuditReportPdf,
  renderQmStatisticsPdf,
} from './qm-report.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Qualitätskontrolle: Auswertungsbericht, Statistik, Löschen', () => {
  let sql: Sql;
  let deps: Deps;
  let dir: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    dir = await mkdtemp(join(tmpdir(), 'qmr-'));
  });
  afterAll(async () => {
    await sql?.end();
  });

  const audit = async (date: string, notes: Record<string, number>) => {
    const id = randomUUID();
    await createQualityCheck(
      sql,
      id,
      { siteId: DEMO.siteSchool, checkDate: date, inspector: 'QM', attendee: null },
      't',
    );
    const items = (await listQmItems(sql, false))
      .filter((i) => i.kind === 'punkte' && i.name !== 'Gesamteindruck')
      .slice(0, 2);
    for (const [room, note] of Object.entries(notes))
      await saveRoomRatings(sql, {
        checkId: id,
        roomId: room,
        ratings: items.map((it, k) => ({
          itemId: it.id,
          value: k === 0 ? note : 5,
          skipped: false,
          note: null,
          photoIds: [],
        })),
        actor: 't',
      });
    await closeQualityCheck(deps, id, { signature: null }, 't');
    return id;
  };

  it('Bericht mit Ampel, Gruppen, Bereichen, Top 10 und Verlauf; Statistik; Löschen nur Admin', async () => {
    const r1 = randomUUID();
    const r2 = randomUUID();
    for (const [id, name] of [
      [r1, 'Flur QM'],
      [r2, 'WC QM'],
    ] as const)
      await sql`insert into app.rooms (id, site_id, name, room_type_id, area_centi, visits_per_year)
                values (${id}, ${DEMO.siteSchool}, ${name}, '00000000-0000-4000-8000-0000000a0001', 1500, 260)`;
    await audit('2026-09-01', { [r1]: 5, [r2]: 5 });
    const id = await audit('2026-10-01', { [r1]: 5, [r2]: 3 }); // r2: Boden 50 % (Gewicht 4) + Türen 100 % (Gewicht 1) = 60 %
    const rep = await auditReport(sql, id);
    expect(rep.rooms).toHaveLength(2);
    expect(rep.ampel).toEqual({ low: 1, mid: 0, high: 1 });
    expect(rep.score).toBe(80);
    expect(rep.prevScore).toBe(100);
    expect(rep.history.map((h) => h.score)).toEqual([100, 80]);
    expect(rep.defectCount).toBe(1);
    expect(rep.top[0]!.score).toBe(75);
    expect(rep.top[0]!.weight).toBe(4);
    expect(rep.groups[0]!.prev).toBe(100);
    expect(rep.areas.length).toBeGreaterThan(0);
    const pdf = await renderAuditReportPdf(deps, { dir, maxBytes: 1e7 }, id);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');

    const s = await qmStatistics(sql, { from: '2026-01-01', to: '2026-12-31', siteIds: null });
    expect(s.checks).toBe(2);
    expect(s.score).toBe(90);
    expect(s.sites[0]!.trend).toBe(-20);
    expect(
      (await renderQmStatisticsPdf(s, { from: '2026-01-01', to: '2026-12-31', scope: 'alle' })).length,
    ).toBeGreaterThan(1000);

    await expect(deleteQualityCheck(sql, id, { admin: false, actor: 't' })).rejects.toThrow('nur ein Admin');
    await deleteQualityCheck(sql, id, { admin: true, actor: 't' });
    const [gone] = await sql`select 1 from app.quality_checks where id = ${id}`;
    expect(gone).toBeUndefined();
    const [log] =
      await sql`select 1 from app.audit_log where entity = 'quality_check' and entity_id = ${id} and action = 'delete'`;
    expect(log).toBeDefined();
  }, 60_000);
});
