import { describe, expect, it } from 'vitest';
import { AddressBlockError, formatAddressBlock, parseAddressBlock } from './address-block.js';

describe('Anschrift als Textfeld', () => {
  it('liest Name, mehrzeiligen Zusatz, z. Hd., Straße, PLZ Ort', () => {
    const a = parseAddressBlock(
      'Münchner Wohnen GmbH\nGeschäftsbereich Süd\nKundencenter\nz. Hd. Frau Müller\nGustav-Heinemann-Ring 111\n81739 München',
    );
    expect(a).toEqual({
      name: 'Münchner Wohnen GmbH',
      name2: 'Geschäftsbereich Süd\nKundencenter',
      contactName: 'Frau Müller',
      street: 'Gustav-Heinemann-Ring 111',
      postalCode: '81739',
      city: 'München',
    });
  });

  it('erlaubt D- vor der PLZ und leere Zeilen', () => {
    const a = parseAddressBlock('Firma\n\n  Postfach 12 34  \nD-80331 München\n');
    expect(a.street).toBe('Postfach 12 34');
    expect(a.postalCode).toBe('80331');
    expect(a.name2).toBeNull();
  });

  it('lehnt fehlende PLZ-Zeile und zu kurze Anschrift ab', () => {
    expect(() => parseAddressBlock('Firma\nStraße 1\nMünchen')).toThrow(AddressBlockError);
    expect(() => parseAddressBlock('Firma\n80331 München')).toThrow(AddressBlockError);
  });

  it('format und parse passen zusammen', () => {
    const a = {
      name: 'Landeshauptstadt München',
      name2: 'Baureferat\nHochbau',
      contactName: 'Herrn Schmidt',
      street: 'Friedenstr. 40',
      postalCode: '81671',
      city: 'München',
    };
    expect(parseAddressBlock(formatAddressBlock(a))).toEqual(a);
  });
});
