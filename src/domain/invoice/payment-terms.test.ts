import { describe, expect, it } from 'vitest';
import {
  applyTermsChoice,
  isPreset,
  parseTermsKey,
  termsKey,
  termsLabel,
  TERMS_PRESETS,
} from './payment-terms.js';

describe('Zahlungsbedingungen', () => {
  it('Standard steht oben: 10 Tage netto ohne Skonto', () => {
    expect(termsLabel(TERMS_PRESETS[0]!)).toBe('10 Tage netto ohne Skonto');
  });
  it('Text und Schlüssel', () => {
    const t = parseTermsKey('20/3/7')!;
    expect(t).toEqual({ days: 20, skontoBp: 300, skontoDays: 7 });
    expect(termsLabel(t)).toBe('20 Tage netto, 3 % Skonto bei Zahlung in 7 Tagen');
    expect(termsKey(t)).toBe('20/3/7');
    expect(isPreset(t)).toBe(true);
    expect(isPreset({ days: 21, skontoBp: null, skontoDays: null })).toBe(false);
  });
  it('Auswahl füllt die Einzelfelder, „andere“ lässt sie', () => {
    const n = { days: 'd', percent: 'p', skontoDays: 's' };
    expect(applyTermsChoice({ t: '30/2/10' }, 't', n)).toMatchObject({ d: '30', p: '2', s: '10' });
    expect(applyTermsChoice({ t: '10' }, 't', n)).toMatchObject({ d: '10', p: '', s: '' });
    expect(applyTermsChoice({ t: 'andere', d: '21' }, 't', n)).toMatchObject({ d: '21' });
  });
});
