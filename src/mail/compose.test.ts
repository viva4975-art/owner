import { describe, expect, it } from 'vitest';
import { buildSignature, composeMail, legalLines, parseSignature, SIGNATURE_DEFAULTS } from './compose.js';

describe('E-Mail mit Signatur', () => {
  const co = {
    legal_name: 'Viva-Deluxe Gebäudereinigung GmbH',
    street: 'Würmtalstr. 10',
    postal_code: '81375',
    city: 'München',
    phone: '+49 89 63855496',
    email: 'info@viva-deluxe-reinigung.de',
    website: 'www.viva-deluxe-reinigung.de',
    register_court: 'München',
    register_number: 'HRB 262567',
    managing_director: 'Ahmed Chomontek',
    vat_id: 'DE341586171',
  };
  it('Pflichtangaben § 35a GmbHG in der Fußzeile', () => {
    expect(legalLines(co)).toEqual([
      'Viva-Deluxe Gebäudereinigung GmbH · Sitz der Gesellschaft: München · Amtsgericht München, HRB 262567',
      'Geschäftsführer: Ahmed Chomontek · USt-ID: DE341586171',
    ]);
  });
  it('Signatur wie Outlook: Person, Zentrale, Niederlassung, Siegel, Hinweise', () => {
    const s = buildSignature(co, SIGNATURE_DEFAULTS);
    expect(s.text).toContain('E-Mail: buchhaltung@viva-deluxe-reinigung.de');
    expect(s.text).not.toContain('Mobil');
    expect(s.text).toContain('ZENTRALE MÜNCHEN');
    expect(s.text).toContain('NIEDERLASSUNG STUTTGART');
    expect(s.html).toContain('cid:sig-logo@viva-deluxe-reinigung.de');
    expect(s.html).toContain('cid:sig-badges@viva-deluxe-reinigung.de');
    expect(s.html).toContain('tel:+498963855496');
    expect(s.inline).toHaveLength(2);
    const ohne = buildSignature(co, {
      ...SIGNATURE_DEFAULTS,
      branch_title: '',
      show_badges: false,
      disclaimer: false,
    });
    expect(ohne.text).not.toContain('Stuttgart');
    expect(ohne.inline).toHaveLength(1);
    expect(ohne.html).not.toContain('vertrauliche');
  });
  it('alter Freitext wird ignoriert, Mail mit Hinweis und maskiertem HTML', () => {
    expect(parseSignature('Freitext').person_name).toBe('Buchhaltung');
    expect(parseSignature('{"person_name":"Büro"}').person_name).toBe('Büro');
    const m = composeMail({
      notice: 'TEST',
      body: 'Hallo <b>',
      signature: buildSignature(co, SIGNATURE_DEFAULTS),
    });
    expect(m.text.startsWith('TEST')).toBe(true);
    expect(m.html).toContain('Hallo &lt;b&gt;');
    expect(m.inline![0]!.content.length).toBeGreaterThan(1000);
  });
});
