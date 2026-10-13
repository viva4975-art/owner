import { describe, expect, it } from 'vitest';
import { unitLabel } from './types.js';

describe('unitLabel', () => {
  it('Mehrzahl bei Tagen und Monaten', () => {
    expect(unitLabel('DAY', 26000n)).toBe('Tage');
    expect(unitLabel('DAY', 1000n)).toBe('Tag');
    expect(unitLabel('MON', 2500n)).toBe('Monate');
    expect(unitLabel('DAY')).toBe('Tag');
  });
});
