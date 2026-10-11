import { describe, expect, it } from 'vitest';
import type { AccountingSettings, Booking } from './datev.js';
import { lexwareBookings } from './lexware-fibu.js';

describe('Lexware buchhaltung ASCII', () => {
  it('Feldnamen wie Lexware, Soll/Haben aus dem Kennzeichen, Periode, § 13b Zusatzangabe 10', () => {
    const s = { fiscal_year_start: '01-01', rc_tax_key: '94' } as AccountingSettings;
    const b: Booking[] = [
      {
        amount: 119000n,
        sh: 'S',
        account: '20001',
        contra: '8400',
        taxKey: '3',
        date: '2026-09-30',
        doc: '1038310',
        doc2: '',
        text: 'Rechnung 1038310; Schule',
        kind: 'ausgang',
      },
      {
        amount: 50000n,
        sh: 'H',
        account: '70001',
        contra: '3100',
        taxKey: '94',
        date: '2026-10-02',
        doc: 'NU-77',
        doc2: '',
        text: 'Reinigung NU',
        kind: 'eingang',
      },
    ];
    const lines = lexwareBookings(b, s).split('\r\n');
    expect(lines[0]).toBe(
      'Belegdatum;Buchungsdatum;Buchungsperiode;Belegnummernkreis;Belegnummer;Buchungstext;Buchungsbetrag;Sollkonto;Habenkonto;Steuerschlüssel;Kostenstelle;Kostenträger;Zusatzangaben;Leistungsdatum;EU Land;EU %;USt-IDNr.',
    );
    expect(lines[1]).toBe(
      '30.09.2026;30.09.2026;9;AR;1038310;Rechnung 1038310 Schule;1190,00;20001;8400;3;;;;;;;',
    );
    expect(lines[2]).toBe('02.10.2026;02.10.2026;10;ER;NU-77;Reinigung NU;500,00;3100;70001;94;;;10;;;;');
  });
});
