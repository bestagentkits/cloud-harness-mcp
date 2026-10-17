import { describe, expect, it } from 'vitest';
import { usdPerMillionTokensToMicrosPerMillion, usdPerTokenToMicrosPerMillion } from '../src/model-catalog/pricing.js';

describe('model catalog price conversion', () => {
  it('converts models.dev USD-per-million prices without float error', () => {
    expect(usdPerMillionTokensToMicrosPerMillion(0.6)).toBe(600_000);
    expect(usdPerMillionTokensToMicrosPerMillion(2.2)).toBe(2_200_000);
    expect(usdPerMillionTokensToMicrosPerMillion(0.003625)).toBe(3_625);
    expect(usdPerMillionTokensToMicrosPerMillion(15)).toBe(15_000_000);
    expect(usdPerMillionTokensToMicrosPerMillion(0)).toBe(0);
    // A fraction of a micro rounds up, so a stored price never understates cost.
    expect(usdPerMillionTokensToMicrosPerMillion(0.0000001)).toBe(1);
    expect(usdPerMillionTokensToMicrosPerMillion(undefined)).toBeNull();
    expect(usdPerMillionTokensToMicrosPerMillion(-1)).toBeNull();
  });

  it('converts decimal USD-per-token strings to exact micros per million tokens', () => {
    expect(usdPerTokenToMicrosPerMillion('0.000003')).toBe(3_000_000);
    expect(usdPerTokenToMicrosPerMillion('0.000015')).toBe(15_000_000);
    expect(usdPerTokenToMicrosPerMillion('0.00000375')).toBe(3_750_000);
    expect(usdPerTokenToMicrosPerMillion('0.000000075')).toBe(75_000);
    expect(usdPerTokenToMicrosPerMillion('0.00000032')).toBe(320_000);
    expect(usdPerTokenToMicrosPerMillion('1')).toBe(1_000_000_000_000);
    expect(usdPerTokenToMicrosPerMillion('.5')).toBe(500_000_000_000);
  });

  it('avoids the float error a naive multiplication makes', () => {
    // In floating point 0.000000001 * 1e12 is 1000.0000000000001, which a round-up would bill as 1001.
    expect(Math.ceil(0.000000001 * 1e12)).toBe(1001);
    expect(usdPerTokenToMicrosPerMillion('0.000000001')).toBe(1_000);
    expect(usdPerTokenToMicrosPerMillion('0.0000000075')).toBe(7_500);
    expect(usdPerTokenToMicrosPerMillion('0.00000089')).toBe(890_000);
  });

  it('accepts exponent notation and finite numbers', () => {
    expect(usdPerTokenToMicrosPerMillion('3e-7')).toBe(300_000);
    expect(usdPerTokenToMicrosPerMillion('3E-7')).toBe(300_000);
    expect(usdPerTokenToMicrosPerMillion('1.5e-6')).toBe(1_500_000);
    expect(usdPerTokenToMicrosPerMillion('2e+0')).toBe(2_000_000_000_000);
    expect(usdPerTokenToMicrosPerMillion(3e-7)).toBe(300_000);
  });

  it('rounds a fraction of a micro up so a price never understates cost', () => {
    expect(usdPerTokenToMicrosPerMillion('0.0000000000001')).toBe(1);
    expect(usdPerTokenToMicrosPerMillion('0.0000030000001')).toBe(3_000_001);
    expect(usdPerTokenToMicrosPerMillion('1e-80')).toBe(1);
  });

  it('keeps an explicit zero as free', () => {
    expect(usdPerTokenToMicrosPerMillion('0')).toBe(0);
    expect(usdPerTokenToMicrosPerMillion('0.000')).toBe(0);
    expect(usdPerTokenToMicrosPerMillion(0)).toBe(0);
  });

  it('treats missing, malformed, negative, and unrepresentable prices as unknown', () => {
    for (const value of [undefined, null, '', ' ', 'abc', '1.2.3', '--1', '0x10', 'NaN', 'Infinity', '-1', '-0.000001', {}, [], Number.NaN, -1]) {
      expect(usdPerTokenToMicrosPerMillion(value)).toBeNull();
    }
    expect(usdPerTokenToMicrosPerMillion('1e60')).toBeNull();
    expect(usdPerTokenToMicrosPerMillion('9'.repeat(65))).toBeNull();
  });
});
