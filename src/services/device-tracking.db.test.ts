import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { deviceByToken, deviceEvents, recordDeviceScan, recordDeviceService } from './device-tracking.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Geräte mit QR-Code', () => {
  let sql: Sql;
  let cfg: { dir: string; maxBytes: number };
  beforeAll(async () => {
    sql = await freshDatabase();
    cfg = { dir: await mkdtemp(join(tmpdir(), 'viva-geraete-')), maxBytes: 10_000_000 };
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Scan setzt Standort, doppelt absenden zählt einmal, Defekt legt Aufgabe an, repariert erledigt sie', async () => {
    const [d] = await sql<{ id: string; qr_token: string }[]>`
      insert into app.devices (id, inventory_no, name, kind)
      values (${crypto.randomUUID()}, 'T-9001', 'Wischwagen grün', 'wischwagen') returning id, qr_token`;
    const [site] = await sql<{ id: string }[]>`select id from app.sites where active limit 1`;
    expect((await deviceByToken(sql, d!.qr_token))?.id).toBe(d!.id);
    const base = {
      deviceId: d!.id,
      note: null,
      by: 'Test',
      actor: 'test',
      pos: { lat: 48.1, lng: 11.5, acc: 20 },
    };
    await expect(
      recordDeviceScan(sql, cfg, { ...base, id: crypto.randomUUID(), action: 'hier', siteId: null }),
    ).rejects.toThrow(/Objekt/);
    const id = crypto.randomUUID();
    expect(await recordDeviceScan(sql, cfg, { ...base, id, action: 'mitgenommen', siteId: site!.id })).toBe(
      true,
    );
    expect(await recordDeviceScan(sql, cfg, { ...base, id, action: 'mitgenommen', siteId: site!.id })).toBe(
      false,
    );
    expect((await deviceByToken(sql, d!.qr_token))?.site_id).toBe(site!.id);

    await recordDeviceScan(sql, cfg, { ...base, id: crypto.randomUUID(), action: 'lager', siteId: site!.id });
    expect((await deviceByToken(sql, d!.qr_token))?.site_id).toBeNull();

    await expect(
      recordDeviceScan(sql, cfg, { ...base, id: crypto.randomUUID(), action: 'defekt', siteId: null }),
    ).rejects.toThrow(/kaputt/);
    await recordDeviceScan(sql, cfg, {
      ...base,
      id: crypto.randomUUID(),
      action: 'defekt',
      siteId: null,
      note: 'Kabel gebrochen',
    });
    expect((await deviceByToken(sql, d!.qr_token))?.status).toBe('defekt');
    const [task] = await sql<{ status: string }[]>`
      select status from app.tasks where entity_type = 'device' and entity_id = ${d!.id}`;
    expect(task?.status).toBe('open');

    await recordDeviceService(sql, {
      id: crypto.randomUUID(),
      deviceId: d!.id,
      action: 'repariert',
      date: '2026-10-19',
      note: 'Kabel getauscht',
      nextInspection: null,
      by: 'Test',
      actor: 'test',
    });
    expect((await deviceByToken(sql, d!.qr_token))?.status).toBe('ok');
    const [done] = await sql<{ status: string }[]>`
      select status from app.tasks where entity_type = 'device' and entity_id = ${d!.id}`;
    expect(done?.status).toBe('done');
    expect((await deviceEvents(sql, d!.id)).length).toBe(4);
    await expect(sql`update app.device_events set note = 'x'`).rejects.toThrow();
  });
});
