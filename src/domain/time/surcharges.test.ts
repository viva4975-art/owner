import { describe, expect, it } from 'vitest';
import { isHighHoliday, surchargeCents, surchargeMinutes } from './surcharges.js';

// Berliner Ortszeit → Date (Oktober 2026: Sommerzeit bis 25.10., UTC+2)
const at = (iso: string, off = 2) => new Date(new Date(`${iso}:00Z`).getTime() - off * 3600e3);

describe('Zuschläge RTV Gebäudereinigung', () => {
  it('Nachtarbeit 22–6 Uhr', () => {
    const r = surchargeMinutes(at('2026-10-06T20:00'), at('2026-10-07T02:00'), null, null);
    expect(r).toEqual({ nacht: 240, sonntag: 0, feiertag: 0, feiertag_hoch: 0 });
  });
  it('Pause zählt nicht', () => {
    const r = surchargeMinutes(
      at('2026-10-06T22:00'),
      at('2026-10-07T05:00'),
      at('2026-10-07T01:00'),
      at('2026-10-07T01:30'),
    );
    expect(r.nacht).toBe(390);
  });
  it('Sonntag schlägt Nacht (nur der höchste)', () => {
    // So 11.10.2026 04:00 – 08:00
    const r = surchargeMinutes(at('2026-10-11T04:00'), at('2026-10-11T08:00'), null, null);
    expect(r).toEqual({ nacht: 0, sonntag: 240, feiertag: 0, feiertag_hoch: 0 });
  });
  it('Feiertag (Tag der Deutschen Einheit) und hoher Feiertag (1. Mai)', () => {
    expect(surchargeMinutes(at('2026-10-03T06:00'), at('2026-10-03T10:00'), null, null).feiertag).toBe(240);
    expect(surchargeMinutes(at('2026-05-01T06:00'), at('2026-05-01T08:00'), null, null).feiertag_hoch).toBe(
      120,
    );
    expect(isHighHoliday('2026-04-05')).toBe(true); // Ostersonntag
    expect(isHighHoliday('2026-05-24')).toBe(true); // Pfingstsonntag
    expect(isHighHoliday('2026-10-03')).toBe(false);
  });
  it('Zeitumstellung (25.10.2026, Uhr springt 3 → 2)', () => {
    // Sa 24.10. 23:00 MESZ bis So 25.10. 05:00 MEZ = 7 Std. Arbeit; Sa 23–24 Nacht, So 0–5 Sonntag
    const r = surchargeMinutes(at('2026-10-24T23:00', 2), at('2026-10-25T05:00', 1), null, null);
    expect(r.nacht + r.sonntag).toBe(420);
    expect(r.nacht).toBe(60);
  });
  it('Betrag cent-genau', () => {
    // 90 Min. × 15,00 € × 25 % = 5,625 € → 5,63 €
    expect(surchargeCents(90, 1500n, 2500)).toBe(563n);
  });
});
