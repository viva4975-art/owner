import { describe, expect, it } from 'vitest';
import {
  cents,
  divRoundHalfUp,
  formatEuro,
  lineNet,
  parseEuro,
  parseQuantity,
  toXmlDecimal,
  vatAmount,
} from './money.js';
import { computeTotals } from './totals.js';

describe('parseEuro', () => {
  it.each([
    ['1.234,56', 123456n],
    ['1234.56', 123456n],
    ['12', 1200n],
    ['0,1', 10n],
    ['-5,05', -505n],
    [' 2.500,00 ', 250000n],
  ])('%s → %s Cent', (input, expected) => {
    expect(parseEuro(input)).toBe(expected);
  });

  it.each(['1,234', 'abc', '', '1,2,3'])('lehnt "%s" ab', (input) => {
    expect(() => parseEuro(input)).toThrow(RangeError);
  });
});

describe('Rundung', () => {
  it('rundet kaufmännisch half-up, symmetrisch um 0', () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(-5n, 10n)).toBe(-1n);
    expect(divRoundHalfUp(-4n, 10n)).toBe(0n);
  });

  it('0,1 + 0,2 = 0,3 (kein Fließkomma)', () => {
    expect(parseEuro('0,1') + parseEuro('0,2')).toBe(parseEuro('0,3'));
  });

  it('lehnt nicht-ganzzahlige number-Beträge ab', () => {
    expect(() => cents(0.1)).toThrow(RangeError);
  });
});

describe('lineNet / vatAmount', () => {
  it('2,5 Regiestunden × 27,35 € = 68,38 € (68,375 aufgerundet)', () => {
    expect(lineNet(parseQuantity('2,5'), parseEuro('27,35'))).toBe(6838n);
  });

  it('19 % USt auf 68,38 € = 12,99 €', () => {
    expect(vatAmount(cents(6838), 1900)).toBe(1299n);
  });

  it('Storno: negative Beträge runden spiegelbildlich', () => {
    expect(lineNet(parseQuantity('-2,5'), parseEuro('27,35'))).toBe(-6838n);
    expect(vatAmount(cents(-6838), 1900)).toBe(-1299n);
  });
});

describe('computeTotals', () => {
  it('rechnet USt auf die Summe je Steuersatz, nicht je Position', () => {
    const t = computeTotals(
      Array.from({ length: 3 }, () => ({
        quantity: parseQuantity('1'),
        unitPrice: parseEuro('0,03'),
        vatRate: 1900,
      })),
    );
    // 3 × 0,03 €: je Position gerundet wäre USt 3 × 0,01 € = 0,03 €;
    // korrekt auf die Summe: 19 % von 0,09 € = 0,0171 → 0,02 €
    expect(t.netTotal).toBe(9n);
    expect(t.vatTotal).toBe(2n);
    expect(t.grossTotal).toBe(11n);
  });

  it('trennt Steuersätze', () => {
    const t = computeTotals([
      { quantity: parseQuantity('1'), unitPrice: parseEuro('1.850,00'), vatRate: 1900 },
      { quantity: parseQuantity('2'), unitPrice: parseEuro('10,00'), vatRate: 700 },
    ]);
    expect(t.vat).toEqual([
      { vatRate: 1900, taxableAmount: 185000n, taxAmount: 35150n },
      { vatRate: 700, taxableAmount: 2000n, taxAmount: 140n },
    ]);
    expect(t.grossTotal).toBe(185000n + 2000n + 35150n + 140n);
  });
});

describe('Formatierung', () => {
  it('formatEuro', () => {
    expect(formatEuro(cents(123456789))).toBe('1.234.567,89 €');
    expect(formatEuro(cents(-5))).toBe('-0,05 €');
  });

  it('toXmlDecimal', () => {
    expect(toXmlDecimal(cents(185000))).toBe('1850.00');
    expect(toXmlDecimal(cents(-1299))).toBe('-12.99');
  });
});
