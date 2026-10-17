import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { linkCustomerFilesToSites, listFiles, storeFile } from './uploads.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Kunden-Dokumente auf Objekte übertragen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('legt das LV bei mehreren Objekten ab, nichts doppelt, keine fremden Objekte', async () => {
    const cfg = { dir: await mkdtemp(join(tmpdir(), 'kd-')), maxBytes: 1e8 };
    const f = await storeFile(
      sql,
      cfg,
      {
        id: '00000000-0000-4000-8000-00000000c0a1',
        name: 'LV_Behoerde.pdf',
        type: 'application/pdf',
        data: new TextEncoder().encode('%PDF-1.4 test'),
        link: { type: 'customer', id: DEMO.authority },
        category: 'Leistungsverzeichnis',
      },
      't',
    );
    const p = { customerId: DEMO.authority, fileIds: [f.id], category: 'Leistungsverzeichnis' };
    expect(
      await linkCustomerFilesToSites(sql, { ...p, siteIds: [DEMO.siteSchool, DEMO.siteOffice] }, 't'),
    ).toBe(2);
    expect(await linkCustomerFilesToSites(sql, { ...p, siteIds: [DEMO.siteSchool] }, 't')).toBe(0);
    const atSite = await listFiles(sql, { type: 'site', id: DEMO.siteOffice });
    expect(atSite.find((x) => x.id === f.id)?.category).toBe('Leistungsverzeichnis');
    await expect(
      linkCustomerFilesToSites(sql, { ...p, siteIds: ['00000000-0000-4000-8000-0000000000ff'] }, 't'),
    ).rejects.toThrow(/Objekt gehört nicht/);
  });
});
