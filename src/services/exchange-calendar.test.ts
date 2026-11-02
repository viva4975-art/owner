import { describe, expect, it } from 'vitest';
import { normalizeEwsUrl } from './exchange-calendar.js';

describe('normalizeEwsUrl', () => {
  it('liest Rechnername, SMTP-Adresse, OWA und volle Adresse', () => {
    expect(normalizeEwsUrl('')).toBe('');
    expect(normalizeEwsUrl('exchange2019.ionos.de')).toBe('https://exchange2019.ionos.de/EWS/Exchange.asmx');
    expect(normalizeEwsUrl('smtp.exchange2019.ionos.de:587')).toBe(
      'https://exchange2019.ionos.de/EWS/Exchange.asmx',
    );
    expect(normalizeEwsUrl('https://exchange2019.ionos.de/owa/')).toBe(
      'https://exchange2019.ionos.de/EWS/Exchange.asmx',
    );
    expect(normalizeEwsUrl('http://x.example.com/EWS/Exchange.asmx')).toBe(
      'https://x.example.com/EWS/Exchange.asmx',
    );
    expect(() => normalizeEwsUrl('kein server')).toThrow(/ungültig/);
  });
});
