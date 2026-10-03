import { describe, expect, it } from 'vitest';
import { parseEuro, parseQuantity } from '../money/money.js';
import {
  type ServiceForRun,
  calculateDraft,
  cancellationLines,
  monthBounds,
  billingPeriod,
  monthlyRunLines,
  prepaidTotal,
  addDays,
  skontoTerms,
  todayBerlin,
} from './calc.js';

const pauschale = {
  description: 'Unterhaltsreinigung Pauschale',
  quantity: parseQuantity('1'),
  unitCode: 'MON',
  unitPrice: parseEuro('1.850,00'),
  vatRate: 1900,
};
const regie = {
  description: 'Regiestunden',
  quantity: parseQuantity('2,5'),
  unitCode: 'HUR',
  unitPrice: parseEuro('27,35'),
  vatRate: 1900,
};

describe('calculateDraft', () => {
  it('nummeriert Positionen und rechnet Cent-genau', () => {
    const d = calculateDraft([pauschale, regie]);
    expect(d.lines.map((l) => [l.position, l.netAmount])).toEqual([
      [1, 185000n],
      [2, 6838n],
    ]);
    expect(d.net).toBe(191838n);
    expect(d.vat).toBe(36449n); // 19 % von 1.918,38 = 364,4922 → 364,49
    expect(d.gross).toBe(228287n);
    expect(d.payable).toBe(228287n);
  });

  it('Schlussrechnung zieht Abschläge (brutto) ab', () => {
    const prepaid = prepaidTotal([
      { grossAmount: parseEuro('1.000,00') },
      { grossAmount: parseEuro('500,00') },
    ]);
    const d = calculateDraft([pauschale], prepaid);
    expect(d.gross).toBe(220150n);
    expect(d.prepaid).toBe(150000n);
    expect(d.payable).toBe(70150n);
  });
});

describe('Storno', () => {
  it('hebt das Original Cent-genau auf', () => {
    const original = calculateDraft([pauschale, regie]);
    const storno = calculateDraft(cancellationLines([pauschale, regie]));
    expect(storno.net).toBe(-original.net);
    expect(storno.vat).toBe(-original.vat);
    expect(storno.gross).toBe(-original.gross);
    expect(original.gross + storno.gross).toBe(0n);
  });

  it('lässt Einzelpreise positiv (BR-27)', () => {
    for (const l of cancellationLines([pauschale, regie])) {
      expect(l.unitPrice > 0n).toBe(true);
      expect(l.quantity < 0n).toBe(true);
    }
  });
});

describe('Monatslauf', () => {
  const base: ServiceForRun = {
    id: 's1',
    kind: 'monthly_flat',
    description: 'Unterhaltsreinigung',
    unitCode: 'MON',
    quantity: parseQuantity('1'),
    unitPrice: parseEuro('1.850,00'),
    vatRate: 1900,
    validFrom: '2026-01-01',
    validTo: null,
    active: true,
  };

  it('nimmt nur aktive, gültige Monatspauschalen', () => {
    const lines = monthlyRunLines(
      [
        base,
        { ...base, id: 's2', kind: 'hourly' },
        { ...base, id: 's3', active: false },
        { ...base, id: 's4', validFrom: '2026-10-01' },
        { ...base, id: 's5', validTo: '2026-08-31' },
        { ...base, id: 's6', validFrom: '2026-09-15' },
      ],
      '2026-09',
    );
    expect(lines.map((l) => l.sourceServiceId)).toEqual(['s1', 's6']);
    expect(lines[0]?.detail).toBe('01.09.2026 bis 30.09.2026');
  });

  it('Abrechnungszyklen: fällig ab Leistungsbeginn alle n Monate, Zeitraum über n Monate', () => {
    expect(billingPeriod('monatlich', '2026-01-15', '2026-09')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(billingPeriod('quartalsweise', '2026-02-01', '2026-02')).toEqual({
      start: '2026-02-01',
      end: '2026-04-30',
    });
    expect(billingPeriod('quartalsweise', '2026-02-01', '2026-03')).toBeNull();
    expect(billingPeriod('quartalsweise', '2026-02-01', '2026-11')).toEqual({
      start: '2026-11-01',
      end: '2027-01-31',
    });
    expect(billingPeriod('jaehrlich', '2025-06-04', '2026-06')).toEqual({
      start: '2026-06-01',
      end: '2027-05-31',
    });
    expect(billingPeriod('halbjaehrlich', '2026-01-01', '2025-12')).toBeNull(); // vor Beginn
    const q = { ...base, id: 'q', cycle: 'quartalsweise' as const, validFrom: '2026-07-01' };
    expect(monthlyRunLines([q], '2026-08')).toHaveLength(0);
    const [l] = monthlyRunLines([q], '2026-10');
    expect(l?.detail).toBe('01.10.2026 bis 31.12.2026');
    // endet vor dem Zeitraum → nicht abrechnen
    expect(monthlyRunLines([{ ...q, validTo: '2026-09-30' }], '2026-10')).toHaveLength(0);
  });

  it('Positionstext wie Fortytools', () => {
    const [line] = monthlyRunLines(
      [{ ...base, note: '3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026' }],
      '2026-09',
      {
        siteNo: '2000201',
        name: 'Baubüro VE30',
        street: 'Richelstr. 1c',
        postalCode: '80634',
        city: 'München',
      },
    );
    expect(line?.detail).toBe(
      '3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026\nObjekt: Baubüro VE30 (2000201)\nRichelstr. 1c, 80634 München\n01.09.2026 bis 30.09.2026',
    );
  });

  it('Monatsgrenzen inkl. Schaltjahr', () => {
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(() => monthBounds('2026-13')).toThrow(RangeError);
  });
});

describe('todayBerlin', () => {
  it('nutzt deutsche Zeit (23:30 UTC am 31.12. = 01.01. in Berlin)', () => {
    expect(todayBerlin(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });
});

describe('Skonto', () => {
  it('rechnet wie Fortytools (Rechnung 1038193)', () => {
    const s = skontoTerms(parseEuro('3.875,89'), 300, 7, '2026-09-25');
    expect(s.amount).toBe(11628n);
    expect(s.payable).toBe(375961n);
    expect(s.date).toBe('2026-10-02');
  });

  it('Datum über Monats- und Jahresgrenze', () => {
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDays('2028-02-25', 4)).toBe('2028-02-29');
  });
});
