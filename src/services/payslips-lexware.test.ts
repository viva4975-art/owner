import { describe, expect, it } from 'vitest';
import { lexwareName, monthFromText, monthLabel, payslipFileName } from './payslips.js';

describe('Lexware-Dateinamen', () => {
  it('Personalnummer und Monat aus „Lohnabrechnung_2025_August_1234_Name.pdf“, auch im Ordner und mit #U-Umlauten', () => {
    expect(lexwareName('Lohnabrechnung_2025_August_1234_Muster_Max.pdf')).toEqual({
      no: '1234',
      month: '2025-08',
    });
    expect(
      lexwareName(
        'Viva-Deluxe_Geb#U00e4udereinigung_GmbH_2026_M#U00e4rz/X_Y_1012/Lohnabrechnung_2026_M#U00e4rz_1012_X_Y.pdf',
      ),
    ).toEqual({ no: '1012', month: '2026-03' });
    expect(lexwareName('Abrechnung.pdf')).toBeNull();
  });
});

describe('Monat aus dem Text', () => {
  it('beschriftete Monate, sonst nichts', () => {
    expect(monthFromText('Abrechnungsmonat: August 2025 Pers.-Nr. 12')).toBe('2025-08');
    expect(monthFromText('Lohnabrechnung  Maerz 2026')).toBe('2026-03');
    expect(monthFromText('Abrechnungszeitraum 09/2026')).toBe('2026-09');
    expect(monthFromText('Eintritt 01.08.2025')).toBeNull();
    expect(monthLabel('2025-03')).toBe('März 2025');
    expect(payslipFileName('2025-08', 'Anna Muster', '1234')).toBe(
      'Lohnabrechnung 2025-08 August 2025 – Anna Muster (1234).pdf',
    );
  });
});
