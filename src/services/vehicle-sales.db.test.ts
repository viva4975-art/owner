import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import {
  cancelVehicleSale,
  completeVehicleSale,
  currentSale,
  saleAmounts,
  type SaleInput,
} from './vehicle-sales.js';
import { getVehicle, saveVehicle } from './vehicles.js';

const available = await dbAvailable();

describe('Fahrzeugverkauf: Beträge', () => {
  it('Brutto ↔ Netto centgenau, steuerfrei ohne USt', () => {
    expect(saleAmounts(600000n, 'brutto', 'ust19')).toEqual({ net: 504202n, vat: 95798n, gross: 600000n });
    expect(saleAmounts(500000n, 'netto', 'ust19')).toEqual({ net: 500000n, vat: 95000n, gross: 595000n });
    expect(saleAmounts(500000n, 'brutto', 'ig')).toEqual({ net: 500000n, vat: 0n, gross: 500000n });
  });
});

describe.skipIf(!available)('Fahrzeugverkauf (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const vid = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'viva-fv-'));
    await saveVehicle(sql, vid, {
      plate: 'M-VD 77',
      make: 'VW',
      model: 'Caddy',
      vin: 'WVWZZZ1KZAW000001',
      first_registration: '2021-03-15',
      fuel: 'diesel',
      ownership: 'eigentum',
      leasing_company: null,
      leasing_until: null,
      insurer: null,
      insurance_no: null,
      hu_due: null,
      service_due: null,
      mileage: null,
      mileage_date: null,
      driver_employee_id: null,
      fuel_card: null,
      note: null,
      purchase_date: '2021-03-15',
      purchase_price: '25.000,00',
      active: true,
      expectedVersion: null,
    });
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const input = (p: Partial<SaleInput> = {}): SaleInput => ({
    saleDate: '2026-10-20',
    handoverDate: '2026-10-21',
    handoverTime: '10:00',
    buyerType: 'privat',
    buyerName: 'Max Käufer',
    buyerAddress: 'Musterstr. 1\n80331 München',
    buyerCountry: 'DE',
    buyerVatId: null,
    buyerId: null,
    buyerPhone: null,
    buyerEmail: null,
    mileage: '123.456',
    keys: '2',
    docs: ['zb1', 'zb2'],
    accessories: null,
    accidentFree: 'ja',
    damages: null,
    defects: null,
    priceInput: '6.000',
    priceIs: 'brutto',
    taxMode: 'ust19',
    payment: 'ueberweisung',
    warranty: 'einjahr',
    registration: 'abgemeldet',
    reregisterDays: null,
    note: null,
    ...p,
  });
  const cfg = () => ({ dir, maxBytes: 50_000_000 });

  it('Prüfungen, Abschluss, Storno', async () => {
    await expect(
      completeVehicleSale(
        sql,
        cfg(),
        { id: randomUUID(), vehicleId: vid, input: input({ warranty: 'ausgeschlossen' }) },
        't',
      ),
    ).rejects.toThrow(/§ 476/);
    await expect(
      completeVehicleSale(
        sql,
        cfg(),
        { id: randomUUID(), vehicleId: vid, input: input({ taxMode: 'ig' }) },
        't',
      ),
    ).rejects.toThrow(/Unternehmen/);
    const id = randomUUID();
    const s = await completeVehicleSale(sql, cfg(), { id, vehicleId: vid, input: input() }, 't');
    expect(s.sale_no).toBe('FV-2026-001');
    expect([s.net_cents, s.vat_cents, s.gross_cents]).toEqual([504202n, 95798n, 600000n]);
    // doppelt absenden = derselbe Verkauf
    expect((await completeVehicleSale(sql, cfg(), { id, vehicleId: vid, input: input() }, 't')).sale_no).toBe(
      'FV-2026-001',
    );
    let v = (await getVehicle(sql, vid))!;
    expect([v.active, v.sold_on, v.sale_price_cents, v.buyer]).toEqual([
      false,
      '2026-10-20',
      600000n,
      'Max Käufer',
    ]);
    await expect(
      completeVehicleSale(sql, cfg(), { id: randomUUID(), vehicleId: vid, input: input() }, 't'),
    ).rejects.toThrow(/schon verkauft/);

    const st = await cancelVehicleSale(
      sql,
      cfg(),
      { id: randomUUID(), saleId: s.id, reason: 'Rücktritt' },
      't',
    );
    expect([st.kind, st.gross_cents, st.sale_no]).toEqual(['storno', -600000n, 'FV-2026-002']);
    v = (await getVehicle(sql, vid))!;
    expect([v.active, v.sold_on]).toEqual([true, null]);
    expect(await currentSale(sql, vid)).toBeNull();
    await expect(
      cancelVehicleSale(sql, cfg(), { id: randomUUID(), saleId: s.id, reason: 'x' }, 't'),
    ).rejects.toThrow(/schon storniert/);

    // steuerfrei an EU-Unternehmen
    const ig = await completeVehicleSale(
      sql,
      cfg(),
      {
        id: randomUUID(),
        vehicleId: vid,
        input: input({
          buyerType: 'unternehmen',
          buyerName: 'Auto GmbH',
          buyerAddress: 'Hauptstr. 2\n1010 Wien',
          buyerCountry: 'AT',
          buyerVatId: 'ATU12345678',
          taxMode: 'ig',
          warranty: 'ausgeschlossen',
        }),
      },
      't',
    );
    expect([ig.vat_cents, ig.gross_cents]).toEqual([0n, 600000n]);
    const [f] = await sql`select category from app.file_links where file_id = ${ig.file_id}`;
    expect(f?.category).toBe('Verkauf');
  });
});
