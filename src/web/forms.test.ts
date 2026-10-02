import { describe, expect, it } from 'vitest';
import { centsToInput, milliToInput, parseLines } from './forms.js';

describe('Formular-Helfer', () => {
  it('Cent/Menge ↔ Eingabefeld', () => {
    expect(centsToInput(123456n)).toBe('1234,56');
    expect(centsToInput(-5n)).toBe('-0,05');
    expect(milliToInput(2500n)).toBe('2,5');
    expect(milliToInput(1000n)).toBe('1');
  });

  it('liest Positionen und ignoriert Leerzeilen', () => {
    const lines = parseLines({
      desc: ['Unterhaltsreinigung', '', 'Regie'],
      detail: ['', '', '12.09.'],
      qty: ['1', '', '2,5'],
      unit: ['MON', 'C62', 'HUR'],
      price: ['1.850,00', '', '27,35'],
      vat: ['1900', '1900', '1900'],
      src: ['', '', ''],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ quantity: 2500n, unitPrice: 2735n, detail: '12.09.' });
  });

  it('meldet Fehler mit Positionsnummer', () => {
    expect(() => parseLines({ desc: ['A'], qty: ['1'], price: ['1,234'], vat: ['1900'] })).toThrow(
      /Position 1: Einzelpreis/,
    );
    expect(() => parseLines({ desc: ['A'], qty: ['-1'], price: ['1'], vat: ['1900'] })).toThrow(
      /negative Mengen/,
    );
    expect(
      parseLines({ desc: ['A'], qty: ['-1'], price: ['1'], vat: ['1900'] }, { allowNegative: true }),
    ).toHaveLength(1);
    expect(() => parseLines({ desc: ['A'], qty: ['1'], price: ['-1'], vat: ['1900'] })).toThrow(
      /nicht negativ/,
    );
    expect(() => parseLines({ desc: ['A'], qty: ['1'], price: ['1'], vat: ['0'] })).toThrow(/Steuersatz/);
  });
});
