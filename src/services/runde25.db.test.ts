import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  cancelCardReceipt,
  cardReceiptDeletable,
  deleteCardReceipt,
  listCardReceipts,
  saveCardReceipt,
} from './cashbook.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import { listDeletions, officeSave, purgeEntries } from './time.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe('Karten-Beleg löschbar', () => {
  it('nur im Monat des Belegs und nicht storniert', () => {
    expect(cardReceiptDeletable({ receipt_date: '2026-10-02', cancelled_at: null }, '2026-10-08')).toBe(true);
    expect(cardReceiptDeletable({ receipt_date: '2026-09-30', cancelled_at: null }, '2026-10-08')).toBe(
      false,
    );
    expect(cardReceiptDeletable({ receipt_date: '2026-10-02', cancelled_at: new Date() }, '2026-10-08')).toBe(
      false,
    );
  });
});

describe.skipIf(!available)('Zeiten löschen, Karten-Belege (Datenbank)', () => {
  let sql: Sql;
  let deps: Deps;
  let dir: string;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    dir = await mkdtemp(join(tmpdir(), 'r25-'));
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${emp}, '7901', 'Lösch', 'Test', '2024-01-01')`;
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('Zeit endgültig löschen: nur mit Grund, Stand im Löschprotokoll, sonst weiter gesperrt', async () => {
    const id = randomUUID();
    await officeSave(sql, {
      id,
      employeeId: emp,
      siteId: DEMO.siteSchool,
      date: '2026-09-15',
      start: '06:00',
      end: '09:00',
      breakMinutes: 0,
      reason: 'Test',
      expectedVersion: null,
      actor: 't',
    });
    await expect(sql`delete from app.time_entries where id = ${id}`).rejects.toThrow(/§ 17 MiLoG/);
    await expect(sql`delete from app.time_entry_log where entry_id = ${id}`).rejects.toThrow(/nur anhängbar/);
    await expect(purgeEntries(sql, [id], ' ', 'admin')).rejects.toThrow(/begründen/);
    expect(await purgeEntries(sql, [id, id], 'Testdaten', 'admin')).toBe(1);
    expect(await sql`select 1 from app.time_entries where id = ${id}`).toHaveLength(0);
    const [d] = await listDeletions(sql);
    expect(d).toMatchObject({ entry_id: id, actor: 'admin', reason: 'Testdaten', work_date: '2026-09-15' });
    const [x] = await sql<{ n: number }[]>`
      select jsonb_array_length(log)::int as n from app.time_entry_deletions where entry_id = ${id}`;
    expect(x!.n).toBeGreaterThan(0);
    await expect(sql`delete from app.time_entry_deletions`).rejects.toThrow(/nur anhängbar/);
    // nach dem Löschen bleibt die Sperre für normale Löschversuche bestehen
    expect(await purgeEntries(sql, [id], 'nochmal', 'admin')).toBe(0);
  });

  it('Karten-Beleg: im laufenden Monat löschen, älter nur stornieren', async () => {
    const d = { ...deps, archive: deps.archive };
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const now = randomUUID();
    const old = randomUUID();
    const file = { bytes: img, name: 'b.png', type: 'image/png' };
    await saveCardReceipt(
      d,
      now,
      { date: todayBerlin(), amountCents: 1250n, note: null, file, expectedVersion: null },
      't',
    );
    await saveCardReceipt(
      d,
      old,
      { date: '2025-01-10', amountCents: 990n, note: null, file, expectedVersion: null },
      't',
    );
    await expect(deleteCardReceipt(sql, old, 't')).rejects.toThrow(/stornieren/);
    await deleteCardReceipt(sql, now, 't');
    await expect(cancelCardReceipt(sql, old, '', 't')).rejects.toThrow(/Grund/);
    await cancelCardReceipt(sql, old, 'doppelt erfasst', 't');
    const all = await listCardReceipts(sql);
    expect(all.map((k) => k.id)).toEqual([old]);
    expect(all[0]).toMatchObject({ cancel_reason: 'doppelt erfasst', cancelled_by: 't' });
    await expect(
      saveCardReceipt(
        d,
        old,
        { date: '2025-01-10', amountCents: 1n, note: null, expectedVersion: null },
        't',
      ),
    ).rejects.toThrow(/Stornierte/);
  });
});
