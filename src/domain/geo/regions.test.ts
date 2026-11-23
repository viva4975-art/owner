import { describe, expect, it } from 'vitest';
import { guessRegion, regionOf } from './regions.js';

describe('guessRegion', () => {
  it('erkennt Orte und PLZ', () => {
    expect(guessRegion('München')).toBe('München');
    expect(guessRegion('85748 Garching')).toBe('München');
    expect(guessRegion('Esslingen am Neckar')).toBe('Stuttgart');
    expect(guessRegion('Kirchheim unter Teck')).toBe('Stuttgart');
    expect(guessRegion('Ingolstadt')).toBe('Ingolstadt');
    expect(guessRegion('85055 Irgendwo')).toBe('Ingolstadt');
    expect(guessRegion('70499 Weilimdorf')).toBe('Stuttgart');
    expect(guessRegion('Hamburg')).toBeNull();
    expect(guessRegion('')).toBeNull();
  });
  it('eingetragene Region geht vor', () => {
    expect(regionOf({ region: 'Stuttgart', city: 'München' })).toBe('Stuttgart');
    expect(regionOf({ region: null, city: 'Ingolstadt' })).toBe('Ingolstadt');
  });
});
