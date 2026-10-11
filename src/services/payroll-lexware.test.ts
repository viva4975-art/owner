import { describe, expect, it } from 'vitest';
import { payrollLexwareAscii, proratedSalary, salaryTypeOf } from './payroll.js';

const bp = { nacht: 3000, sonntag: 8000, feiertag: 8000, feiertag_hoch: 15000 };
const zeroCents = { nacht: 0n, sonntag: 0n, feiertag: 0n, feiertag_hoch: 0n };

describe('Lexware ASCII-Export', () => {
  it('Jahr;Monat;Personalnummer;Lohnartnummer;Wert – Stunden, Zuschlag als Betrag, ohne Lohnarten ohne Nummer', () => {
    const row = {
      personnel_no: '1234',
      name: 'Muster, Max',
      wage_cents: 1500n,
      salary: null,
      bp,
      minutes: { normal: 600, urlaub: 480, nacht: 90 },
      surchargeCents: { ...zeroCents, nacht: 675n },
      overtimeCents: 0n,
    };
    const { text, missing } = payrollLexwareAscii(
      [row as never],
      { wage_type_numbers: { normal: '1000', nacht: '2010' }, overtime_bp: 2500 } as never,
      '2026-09',
      [
        {
          personnel_no: '1234',
          name: 'Muster, Max',
          minutes: { normal: -60, nacht: -30 },
          cents: { nacht: -225n },
        },
      ] as never,
    );
    expect(text).toBe(
      '2026;9;1234;1000;10,00\r\n2026;9;1234;2010;6,75\r\n2026;9;1234;1000;-1,00\r\n2026;9;1234;2010;-2,25\r\n',
    );
    expect(missing).toEqual(['urlaub']);
  });

  it('Festgehalt: Gehaltsbetrag statt Grundlohn-Stunden, Zuschläge bleiben; Minijob-Stunden als Aushilfslohn', () => {
    const gf = {
      personnel_no: '1',
      name: 'Chef',
      wage_cents: 4000n,
      salary: { type: 'gf_gehalt', cents: 500000n },
      bp,
      minutes: { normal: 9000, urlaub: 480, nacht: 60 },
      surchargeCents: { ...zeroCents, nacht: 1200n },
      overtimeCents: 0n,
    };
    const mini = {
      personnel_no: '2',
      name: 'Aushilfe',
      wage_cents: 1500n,
      salary: null,
      bp,
      minutes: { aushilfslohn: 1800 },
      surchargeCents: zeroCents,
      overtimeCents: 0n,
    };
    const { text } = payrollLexwareAscii(
      [gf, mini] as never,
      {
        wage_type_numbers: {
          normal: '1000',
          urlaub: '1100',
          nacht: '2010',
          gf_gehalt: '300',
          aushilfslohn: '500',
        },
        overtime_bp: 2500,
      } as never,
      '2026-11',
    );
    expect(text).toBe('2026;11;1;300;5000,00\r\n2026;11;1;2010;12,00\r\n2026;11;2;500;30,00\r\n');
  });

  it('Gehalts-Lohnart und anteiliges Gehalt', () => {
    expect(salaryTypeOf({ employment_type: 'vollzeit', tags: ['Geschäftsführer'] })).toBe('gf_gehalt');
    expect(salaryTypeOf({ employment_type: 'minijob', tags: [] })).toBe('aushilfsgehalt');
    expect(salaryTypeOf({ employment_type: 'vollzeit', tags: null })).toBe('gehalt');
    expect(proratedSalary(300000n, '2026-09-01', '2026-09-30', '2026-09-16', null)).toBe(150000n);
    expect(proratedSalary(300000n, '2026-09-01', '2026-09-30', '2020-01-01', null)).toBe(300000n);
  });
});
