import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  budgetData,
  computeBudget,
  ensureBudget,
  saveAdjustment,
  saveBudgetSettings,
  budgetPersons,
  budgetStale,
  getBudget,
  saveCostRow,
  setBudgetStatus,
  setPersonCategory,
  setSiteExcluded,
  splitBy,
} from './budget.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('splitBy', () => {
  it('verteilt centgenau nach Gewichten', () => {
    expect(splitBy(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(splitBy(1000n, [0n, 3n, 1n])).toEqual([0n, 750n, 250n]);
    expect(splitBy(5n, [0n, 0n])).toEqual([0n, 0n]);
  });
});

describe.skipIf(!available)('Budgetplanung', () => {
  let sql: Sql;
  const site = randomUUID();
  const worker = randomUUID();
  const lead = randomUUID();
  const office = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.sites (id, customer_id, site_no, name) values (${site}, ${DEMO.company}, '2990301', 'Budget-Objekt')`;
    await sql`insert into app.site_services (id, site_id, kind, description, unit_code, quantity_milli,
                unit_price_cents, vat_rate_bp, valid_from, billing_cycle, labor_share_bp)
              values (${randomUUID()}, ${site}, 'monthly_flat', 'Unterhaltsreinigung', 'LS', 1000, 200000, 1900, '2026-01-01', 'monatlich', 6000),
                     (${randomUUID()}, ${site}, 'special', 'Glas', 'LS', 1000, 60000, 1900, '2027-03-01', 'halbjaehrlich', null),
                     (${randomUUID()}, ${site}, 'special', 'Grundreinigung', 'LS', 1000, 100000, 1900, '2027-05-10', 'einmalig', null)`;
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, weekly_hours,
                pay_model, hourly_wage_cents, tags)
              values (${worker}, '9871', 'Rein', 'Budget', '2025-01-01', 'vollzeit', 40, 'individuell', 1500, ${[] as string[]}),
                     (${lead}, '9872', 'Leit', 'Budget', '2025-01-01', 'vollzeit', 40, 'individuell', 2000, ${['Objektleitung']}),
                     (${office}, '9873', 'Buero', 'Budget', '2025-01-01', 'teilzeit', 20, 'individuell', 1800, ${[] as string[]})`;
    const [b] = await sql<{ id: string }[]>`
      select s.id from app.sites s join app.customers c on c.id = s.customer_id where s.site_no = 'INT-BUERO'`;
    for (const wd of [1, 2, 3, 4, 5]) {
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes, valid_from)
                values (${randomUUID()}, ${worker}, ${site}, ${wd}, '06:00', '10:00', 0, '2026-01-01'),
                       (${randomUUID()}, ${lead}, ${site}, ${wd}, '10:00', '12:00', 0, '2026-01-01'),
                       (${randomUUID()}, ${office}, ${b!.id}, ${wd}, '08:00', '12:00', 0, '2026-01-01')`;
    }
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Umsatz monatlich, Turnus im Fälligkeitsmonat, einmalig, Preiserhöhung; Kosten und Gemeinkosten', async () => {
    const b = await ensureBudget(sql, 2027, 'test');
    expect(b.status).toBe('entwurf');
    await saveBudgetSettings(
      sql,
      b.id,
      {
        wage_increase_bp: 300,
        wage_increase_month: 4,
        pass_on: true,
        extra_like_prev: true,
        allocate: true,
        note: null,
      },
      'test',
    );
    await computeBudget(sql, b.id, 'test');
    const d = (await budgetData(sql, 2027))!;
    const r = d.rows.find((x) => x.site_id === site)!;
    expect(r.flat).toEqual(Array(12).fill(200000n));
    // Lohnkostenanteil 60 % × 3 % ab April = 36,00 € im Monat
    expect(r.increase.slice(0, 3)).toEqual([0n, 0n, 0n]);
    expect(r.increase.slice(3)).toEqual(Array(9).fill(3600n));
    // Glas halbjährlich ab März: März und September; Grundreinigung einmalig im Mai
    expect(r.cycle[2]).toBe(60000n);
    expect(r.cycle[8]).toBe(60000n);
    expect(r.cycle[4]).toBe(100000n);
    expect(r.cycle.filter((x) => x !== 0n).length).toBe(3);
    // Lohn: nur die Reinigungskraft am Objekt (Objektleitung → Gemeinkosten), ab April × 1,03
    expect(r.labor[0]!).toBeGreaterThan(0n);
    expect(r.minutes[0]).toBeGreaterThan(0);
    // Material 2 % vom Umsatz
    expect(r.material[0]).toBe(4000n);
    const leadRow = d.costs.find((c) => c.category === 'objektleitung')!;
    const officeRow = d.costs.find((c) => c.category === 'buero_personal')!;
    expect(leadRow.amounts[0]!).toBeGreaterThan(0n);
    expect(officeRow.amounts[0]!).toBeGreaterThan(0n);
    expect(leadRow.manual).toBe(false);
    // Gemeinkosten vollständig verteilt
    for (let i = 0; i < 12; i++) expect(d.rows.reduce((a, x) => a + x.overhead[i]!, 0n)).toBe(d.overhead[i]);
    expect(r.result[0]).toBe(r.db[0]! - r.overhead[0]!);
  });

  it('Gemeinkosten von Hand, Neugeschäft, Freigabe sperrt', async () => {
    const b = (await ensureBudget(sql, 2027, 'test'))!;
    const veh = randomUUID();
    await saveCostRow(
      sql,
      b.id,
      {
        id: veh,
        label: 'Neuer Transporter (Leasing)',
        category: 'fahrzeuge',
        amounts: Array(12).fill(50000n),
        note: null,
      },
      'test',
    );
    const ng = randomUUID();
    await saveAdjustment(
      sql,
      b.id,
      {
        id: ng,
        site_id: null,
        customer_id: null,
        label: 'Ausschreibung Schulen Lose 1–3',
        from_month: 7,
        to_month: 12,
        revenue_month: 1000000n,
        cost_month: 800000n,
        note: null,
      },
      'test',
    );
    const d = (await budgetData(sql, 2027))!;
    const n = d.rows.find((x) => x.key === `ng:${ng}`)!;
    expect(n.newBusiness).toBe(true);
    expect(n.revenue[5]).toBe(0n);
    expect(n.revenue[6]).toBe(1000000n);
    expect(n.db[6]).toBe(200000n);
    expect(d.costs.find((c) => c.id === veh)!.amounts[0]).toBe(50000n);
    await setBudgetStatus(sql, b.id, 'freigegeben', 'test');
    await expect(
      saveCostRow(
        sql,
        b.id,
        { id: randomUUID(), label: 'x', category: 'sonstiges', amounts: Array(12).fill(1n), note: null },
        'test',
      ),
    ).rejects.toThrow(/freigegeben/);
    await setBudgetStatus(sql, b.id, 'entwurf', 'test');
  });
  it('Personen je Kostenart, Zuordnung ändern, Objekt herausnehmen, Neuberechnung bei neuen Leistungen', async () => {
    const b = (await ensureBudget(sql, 2027, 'test'))!;
    const ps = await budgetPersons(sql, b.id);
    const lp = ps.find((p) => p.employee_id === lead)!;
    expect(lp.category).toBe('lead');
    expect(lp.minutes.reduce((a, x) => a + x, 0)).toBeGreaterThan(0);
    const op = ps.find((p) => p.employee_id === office)!;
    expect(op.category).toBe('office');
    let d = (await budgetData(sql, 2027))!;
    const gfBefore = d.costs.find((c) => c.category === 'geschaeftsfuehrer')!.amounts[0]!;
    await setPersonCategory(sql, b.id, office, 'gf', 'test');
    d = (await budgetData(sql, 2027))!;
    expect(d.costs.find((c) => c.category === 'geschaeftsfuehrer')!.amounts[0]).toBe(
      gfBefore + op.amounts[0]!,
    );
    await setPersonCategory(sql, b.id, office, 'auto', 'test');
    // Objekt herausnehmen: zählt nicht mehr, steht in der Liste
    await setSiteExcluded(sql, b.id, site, true, 'Baureinigung fertig', 'test');
    d = (await budgetData(sql, 2027))!;
    expect(d.rows.find((x) => x.site_id === site)).toBeUndefined();
    expect(d.excluded[0]!.revenue).toBeGreaterThan(0n);
    await setSiteExcluded(sql, b.id, site, false, null, 'test');
    // neue Leistung → Budget gilt als veraltet
    const fresh = (await getBudget(sql, 2027))!;
    expect(await budgetStale(sql, fresh)).toBe(false);
    await sql`update app.site_services set updated_at = now() + interval '1 second' where site_id = ${site}`;
    expect(await budgetStale(sql, fresh)).toBe(true);
  });
  it('Urlaub/Krank als Zuschlag auf den Lohn, Stunden von Hand am Objekt', async () => {
    const b = (await ensureBudget(sql, 2027, 'test'))!;
    const settings = {
      wage_increase_bp: b.wage_increase_bp,
      wage_increase_month: b.wage_increase_month,
      pass_on: b.pass_on,
      extra_like_prev: b.extra_like_prev,
      allocate: b.allocate,
      note: null,
    };
    await saveBudgetSettings(sql, b.id, { ...settings, vacation_days: 30, sick_days: 12 }, 'test');
    let d = (await budgetData(sql, 2027))!;
    const ab = d.absence;
    expect(ab.present).toBe(ab.workdays - ab.holidays - 42);
    expect(ab.vacation_bp).toBe(Math.round((30 / ab.present) * 10000));
    expect(ab.sick_bp).toBe(Math.round((12 / ab.present) * 10000));
    const r = d.rows.find((x) => x.site_id === site)!;
    expect(r.labor[0]).toBeGreaterThan(0n);
    expect(r.vacation[0]).toBeGreaterThan(0n);
    expect(r.direct[0]).toBe(
      r.labor[0]! + r.vacation[0]! + r.sick[0]! + r.sub[0]! + r.material[0]! + r.adjCost[0]!,
    );
    // Stunden von Hand ersetzen die Einsatzplanung (Feb–Mär)
    await saveAdjustment(
      sql,
      b.id,
      {
        id: randomUUID(),
        site_id: site,
        customer_id: null,
        label: 'Neues Objekt – Stunden laut Angebot',
        from_month: 2,
        to_month: 3,
        revenue_month: 0n,
        cost_month: 0n,
        hours_month: 100,
        wage_cents: 2000n,
        replace_plan: true,
        note: null,
      },
      'test',
    );
    d = (await budgetData(sql, 2027))!;
    const r2 = d.rows.find((x) => x.site_id === site)!;
    expect(r2.labor[1]).toBe(200000n);
    expect(r2.minutes[1]).toBe(6000);
    expect(r2.vacation[1]).toBe((200000n * BigInt(d.absence.vacation_bp) + 5000n) / 10000n);
    expect(r2.labor[0]).toBe(r.labor[0]);
    await expect(
      saveAdjustment(
        sql,
        b.id,
        {
          id: randomUUID(),
          site_id: site,
          customer_id: null,
          label: 'ohne Satz',
          from_month: 1,
          to_month: 1,
          revenue_month: 0n,
          cost_month: 0n,
          hours_month: 10,
          wage_cents: 0n,
          note: null,
        },
        'test',
      ),
    ).rejects.toThrow(/Stundensatz/);
  });
});
