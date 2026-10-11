import { describe, expect, it } from 'vitest';
import { payrollLexwareAscii } from './payroll.js';

describe('Lexware ASCII-Export', () => {
  it('Personalnummer;Lohnart;Stunden;Betrag, ohne Unbezahlt und ohne Lohnarten ohne Nummer', () => {
    const row = {
      personnel_no: '1234',
      wage_cents: 1500n,
      minutes: { normal: 600, urlaub: 480, unbezahlt: 120, nacht: 90 },
      surchargeCents: { nacht: 675n, sonntag: 0n, feiertag: 0n, feiertag_hoch: 0n },
      overtimeCents: 0n,
    };
    const { text, missing } = payrollLexwareAscii(
      [row as never],
      { wage_type_numbers: { normal: '1000', nacht: '2010', unbezahlt: '9' } } as never,
      [{ personnel_no: '1234', minutes: { normal: -60 } } as never],
    );
    expect(text).toBe('1234;1000;10,00;\r\n1234;2010;1,50;6,75\r\n1234;1000;-1,00;\r\n');
    expect(missing).toEqual(['urlaub']);
  });
});
