import { describe, expect, it } from 'vitest';
import { splitByWeights, sqmCenti } from './subcontract-sites.js';

describe('Sammelbestellung', () => {
  it('Fläche als Hundertstel', () => {
    expect(sqmCenti('1.234,5')).toBe(123450n);
    expect(sqmCenti('306')).toBe(30600n);
    expect(sqmCenti('12.50')).toBe(1250n);
    expect(sqmCenti('abc')).toBeNull();
  });
  it('centgenau nach Gewichten, Rest an die größten Reste', () => {
    expect(splitByWeights(10000n, [1n, 1n, 1n])).toEqual([3334n, 3333n, 3333n]);
    expect(splitByWeights(1000n, [30000n, 10000n])).toEqual([750n, 250n]);
    expect(splitByWeights(-1001n, [1n, 1n])).toEqual([-501n, -500n]);
    expect(splitByWeights(100n, [0n, 0n])).toEqual([50n, 50n]);
  });
});
