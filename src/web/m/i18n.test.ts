import { describe, expect, it } from 'vitest';
import { missingKeys, t } from './i18n.js';

describe('Übersetzungen Mitarbeiter-Ansicht', () => {
  it('alle Sprachen haben alle Texte', () => {
    expect(missingKeys()).toEqual({});
  });
  it('setzt Platzhalter ein', () => {
    expect(t('ro', 'msg_in', { time: '06:00' })).toBe('Pontat la 06:00.');
    expect(t('de', 'unbekannt')).toBe('unbekannt');
  });
});
