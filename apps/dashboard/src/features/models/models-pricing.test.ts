import { describe, expect, it } from 'vitest';
import {
  availabilityLabel,
  catalogFreshnessNotice,
  CUSTOM_PRICE_LABEL,
  CATALOG_PRICE_LABEL,
  dollarsFromMicros,
  formatPrice,
  formatSavedPrice,
  microsFromDollars,
  parseSpendLimit,
  parseWarnPercent,
  pricingReviewContext,
  pricingReviewNotice,
  priceProvenanceText,
  profileVerification,
  savedPriceProvenance,
  SPEND_DEFAULT_WARN_PERCENT,
  SPEND_LIMIT_MAX_MICROS,
  spendAmount,
  UNKNOWN_SAVED_PRICE,
  verificationLabel,
  verificationTone
} from './models-pricing';
import type { ModelProfile } from './models-types';

describe('microsFromDollars and dollarsFromMicros', () => {
  it.each([
    ['1.5', 1_500_000],
    ['0', 0],
    ['0.000001', 1],
    ['12.345678', 12_345_678],
    ['  2  ', 2_000_000],
    ['000012.5', 12_500_000]
  ])('reads %j as %d micro-USD', (text, micros) => {
    expect(microsFromDollars(text)).toBe(micros);
  });

  it.each([
    ['1.1234567', 'more than six decimals'],
    ['-1', 'negative'],
    ['abc', 'not a number'],
    ['1e3', 'exponent notation'],
    ['.5', 'no whole part'],
    ['1.', 'no digits after the point'],
    ['', 'empty'],
    ['999999999999', 'more than twelve whole digits'],
    ['9007199254.740992', 'one micro above the safe integer range'],
    [null, 'null'],
    [undefined, 'undefined']
  ])('refuses %j (%s) as unknown', (text, label) => {
    expect(microsFromDollars(text as string | null | undefined), label).toBeNull();
  });

  it('accepts exactly the largest safe integer of micro-USD', () => {
    expect(microsFromDollars('9007199254.740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [0, '0.00'],
    [1, '0.000001'],
    [10, '0.00001'],
    [1_000_000, '1.00'],
    [1_500_000, '1.50'],
    [1_234_567, '1.234567'],
    [Number.MAX_SAFE_INTEGER, '9007199254.740991']
  ])('writes %d micro-USD as %j', (micros, text) => {
    expect(dollarsFromMicros(micros)).toBe(text);
  });

  it.each([null, undefined, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('writes %s as an empty field, never zero', (micros) => {
    expect(dollarsFromMicros(micros)).toBe('');
  });

  it('round-trips every safe integer it is given', () => {
    for (const micros of [0, 1, 10, 999_999, 1_000_000, 1_500_000, 1_234_567, 987_654_321_098, Number.MAX_SAFE_INTEGER]) {
      expect(microsFromDollars(dollarsFromMicros(micros))).toBe(micros);
    }
  });
});

describe('price display', () => {
  it('shows a known price in dollars and an unknown price in words', () => {
    expect(formatPrice(0)).toBe('$0.00');
    expect(formatPrice(1_500_000)).toBe('$1.50');
    expect(formatPrice(null)).toBe('Unknown');
    expect(formatPrice(undefined)).toBe('Unknown');
  });

  it('charges an unknown saved price conservatively, never as free', () => {
    expect(formatSavedPrice(null)).toBe(UNKNOWN_SAVED_PRICE);
    expect(formatSavedPrice(0)).toBe('$0.00');
    expect(formatSavedPrice(2_000_000)).toBe('$2.00');
  });
});

describe('priceProvenanceText', () => {
  it('says there is no published price when provenance is missing or none', () => {
    expect(priceProvenanceText(null)).toBe('No published price. Enter the price your provider bills.');
    expect(priceProvenanceText({ source: 'none' })).toBe('No published price. Enter the price your provider bills.');
  });

  it('names the source and shows confidence for a catalog price', () => {
    const retrievedAt = Date.UTC(2026, 9, 1, 8, 30);
    expect(priceProvenanceText({ source: 'openrouter', confidence: 'high', retrievedAt })).toBe(`Source: OpenRouter · confidence: high · retrieved ${new Date(retrievedAt).toLocaleString()}`);
  });

  it('omits confidence for a price the operator typed or a saved one', () => {
    expect(priceProvenanceText({ source: 'user', confidence: 'high' })).toBe('Source: entered by you');
    expect(priceProvenanceText({ source: 'saved', confidence: 'high' })).toBe('Source: saved on this profile');
  });

  it('describes an unrecognised source without naming it', () => {
    expect(priceProvenanceText({ source: 'mystery', confidence: 'low' })).toBe('Source: unknown source · confidence: low');
  });
});

describe('savedPriceProvenance', () => {
  it('reads a revision with no provenance as an override of unknown confidence', () => {
    expect(savedPriceProvenance(null)).toEqual({
      isOverride: true,
      badge: CUSTOM_PRICE_LABEL,
      text: 'Source: entered by you · confidence: unknown',
      retrievedAt: null
    });
  });

  it('marks a catalog-sourced revision as a catalog price', () => {
    expect(savedPriceProvenance({ source: 'provider', confidence: 'high', isOverride: false, retrievedAt: 5 })).toEqual({
      isOverride: false,
      badge: CATALOG_PRICE_LABEL,
      text: 'Source: provider · confidence: high',
      retrievedAt: 5
    });
  });

  it('treats a missing isOverride flag as an override', () => {
    expect(savedPriceProvenance({ source: 'provider', confidence: 'high' }).isOverride).toBe(true);
  });
});

describe('pricingReviewNotice and pricingReviewContext', () => {
  it('raises nothing unless the catalog price changed', () => {
    expect(pricingReviewNotice(null)).toBeNull();
    expect(pricingReviewNotice({ state: 'current' })).toBeNull();
    expect(pricingReviewNotice({ state: 'unknown' })).toBeNull();
  });

  it('names an override that differs from the catalog', () => {
    expect(pricingReviewNotice({ state: 'repriced', isOverride: true })).toEqual({ isOverride: true, text: 'Differs from catalog' });
  });

  it('gives the largest absolute change to one decimal place', () => {
    expect(pricingReviewNotice({ state: 'repriced', isOverride: false, changes: [{ percent: 12.36 }, { percent: -7.5 }] })).toEqual({
      isOverride: false,
      text: 'Catalog price changed by 12.4% since saved'
    });
  });

  it('falls back to a plain notice when no change percentage is known', () => {
    expect(pricingReviewNotice({ state: 'repriced', isOverride: false, changes: [] })).toEqual({ isOverride: false, text: 'Catalog price changed since saved' });
    expect(pricingReviewNotice({ state: 'repriced', isOverride: false, changes: [{ percent: null }] })).toEqual({ isOverride: false, text: 'Catalog price changed since saved' });
  });

  it('shows the catalog age only for a repriced or unknown review', () => {
    expect(pricingReviewContext({ state: 'repriced', catalogRetrievedAt: 100 })).toEqual({ unknown: false, comparedAt: 100, conditional: false });
    expect(pricingReviewContext({ state: 'current', catalogRetrievedAt: 100 })).toEqual({ unknown: false, comparedAt: null, conditional: false });
  });

  it('reports an unknown review only when there is a catalog to compare with', () => {
    expect(pricingReviewContext({ state: 'unknown', catalogRetrievedAt: 100 }, { hasCatalog: true })).toEqual({ unknown: true, comparedAt: 100, conditional: false });
    expect(pricingReviewContext({ state: 'unknown', catalogRetrievedAt: 100 }, { hasCatalog: false })).toEqual({ unknown: false, comparedAt: 100, conditional: false });
  });

  it('flags a catalog that also prices by conditions a saved price cannot express', () => {
    expect(pricingReviewContext({ state: 'repriced', catalogHasConditionalPricing: true }).conditional).toBe(true);
    expect(pricingReviewContext(null)).toEqual({ unknown: false, comparedAt: null, conditional: false });
  });
});

describe('verification copy', () => {
  it.each([
    ['verified', 'Verified', 'success'],
    ['limited', 'Limited', 'warning'],
    ['failed', 'Failed', 'danger'],
    ['not_tested', 'Not verified', 'neutral']
  ] as const)('labels %s as %j with tone %s', (outcome, label, tone) => {
    expect(verificationLabel(outcome)).toBe(label);
    expect(verificationTone(outcome)).toBe(tone);
  });

  it('reads an unknown or missing outcome as not verified', () => {
    expect(verificationLabel(null)).toBe('Not verified');
    expect(verificationLabel('bogus')).toBe('Not verified');
    expect(verificationTone(undefined)).toBe('neutral');
  });
});

describe('profileVerification', () => {
  const profile = (patch: Partial<Pick<ModelProfile, 'lastVerification' | 'activeRevisionId'>>) => ({ activeRevisionId: 'rev-1', ...patch }) as Pick<ModelProfile, 'lastVerification' | 'activeRevisionId'>;

  it('reports not tested when there is no check', () => {
    expect(profileVerification(null)).toEqual({ outcome: 'not_tested', checkedAt: null, current: false });
    expect(profileVerification(profile({ lastVerification: null }))).toEqual({ outcome: 'not_tested', checkedAt: null, current: false });
  });

  it('applies a check to the revision it checked', () => {
    expect(profileVerification(profile({ lastVerification: { revisionId: 'rev-1', outcome: 'verified', checkedAt: 111 } }))).toEqual({ outcome: 'verified', checkedAt: 111, current: true });
  });

  it('reads an earlier revision\'s check as not verified while keeping when it ran', () => {
    expect(profileVerification(profile({ lastVerification: { revisionId: 'rev-0', outcome: 'verified', checkedAt: 111 } }))).toEqual({ outcome: 'not_tested', checkedAt: 111, current: false });
  });

  it('never treats a check without a revision as current', () => {
    expect(profileVerification(profile({ activeRevisionId: null, lastVerification: { revisionId: null, outcome: 'limited', checkedAt: 7 } }))).toEqual({ outcome: 'not_tested', checkedAt: 7, current: false });
  });
});

describe('catalogFreshnessNotice', () => {
  it('says nothing without freshness data', () => {
    expect(catalogFreshnessNotice(null)).toBeNull();
    expect(catalogFreshnessNotice(undefined)).toBeNull();
  });

  it('is quiet when the catalog is fresh', () => {
    const fetchedAt = Date.UTC(2026, 9, 20, 9, 0);
    expect(catalogFreshnessNotice({ state: 'fresh', fetchedAt })).toEqual({ level: 'fresh', text: `Catalog updated ${new Date(fetchedAt).toLocaleString()}.` });
    expect(catalogFreshnessNotice({ state: 'fresh' })).toEqual({ level: 'fresh', text: 'Catalog is up to date.' });
  });

  it('warns on a stale catalog and names each failing source', () => {
    const fetchedAt = Date.UTC(2026, 9, 19, 9, 0);
    expect(catalogFreshnessNotice({
      state: 'stale',
      fetchedAt,
      sources: [{ source: 'openrouter', error: 'rate_limited' }, { source: 'provider', error: 'timeout' }]
    })).toEqual({
      level: 'stale',
      text: `Showing the last good catalog from ${new Date(fetchedAt).toLocaleString()} (OpenRouter: rate limited; provider: timeout). Prices and availability may be out of date.`
    });
  });

  it('omits the time and reason when neither is known for a stale catalog', () => {
    expect(catalogFreshnessNotice({ state: 'stale' })).toEqual({ level: 'stale', text: 'Showing the last good catalog. Prices and availability may be out of date.' });
  });

  it('reports an unavailable catalog and offers the manual route', () => {
    expect(catalogFreshnessNotice({ state: 'unavailable', sources: [{ source: 'provider', error: 'upstream_down' }, { source: 'openrouter', error: null }] })).toEqual({
      level: 'unavailable',
      text: 'The catalog is unavailable right now (provider: upstream down). Enter the model ID yourself, or refresh.'
    });
  });
});

describe('availabilityLabel', () => {
  it('describes each availability and reads anything else as unknown', () => {
    expect(availabilityLabel('listed_for_credential')).toBe('Listed for your key');
    expect(availabilityLabel('public_catalog')).toBe('Public catalog, unverified for your key');
    expect(availabilityLabel('unknown')).toBe('Availability unknown');
    expect(availabilityLabel(null)).toBe('Availability unknown');
    expect(availabilityLabel('something-else')).toBe('Availability unknown');
  });
});

describe('spend limits', () => {
  it.each([
    ['25', 25_000_000],
    ['$12.50', 12_500_000],
    ['$ 12.5', 12_500_000],
    ['0.000001', 1],
    ['1000000', SPEND_LIMIT_MAX_MICROS]
  ])('parses %j as %d micro-USD', (text, micros) => {
    expect(parseSpendLimit(text)).toEqual({ micros });
  });

  it.each([
    [null, 'Enter a limit in US dollars.'],
    ['   ', 'Enter a limit in US dollars.'],
    ['-5', 'Enter an amount above $0.'],
    ['0', 'Enter an amount above $0.'],
    ['0.000000', 'Enter an amount above $0.'],
    ['.', 'Enter a dollar amount such as 25 or 12.50.'],
    ['abc', 'Enter a dollar amount such as 25 or 12.50.'],
    ['1.1234567', 'Use at most six decimal places.'],
    ['1000000.000001', 'Keep the limit at or below $1,000,000.']
  ])('refuses %j with fixed copy', (text, error) => {
    expect(parseSpendLimit(text as string | null)).toEqual({ error });
  });

  it('accepts a warning threshold from 1 to 100 percent only', () => {
    expect(parseWarnPercent('80')).toEqual({ percent: 80 });
    expect(parseWarnPercent(' 1 ')).toEqual({ percent: 1 });
    expect(parseWarnPercent('100')).toEqual({ percent: 100 });
    expect(SPEND_DEFAULT_WARN_PERCENT).toBe(80);
  });

  it.each(['0', '101', '1.5', '', 'abc', '-1', '1000'])('refuses the threshold %j', (text) => {
    expect(parseWarnPercent(text)).toEqual({ error: 'Enter a whole percentage from 1 to 100.' });
  });

  it('shows an estimated amount in dollars and never a blank', () => {
    expect(spendAmount(1_500_000)).toBe('$1.50');
    expect(spendAmount(null)).toBe('$0.00');
    expect(spendAmount(-5)).toBe('$0.00');
    expect(spendAmount(Number.NaN)).toBe('$0.00');
  });
});
