import { describe, expect, it } from 'vitest';
import { sollMinutesFor } from './soll.js';

describe('Soll mit 4,33 Wochen je Monat', () => {
  it('voller Monat = Wochenstunden × 4,33', () => {
    expect(sollMinutesFor(20, '2026-09-01', '2026-09-30')).toBe(Math.round(20 * 60 * 4.33));
    expect(sollMinutesFor(39, '2026-02-01', '2026-02-28')).toBe(Math.round(39 * 60 * 4.33));
  });
  it('angebrochener Monat anteilig, über Monatsgrenzen', () => {
    expect(sollMinutesFor(30, '2026-09-16', '2026-09-30')).toBe(Math.round((30 * 60 * 4.33 * 15) / 30));
    expect(sollMinutesFor(10, '2026-01-01', '2026-12-31')).toBe(Math.round(10 * 60 * 4.33 * 12));
  });
});
