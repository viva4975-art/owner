import { describe, expect, it } from 'vitest';
import type { Cents, Quantity, VatRate } from '../money/money.js';
import { countWorkDays, monthlyRunLines } from './calc.js';

const base = {
  id: 's1',
  kind: 'monthly_flat' as const,
  description: 'Tagespauschale',
  quantity: 1000n as Quantity,
  unitPrice: 10000n as Cents,
  vatRate: 1900 as VatRate,
  validFrom: '2026-01-01',
  validTo: null,
  active: true,
};

describe('Leistung nach Arbeitstagen', () => {
  it('zählt Wochentage ohne Feiertage (Bayern)', () => {
    // Oktober 2026: 22 Werktage Mo–Fr, davon 03.10. Samstag → kein Abzug
    expect(countWorkDays('2026-10-01', '2026-10-31', [1, 2, 3, 4, 5])).toEqual({ days: 22, holidays: 0 });
    // Dezember 2026: 23 Mo–Fr, 25.12. (Fr) Feiertag
    expect(countWorkDays('2026-12-01', '2026-12-31', [1, 2, 3, 4, 5]).holidays).toBe(1);
  });
  it('Menge je Monat: Tage bzw. Tage × Std. je Tag', () => {
    const [d] = monthlyRunLines([{ ...base, unitCode: 'DAY', workDays: [1, 2, 3, 4, 5] }], '2026-10');
    expect(d!.quantity).toBe(22000n);
    const [h] = monthlyRunLines(
      [{ ...base, unitCode: 'HUR', workDays: [1, 3], hoursPerDay: 2500n as Quantity }],
      '2026-10',
    );
    // Oktober 2026: 4 Montage + 4 Mittwoche = 8 Tage × 2,5 Std.
    expect(h!.quantity).toBe(20000n);
  });
  it('Beginn mitten im Monat zählt anteilig', () => {
    const [d] = monthlyRunLines(
      [{ ...base, unitCode: 'DAY', workDays: [1, 2, 3, 4, 5], validFrom: '2026-10-15' }],
      '2026-10',
    );
    expect(d!.quantity).toBe(12000n);
  });
});
