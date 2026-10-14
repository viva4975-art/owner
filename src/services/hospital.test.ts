import { describe, expect, it } from 'vitest';
import { geocode, hospitalText, nearestHospital, pickHospital } from './hospital.js';

const origin = { lat: 48.115, lng: 11.48 };
const els = [
  { lat: 48.12, lon: 11.49, tags: { name: 'Tagesklinik Nord' } },
  { lat: 48.118, lon: 11.47, tags: { name: 'Klinik Kleinstadt' } },
  {
    center: { lat: 48.11, lon: 11.47 },
    tags: {
      name: 'LMU Klinikum Großhadern',
      emergency: 'yes',
      'addr:street': 'Marchioninistraße',
      'addr:housenumber': '15',
      'addr:postcode': '81377',
      'addr:city': 'München',
    },
  },
];

describe('Nächstes Krankenhaus', () => {
  it('nimmt das nächste mit Notaufnahme, keine Tagesklinik', () => {
    const h = pickHospital(origin, els)!;
    expect(h.name).toBe('LMU Klinikum Großhadern');
    expect(h.emergency).toBe(true);
    expect(hospitalText(h)).toMatch(
      /^LMU Klinikum Großhadern, Marchioninistraße 15, 81377 München \(ca\. \d+,\d km, Notaufnahme\)$/,
    );
  });
  it('ohne Notaufnahme in der Nähe: nächstes Krankenhaus', () => {
    const h = pickHospital(origin, [els[1]!, { ...els[2]!, center: { lat: 48.6, lon: 11.9 } }])!;
    expect(h.name).toBe('Klinik Kleinstadt');
  });
  it('fragt Nominatim (PLZ) und Overpass, Fehler → null', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.includes('nominatim')) return new Response(JSON.stringify([{ lat: '48.115', lon: '11.48' }]));
      return new Response(JSON.stringify({ elements: els }));
    };
    const o = await geocode(fake, { street: null, postal_code: '81375', city: 'München' });
    expect(o).toEqual(origin);
    expect(calls[0]).toContain('postalcode=81375');
    expect((await nearestHospital(fake, o!))?.name).toBe('LMU Klinikum Großhadern');
    const down = async () => new Response('x', { status: 503 });
    expect(await nearestHospital(down, origin)).toBeNull();
  });
});
