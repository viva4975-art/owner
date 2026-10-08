import { describe, expect, it } from 'vitest';
import { distanceMeters, judgePosition, parseCoordinates } from './geo.js';

describe('Standort beim Stempeln', () => {
  it('Entfernung (Marienplatz → Stachus ≈ 790 m)', () => {
    const d = distanceMeters(48.137154, 11.575382, 48.139126, 11.565972);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(800);
  });
  it('Bewertung zugunsten der Mitarbeitenden (Genauigkeit wird abgezogen)', () => {
    const site = { lat: 48.137154, lng: 11.575382, radius: 250 };
    expect(judgePosition(site, { lat: 48.1372, lng: 11.5755, acc: 20 }).status).toBe('am_objekt');
    expect(judgePosition(site, { lat: 48.139126, lng: 11.565972, acc: 30 }).status).toBe('entfernt');
    expect(judgePosition(site, { lat: 48.139126, lng: 11.565972, acc: 600 }).status).toBe('am_objekt');
    expect(judgePosition(site, { lat: 48.2, lng: 11.6, acc: 3000 }).status).toBe('ungenau');
    expect(judgePosition(site, null).status).toBe('kein_standort');
    expect(judgePosition({ lat: null, lng: null, radius: 250 }, null).status).toBe('objekt_ohne_standort');
  });
  it('Koordinaten aus Google-Maps-Link oder Text', () => {
    expect(parseCoordinates('https://www.google.com/maps/place/X/@48.1371543,11.5753822,17z')).toEqual({
      lat: 48.1371543,
      lng: 11.5753822,
    });
    expect(parseCoordinates('https://maps.google.com/?q=48.13,11.57')).toEqual({ lat: 48.13, lng: 11.57 });
    expect(parseCoordinates('48,137 ; 11,575')).toEqual({ lat: 48.137, lng: 11.575 });
    expect(parseCoordinates('Musterstraße 1')).toBeNull();
  });
});
