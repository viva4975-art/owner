import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  cancelEntry,
  closeMonth,
  getEntry,
  monthCsv,
  monthPdf,
  monthView,
  openingOf,
  saveCardReceipt,
  saveEntry,
  setOpening,
} from './cashbook.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Kassenbuch', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });
  const base = { receiptRef: null, note: null, expectedVersion: null };

  it('bucht fortlaufend, rechnet Tagessaldo, Übertrag und sperrt Minus', async () => {
    await setOpening(sql, '2026-08', 10000n, 'test');
    const a = randomUUID();
    const b = randomUUID();
    await saveEntry(
      deps,
      a,
      { ...base, kind: 'ausgabe', date: '2026-08-03', description: 'Metro', amountCents: 2550n },
      'test',
    );
    await saveEntry(
      deps,
      b,
      {
        ...base,
        kind: 'einnahme',
        date: '2026-08-02',
        description: 'Bareinzahlung',
        amountCents: 5000n,
        file: { bytes: new TextEncoder().encode('%PDF-1.4 x'), name: 'q.pdf', type: 'application/pdf' },
      },
      'test',
    );
    const v = await monthView(sql, '2026-08');
    expect(v.rows.map((r) => [r.entry_no, r.saldo])).toEqual([
      [2, 15000n],
      [1, 12450n],
    ]);
    expect(v.closing).toBe(12450n);
    expect(v.rows[0]!.receipt_path).toMatch(/^kasse\//);
    // September ohne eigenen Anfangsbestand: Übertrag aus August
    expect(await openingOf(sql, '2026-09')).toEqual({ cents: 12450n, manual: false });
    // Kasse darf nicht ins Minus
    await expect(
      saveEntry(
        deps,
        randomUUID(),
        { ...base, kind: 'ausgabe', date: '2026-08-01', description: 'zu viel', amountCents: 10001n },
        'test',
      ),
    ).rejects.toThrow(/negativ/);
    await expect(
      saveEntry(
        deps,
        randomUUID(),
        { ...base, kind: 'ausgabe', date: '2099-01-01', description: 'Zukunft', amountCents: 1n },
        'test',
      ),
    ).rejects.toThrow(/Zukunft/);
    // Änderung mit Protokoll, falsche Version abgelehnt
    await saveEntry(
      deps,
      a,
      {
        ...base,
        kind: 'ausgabe',
        date: '2026-08-03',
        description: 'Metro Reiniger',
        amountCents: 2550n,
        expectedVersion: 1,
      },
      'test',
    );
    await expect(
      saveEntry(
        deps,
        a,
        {
          ...base,
          kind: 'ausgabe',
          date: '2026-08-03',
          description: 'x',
          amountCents: 2550n,
          expectedVersion: 1,
        },
        'test',
      ),
    ).rejects.toThrow(/zwischenzeitlich/);
    expect((await getEntry(sql, a))!.log.map((l) => l.action)).toEqual(['gebucht', 'geändert']);
    // Löschen per SQL verboten
    await expect(sql`delete from app.cash_entries where id = ${a}`).rejects.toThrow(/nicht gelöscht/);
    expect(monthCsv(v)).toContain('Endbestand;124,50');
    expect((await monthPdf(sql, '2026-08')).length).toBeGreaterThan(1000);
  });

  it('Storno zählt nicht, Abschluss nur bei passendem Kassensturz, danach gesperrt', async () => {
    const x = randomUUID();
    await saveEntry(
      deps,
      x,
      { ...base, kind: 'ausgabe', date: '2026-08-20', description: 'Fehlbuchung', amountCents: 450n },
      'test',
    );
    await expect(cancelEntry(sql, x, '', 'test')).rejects.toThrow(/Grund/);
    await cancelEntry(sql, x, 'doppelt', 'test');
    const v = await monthView(sql, '2026-08');
    expect(v.closing).toBe(12450n);
    expect(v.rows.find((r) => r.id === x)!.saldo).toBeNull();
    await expect(closeMonth(sql, '2026-08', 12000n, 'test')).rejects.toThrow(/weicht/);
    await expect(closeMonth(sql, todayBerlin().slice(0, 7), 0n, 'test')).rejects.toThrow(/vergangene/);
    await closeMonth(sql, '2026-08', 12450n, 'test');
    await expect(
      saveEntry(
        deps,
        randomUUID(),
        { ...base, kind: 'einnahme', date: '2026-08-21', description: 'spät', amountCents: 100n },
        'test',
      ),
    ).rejects.toThrow(/abgeschlossen/);
    await expect(sql`update app.cash_entries set note = 'x' where entry_date = '2026-08-02'`).rejects.toThrow(
      /abgeschlossen/,
    );
    await expect(setOpening(sql, '2026-08', 1n, 'test')).rejects.toThrow(/abgeschlossen/);
  });

  it('Karten-Belege brauchen ein Foto und zählen nicht in der Kasse', async () => {
    await expect(
      saveCardReceipt(
        deps,
        randomUUID(),
        { date: '2026-09-01', amountCents: 999n, note: null, expectedVersion: null },
        'test',
      ),
    ).rejects.toThrow(/Pflicht/);
    await saveCardReceipt(
      deps,
      randomUUID(),
      {
        date: '2026-09-01',
        amountCents: 999n,
        note: 'Tankstelle',
        file: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), name: 't.jpg', type: 'image/jpeg' },
        expectedVersion: null,
      },
      'test',
    );
    expect((await monthView(sql, '2026-09')).closing).toBe(12450n);
  });
});
