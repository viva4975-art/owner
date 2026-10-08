import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  adjustedNote,
  adjustedPrice,
  adjustmentCandidates,
  adjustmentLetters,
  applyPriceAdjustment,
  servicesWithoutLaborShare,
  setLaborShares,
} from './price-adjustment.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Preisanpassung – Rechnung', () => {
  it('Preis + Preis × Lohnanteil × Erhöhung, cent-genau', () => {
    expect(adjustedPrice(309986n, 8000, 500)).toBe(322385n); // 3.099,86 € + 4 % = 3.223,85 € (123,9944 → 123,99)
    expect(adjustedPrice(100n, 5000, 100)).toBe(101n); // 0,5 Cent → aufgerundet
    expect(adjustedPrice(100000n, 0, 500)).toBe(100000n);
    // 1.000 € mit 80 % Lohn: Lohn +5 % → +40 €, übrige 20 % × 3 % → +6 € = 1.046 €
    expect(adjustedPrice(100000n, 8000, 500, 300)).toBe(104600n);
    expect(adjustedPrice(100000n, 10000, 0, 300)).toBe(100000n); // reine Lohnleistung: Sachkosten wirken nicht
    expect(
      adjustedNote(
        'Zeile 1\n3.000,00 € + 3,00 % Tariflohnerhöhung ab 01.01.2026',
        309986n,
        400,
        '2027-01-01',
      ),
    ).toBe('Zeile 1\n3.099,86 € + 4,00 % Tariflohnerhöhung ab 01.01.2027');
  });
});

describe.skipIf(!available)('Preisanpassung (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const cust = randomUUID();
  const site = randomUUID();
  const monthly = randomUUID();
  const quarterly = randomUUID();
  const noShare = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'pa-'));
    await sql`insert into app.customers (id, customer_no, name, street, postal_code, city)
              values (${cust}, '29981', 'Preis Test GmbH', 'Weg 1', '80331', 'München')`;
    await sql`insert into app.sites (id, customer_id, site_no, name, street, postal_code, city)
              values (${site}, ${cust}, '2998101', 'Schule', 'Weg 2', '80331', 'München')`;
    const svc = (id: string, desc: string, price: bigint, labor: number | null, cycle: string) =>
      sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli, unit_price_cents,
                                         valid_from, labor_share_bp, billing_cycle, note)
          values (${id}, ${site}, 'monthly_flat', ${desc}, 'LS', 1000, ${price}, '2026-02-01', ${labor}, ${cycle},
                  'Unterhaltsreinigung lt. LV')`;
    await svc(monthly, 'Unterhaltsreinigung', 309986n, 8000, 'monatlich');
    await svc(quarterly, 'Glasreinigung', 120000n, 6000, 'quartalsweise');
    await svc(noShare, 'Spüldienst', 50000n, null, 'monatlich');
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('Vorschau: fehlender Anteil und Stichtag mitten im Quartal werden gesperrt', async () => {
    const rows = await adjustmentCandidates(sql, { from: '2027-01-01', raiseBp: 500 });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(monthly)!.new_price_cents).toBe(322385n);
    expect(by.get(monthly)!.blocked).toBeNull();
    expect(by.get(quarterly)!.blocked).toMatch(/Abrechnungszeitraum/); // Feb–Apr, Mai–Jul … → Januar mittendrin
    expect(by.get(noShare)!.blocked).toMatch(/Lohnkostenanteil fehlt/);
    const assumed = await adjustmentCandidates(sql, {
      from: '2027-01-01',
      raiseBp: 500,
      otherBp: 200,
      defaultLaborBp: 8000,
    });
    const ns = assumed.find((r) => r.id === noShare)!;
    expect([ns.blocked, ns.labor_assumed, ns.used_labor_bp]).toEqual([null, true, 8000]);
    expect(ns.new_price_cents).toBe(52200n); // 500 € + 20 € Lohn + 2 € Sachkosten
    await expect(adjustmentCandidates(sql, { from: '2027-01-15', raiseBp: 500 })).rejects.toThrow(
      /Monatserster/,
    );
  });

  it('Lohnanteil nachtragen: nur leere Felder', async () => {
    const mine = async () =>
      (await servicesWithoutLaborShare(sql)).filter((r) => r.site_id === site).map((r) => r.id);
    expect(await mine()).toEqual([noShare]);
    expect(
      await setLaborShares(
        sql,
        [
          { id: noShare, bp: 7000 },
          { id: monthly, bp: 1 },
        ],
        'test',
      ),
    ).toBe(1);
    expect(await mine()).toEqual([]);
  });

  it('Übernahme: alte Leistung endet, neue ab Stichtag; doppelt absenden ändert nichts; Anschreiben', async () => {
    const run = randomUUID();
    const p = {
      runId: run,
      from: '2027-02-01',
      raiseBp: 500,
      serviceIds: [monthly, quarterly, noShare],
      noteText: true,
      actor: 'test',
    };
    const r = await applyPriceAdjustment(sql, p);
    expect(r.changed).toBe(3); // Feb ist für das Quartal (ab Feb) ein Zeitraumbeginn
    expect((await applyPriceAdjustment(sql, p)).changed).toBe(0);
    const all = await sql<
      {
        description: string;
        unit_price_cents: bigint;
        valid_from: string;
        valid_to: string | null;
        note: string;
      }[]
    >`
      select description, unit_price_cents, valid_from::text, valid_to::text, note from app.site_services
       where site_id = ${site} order by description, valid_from`;
    const ur = all.filter((x) => x.description === 'Unterhaltsreinigung');
    expect(ur.map((x) => [x.valid_from, x.valid_to, x.unit_price_cents])).toEqual([
      ['2026-02-01', '2027-01-31', 309986n],
      ['2027-02-01', null, 322385n],
    ]);
    expect(ur[1]!.note).toBe(
      'Unterhaltsreinigung lt. LV\n3.099,86 € + 4,00 % Tariflohnerhöhung ab 01.02.2027',
    );
    expect(
      all.find((x) => x.description === 'Spüldienst' && x.valid_from === '2027-02-01')!.unit_price_cents,
    ).toBe(51750n);
    const pdf = await adjustmentLetters(sql, { dir, maxBytes: 5e7 }, run, 'test');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(1);
    const [f] =
      await sql`select count(*)::int as n from app.file_links where entity_type = 'customer' and entity_id = ${cust}`;
    expect(f!.n).toBe(1);
    await expect(sql`delete from app.price_adjustment_items where adjustment_id = ${run}`).rejects.toThrow(
      /unveränderbar/,
    );
  });
});
