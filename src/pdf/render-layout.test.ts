import { describe, expect, it } from 'vitest';
import { sampleDocument } from '../einvoice/fixtures.js';
import { renderInvoicePdf, splitLineDetail } from './render.js';

describe('Rechnungs-PDF: Objekt und Zeitraum aus dem Positionstext', () => {
  it('trennt Objekt, Adresse und Zeitraum vom Zusatztext', () => {
    const r = splitLineDetail(
      '3.099,86 € + 5,07% Tariflohnerhöhung\nObjekt: Baubüro VE30 (2000201)\nRichelstr. 1c, 80634 München\n01.09.2026 bis 30.09.2026',
    );
    expect(r.place).toEqual({
      title: 'Baubüro VE30 (2000201)',
      address: 'Richelstr. 1c, 80634 München',
      key: 'Baubüro VE30 (2000201)|Richelstr. 1c, 80634 München',
    });
    expect(r.period).toBe('01.09.2026 bis 30.09.2026');
    expect(r.rest).toBe('3.099,86 € + 5,07% Tariflohnerhöhung');
  });
  it('ohne Objekt bleibt der Text unverändert', () => {
    expect(splitLineDetail('12.09.2026, 2 Mitarbeiter')).toEqual({
      place: null,
      period: null,
      rest: '12.09.2026, 2 Mitarbeiter',
    });
  });
  it('Sammelrechnung mit mehreren Objekten wird erzeugt', async () => {
    const d = sampleDocument();
    const l = (n: string) => ({ ...d.lines[0]!, detail: `Objekt: ${n}\nA-Str. 1, 80331 München` });
    const pdf = await renderInvoicePdf({ ...d, lines: [l('A (1)'), l('A (1)'), l('B (2)')] });
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
