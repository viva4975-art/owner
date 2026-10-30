import { describe, expect, it } from 'vitest';
import { objectCosts } from './subcontract-sites.js';

describe('Sammelbestellung: Kosten je Objekt', () => {
  it('je m² und Pauschale gemischt', () => {
    const c = objectCosts('qm', 30n, [
      { sqm: '1000.00', share_cents: null, mode: 'qm', rate_cents: null }, // 0,30 € × 1000 m²
      { sqm: '500.00', share_cents: null, mode: 'qm', rate_cents: '40' }, // eigener Preis 0,40 €
      { sqm: null, share_cents: '25000', mode: 'pauschale', rate_cents: null }, // 250 € fest
    ]);
    expect(c).toEqual([30000n, 20000n, 25000n]);
  });

  it('alte Pauschale ohne Wahl je Objekt wird als Ganzes verteilt', () => {
    expect(objectCosts('pauschale_monat', 100000n, [{ sqm: '10', share_cents: null }])).toBeNull();
    expect(objectCosts('umsatz', 0n, [{ sqm: '10', share_cents: null, mode: 'qm' }])).toBeNull();
  });

  it('Pauschale je Einsatz: Preis je Objekt (Ahmed 30.10.)', () => {
    expect(objectCosts('pauschale_einsatz', 0n, [{ sqm: null, share_cents: null }])).toBeNull();
    expect(
      objectCosts('pauschale_einsatz', 0n, [
        { sqm: null, share_cents: '120000' },
        { sqm: null, share_cents: null },
      ]),
    ).toEqual([120000n, 0n]);
  });
});
