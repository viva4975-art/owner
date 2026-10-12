import { describe, expect, it } from 'vitest';
import { validSvNumber, validTaxId } from './ids.js';

describe('Steuer-ID und SV-Nummer', () => {
  it('Steuer-ID: Prüfziffer und Ziffernregel', () => {
    for (const t of ['86095742719', '47036892816', '65929970489', '57549285017', '860 957 427 19'])
      expect(validTaxId(t)).toBe(true);
    for (const t of ['86095742718', '12345678901', '06095742719', '1234', ''])
      expect(validTaxId(t)).toBe(false);
  });
  it('SV-Nummer: Aufbau und Prüfziffer', () => {
    expect(validSvNumber('15070649C103')).toBe(true);
    expect(validSvNumber('65 170839 J 003')).toBe(true);
    expect(validSvNumber('65170839j003')).toBe(true);
    expect(validSvNumber('65170839J004')).toBe(false);
    expect(validSvNumber('65173339J003')).toBe(false);
    expect(validSvNumber('651708391003')).toBe(false);
  });
});
