import { describe, expect, it } from 'vitest';
import { countDays, workDaysLabel } from './subcontract-days.js';

describe('NU je Tag: Arbeitstage im Monat', () => {
  const base = { validFrom: '2026-01-01', validTo: null, closures: [] };
  it('Mo–Fr ohne Feiertage', () => {
    expect(countDays('2026-10', { ...base, workDays: null })).toEqual({ days: 22, holidays: 0, closed: 0 });
    // Dezember 2026: 23 Werktage, davon 25./26.12. (Fr/Sa) – Freitag zählt als Feiertag
    expect(countDays('2026-12', { ...base, workDays: null })).toEqual({ days: 22, holidays: 1, closed: 0 });
  });
  it('gewählte Wochentage, Beginn mitten im Monat, Schließzeiten', () => {
    expect(countDays('2026-10', { ...base, workDays: [1, 3, 5] }).days).toBe(13);
    expect(countDays('2026-10', { ...base, validFrom: '2026-10-15', workDays: null }).days).toBe(12);
    const r = countDays('2026-10', {
      ...base,
      workDays: null,
      closures: [{ date_from: '2026-10-26', date_to: '2026-10-30' }],
    });
    expect(r).toEqual({ days: 17, holidays: 0, closed: 5 });
  });
  it('Beschriftung', () => {
    expect(workDaysLabel(null)).toBe('Mo–Fr');
    expect(workDaysLabel([1, 3, 5])).toBe('Mo, Mi, Fr');
    expect(workDaysLabel([1, 2, 3, 4, 5, 6])).toBe('Mo–Sa');
  });
});
