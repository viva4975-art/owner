import { describe, expect, it } from 'vitest';
import { siteInput } from './masterdata.js';

// Feste IDs aus md5(...)::uuid sind keine RFC-UUIDs (Version/Variante beliebig) – Formulare müssen sie annehmen.
describe('feste IDs (md5)', () => {
  it('Objekt beim internen Kunden anlegen', () => {
    const r = siteInput.safeParse({
      customer_id: '5e43d2f5-7a8c-0b4a-ef3e-7c0b2a9d1e44',
      site_no: 'INT-SONDER',
      name: 'Sonderreinigung',
      street: 'Würmtalstr. 10',
      postal_code: '81375',
      city: 'München',
    });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});
