import { describe, expect, it } from 'vitest';
import { sampleDocument } from './fixtures.js';
import { generateCii, generateXRechnungUbl } from './generate.js';
import { countryCodeOf, describeEInvoiceError, unitCodeOf } from './errors.js';

describe('E-Rechnung: verständliche Fehler und Bereinigung', () => {
  it('Ländercode und Einheit werden bereinigt statt abgelehnt', async () => {
    expect(countryCodeOf('Deutschland')).toBe('DE');
    expect(countryCodeOf('de')).toBe('DE');
    expect(countryCodeOf('')).toBe('DE');
    expect(unitCodeOf('Std.')).toBe('HUR');
    expect(unitCodeOf('m²')).toBe('MTK');
    const d = sampleDocument();
    await expect(
      generateCii({
        ...d,
        buyer: { ...d.buyer, countryCode: 'Deutschland' },
        lines: d.lines.map((l) => ({ ...l, unitCode: 'Std.' })),
      }),
    ).resolves.toContain('HUR');
  });
  it('nennt das fehlerhafte Feld auf Deutsch', async () => {
    const d = sampleDocument();
    const err = await generateCii({ ...d, dueDate: '' }).catch((e: unknown) => e);
    expect(describeEInvoiceError(err)).toContain('Fälligkeitsdatum');
    const err2 = await generateCii({ ...d, lines: d.lines.map((l) => ({ ...l, unitCode: 'Kiste' })) }).catch(
      (e: unknown) => e,
    );
    expect(describeEInvoiceError(err2)).toContain('Einheit einer Position (Position 1)');
    const err3 = await generateXRechnungUbl({
      ...d,
      buyer: { ...d.buyer, leitwegId: null, email: null },
    }).catch((e: unknown) => e);
    expect(describeEInvoiceError(err3)).toContain('Rechnungs-E-Mail bzw. Leitweg-ID');
  });
});
