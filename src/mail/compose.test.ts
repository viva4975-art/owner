import { describe, expect, it } from 'vitest';
import { autoSignature, composeMail } from './compose.js';

describe('E-Mail mit Signatur', () => {
  const co = {
    legal_name: 'Viva-Deluxe Gebäudereinigung GmbH',
    street: 'Würmtalstr. 10',
    postal_code: '81375',
    city: 'München',
    phone: '+49 89 63855496',
    fax: null,
    email: 'info@viva-deluxe-reinigung.de',
    website: 'www.viva-deluxe-reinigung.de',
    register_court: 'München',
    register_number: 'HRB 262 567',
    managing_director: 'Ahmed Chomontek',
    vat_id: 'DE341586171',
  };
  it('Pflichtangaben § 35a GmbHG in der automatischen Signatur', () => {
    const s = autoSignature(co);
    expect(s).toContain('Geschäftsführer: Ahmed Chomontek');
    expect(s).toContain('Sitz: München');
    expect(s).toContain('Amtsgericht München HRB 262 567');
    expect(s).not.toContain('Fax');
  });
  it('Text und HTML mit Logo, Hinweis oben, Links, HTML maskiert', () => {
    const m = composeMail({ notice: 'TEST', body: 'Hallo <b>\n\nZeile', signature: autoSignature(co) });
    expect(m.text.startsWith('TEST')).toBe(true);
    expect(m.text).toContain('Mit freundlichen Grüßen');
    expect(m.html).toContain('Hallo &lt;b&gt;');
    expect(m.html).toContain('cid:logo@viva-deluxe-reinigung.de');
    expect(m.html).toContain('mailto:info@viva-deluxe-reinigung.de');
    expect(m.html).toContain('https://www.viva-deluxe-reinigung.de');
    expect(m.inline![0]!.content.length).toBeGreaterThan(1000);
  });
});
