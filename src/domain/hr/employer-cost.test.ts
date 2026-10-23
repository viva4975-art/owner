import { describe, expect, it } from 'vitest';
import { employerCost, payBand, type PlanCostRates } from './employer-cost.js';

const r: PlanCostRates = {
  sv_employer_bp: 2115,
  sv_employee_bp: 2115,
  levies_bp: 220,
  accident_bp: 250,
  minijob_flat_bp: 3117,
  minijob_limit_cents: 60300n,
  midijob_upper_cents: 200000n,
  absence_bp: 1300,
};

describe('employerCost', () => {
  it('ordnet nach Lohnhöhe ein', () => {
    expect(payBand(60300n, null, r)).toBe('minijob');
    expect(payBand(60301n, null, r)).toBe('midijob');
    expect(payBand(200000n, 'sv', r)).toBe('midijob');
    expect(payBand(200001n, 'sv', r)).toBe('regulaer');
    expect(payBand(150000n, 'minijob', r)).toBe('minijob'); // Beschäftigungsart geht vor
    // Teilzeit/Vollzeit mit unvollständigem Plan bleibt sozialversicherungspflichtig (Satz an der Untergrenze ≈ 28 %)
    expect(payBand(20000n, 'sv', r)).toBe('midijob');
    const low = employerCost(20000n, 'sv', r).costCents - (20000n * 470n) / 10000n;
    expect(Number(low) / 20000).toBeCloseTo(0.28, 2);
  });

  it('Minijob: Pauschale + Unfall', () => {
    expect(employerCost(50000n, 'minijob', r)).toEqual({ band: 'minijob', costCents: 16835n }); // 500 € × 33,67 %
  });

  it('regulär: AG-Anteil + Umlagen + Unfall', () => {
    expect(employerCost(300000n, 'sv', r).costCents).toBe(77550n); // 3.000 € × 25,85 %
  });

  it('Midijob: an der Untergrenze ≈ 28 %, an der Obergrenze wie regulär', () => {
    const extra = (ae: bigint) => (ae * BigInt(r.levies_bp + r.accident_bp)) / 10000n;
    const low = employerCost(60301n, 'sv', r).costCents - extra(60301n);
    expect(Number(low) / 60301).toBeCloseTo(0.28, 2);
    const high = employerCost(200000n, 'sv', r).costCents - extra(200000n);
    expect(high).toBe(42300n); // 2.000 € × 21,15 %
    // dazwischen sinkt der AG-Satz von 28 % auf 21,15 %
    const mid = Number(employerCost(120000n, 'sv', r).costCents - extra(120000n)) / 120000;
    expect(mid).toBeGreaterThan(0.2115);
    expect(mid).toBeLessThan(0.28);
  });
});
