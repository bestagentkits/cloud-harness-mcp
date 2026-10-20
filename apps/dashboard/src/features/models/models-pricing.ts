import type { CatalogFreshness, ModelProfile, PriceProvenance, PricingReview, VerificationOutcome } from './models-types';

/**
 * Money, price provenance and verification copy for Models & Budgets, ported from the
 * classic Dashboard's pure helpers with the same rules and wording. Prices are integer
 * micro-USD; conversions use BigInt so no binary fraction rounds a price or a limit, and an
 * unknown price is said in words, never shown as $0.
 */

/** Decimal-safe dollars to integer micro-USD; null for anything not a non-negative amount with at most six decimals. */
export function microsFromDollars(text: string | null | undefined): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const micros = BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/** Integer micro-USD to a dollar string; null (unknown) becomes an empty field, never `0`. */
export function dollarsFromMicros(micros: number | null | undefined): string {
  if (micros === null || micros === undefined || !Number.isSafeInteger(micros) || micros < 0) return '';
  const fraction = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${Math.floor(micros / 1_000_000)}.${fraction}`;
}

/** A price for display. An unknown price says so. */
export function formatPrice(micros: number | null | undefined): string {
  const dollars = dollarsFromMicros(micros);
  return dollars ? `$${dollars}` : 'Unknown';
}

export const UNKNOWN_SAVED_PRICE = 'Unknown (charged conservatively)';
export const CUSTOM_PRICE_LABEL = 'Custom price (override)';
export const CATALOG_PRICE_LABEL = 'Catalog price';
export const KEPT_PRICE_LABEL = 'Saved price (unchanged)';
export const PRICING_UNKNOWN_TEXT = 'No catalog price to compare with';
export const CONDITIONAL_PRICING_TEXT = 'The catalog also prices this model by conditions a saved price cannot express, so the charge can differ from this estimate.';

/** A price pinned on a saved revision; unknown is charged at a conservative default, never as free. */
export function formatSavedPrice(micros: number | null | undefined): string {
  const dollars = dollarsFromMicros(micros);
  return dollars ? `$${dollars}` : UNKNOWN_SAVED_PRICE;
}

const PRICE_SOURCE_LABELS: Record<string, string> = { provider: 'provider', openrouter: 'OpenRouter', user: 'entered by you', saved: 'saved on this profile' };
const timeText = (epoch: number) => new Date(epoch).toLocaleString();

/** Plain-language provenance for a draft price: where it came from, how sure, and when. */
export function priceProvenanceText(provenance: PriceProvenance | null | undefined): string {
  if (!provenance || provenance.source === 'none') return 'No published price. Enter the price your provider bills.';
  const parts = [`Source: ${PRICE_SOURCE_LABELS[provenance.source] ?? 'unknown source'}`];
  if (provenance.confidence && provenance.source !== 'user' && provenance.source !== 'saved') parts.push(`confidence: ${provenance.confidence}`);
  if (Number.isFinite(provenance.retrievedAt)) parts.push(`retrieved ${timeText(provenance.retrievedAt as number)}`);
  return parts.join(' · ');
}

/** Where a saved revision's prices came from; no provenance reads as an override of unknown confidence. */
export function savedPriceProvenance(provenance: PriceProvenance | null | undefined) {
  const recorded = provenance ?? { source: 'user', confidence: 'unknown', isOverride: true, retrievedAt: null };
  const isOverride = recorded.isOverride !== false;
  return {
    isOverride,
    badge: isOverride ? CUSTOM_PRICE_LABEL : CATALOG_PRICE_LABEL,
    text: [`Source: ${PRICE_SOURCE_LABELS[recorded.source] ?? 'unknown source'}`, `confidence: ${recorded.confidence ?? 'unknown'}`].join(' · '),
    retrievedAt: Number.isFinite(recorded.retrievedAt) ? recorded.retrievedAt as number : null
  };
}

/** The repricing warning for a saved revision, or null when there is nothing to act on. */
export function pricingReviewNotice(review: PricingReview | null | undefined): { isOverride: boolean; text: string } | null {
  if (review?.state !== 'repriced') return null;
  if (review.isOverride) return { isOverride: true, text: 'Differs from catalog' };
  const percents = (review.changes ?? []).map((change) => change.percent).filter((percent): percent is number => Number.isFinite(percent)).map(Math.abs);
  if (!percents.length) return { isOverride: false, text: 'Catalog price changed since saved' };
  return { isOverride: false, text: `Catalog price changed by ${Number(Math.max(...percents).toFixed(1))}% since saved` };
}

/** The notes beside the repricing warning. A provider without a catalog never has a price to compare with. */
export function pricingReviewContext(review: PricingReview | null | undefined, { hasCatalog = true } = {}) {
  const state = review?.state;
  const showsAge = state === 'repriced' || state === 'unknown';
  return {
    unknown: state === 'unknown' && hasCatalog,
    comparedAt: showsAge && Number.isFinite(review?.catalogRetrievedAt) ? review?.catalogRetrievedAt as number : null,
    conditional: review?.catalogHasConditionalPricing === true
  };
}

const VERIFICATION_LABELS: Record<VerificationOutcome, string> = { verified: 'Verified', limited: 'Limited', failed: 'Failed', not_tested: 'Not verified' };
export const VERIFICATION_TONES = { verified: 'success', limited: 'warning', failed: 'danger', not_tested: 'neutral' } as const;

export function verificationLabel(outcome: string | null | undefined): string {
  return VERIFICATION_LABELS[outcome as VerificationOutcome] ?? 'Not verified';
}

export function verificationTone(outcome: string | null | undefined) {
  return VERIFICATION_TONES[outcome as VerificationOutcome] ?? 'neutral';
}

/** A stored check applies only to the revision it checked; a newer revision reads as not verified. */
export function profileVerification(profile: Pick<ModelProfile, 'lastVerification' | 'activeRevisionId'> | null | undefined) {
  const last = profile?.lastVerification;
  if (!last) return { outcome: 'not_tested' as VerificationOutcome, checkedAt: null, current: false };
  const current = last.revisionId !== null && last.revisionId === profile?.activeRevisionId;
  return { outcome: current ? last.outcome : 'not_tested' as VerificationOutcome, checkedAt: last.checkedAt, current };
}

/** One summary of catalog freshness: quiet when fresh, a warning when stale, an error when unavailable. */
export function catalogFreshnessNotice(freshness: CatalogFreshness | null | undefined): { level: 'fresh' | 'stale' | 'unavailable'; text: string } | null {
  if (!freshness) return null;
  const failing = (freshness.sources ?? []).filter((source) => source.error)
    .map((source) => `${source.source === 'openrouter' ? 'OpenRouter' : 'provider'}: ${String(source.error).replace(/_/g, ' ')}`);
  const reason = failing.length ? ` (${failing.join('; ')})` : '';
  const when = Number.isFinite(freshness.fetchedAt) ? timeText(freshness.fetchedAt as number) : null;
  if (freshness.state === 'fresh') return { level: 'fresh', text: when ? `Catalog updated ${when}.` : 'Catalog is up to date.' };
  if (freshness.state === 'stale') return { level: 'stale', text: `Showing the last good catalog${when ? ` from ${when}` : ''}${reason}. Prices and availability may be out of date.` };
  return { level: 'unavailable', text: `The catalog is unavailable right now${reason}. Enter the model ID yourself, or refresh.` };
}

const AVAILABILITY_LABELS: Record<string, string> = {
  listed_for_credential: 'Listed for your key',
  public_catalog: 'Public catalog, unverified for your key',
  unknown: 'Availability unknown'
};

export function availabilityLabel(availability: string | null | undefined): string {
  return AVAILABILITY_LABELS[availability ?? 'unknown'] ?? 'Availability unknown';
}

/* ───────────── Spend limits ───────────── */

/** The largest limit a spend policy accepts, in micro-USD ($1,000,000). */
export const SPEND_LIMIT_MAX_MICROS = 1_000_000_000_000;
export const SPEND_DEFAULT_WARN_PERCENT = 80;

/** US dollars typed by the operator to integer micro-USD, using integer maths only. */
export function parseSpendLimit(text: string | null | undefined): { micros: number; error?: undefined } | { error: string; micros?: undefined } {
  const raw = String(text ?? '').trim().replace(/^\$\s*/, '');
  if (!raw) return { error: 'Enter a limit in US dollars.' };
  if (raw.startsWith('-')) return { error: 'Enter an amount above $0.' };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(raw);
  const whole = match?.[1] ?? '';
  const fraction = match?.[2] ?? '';
  if (!match || (!whole && !fraction)) return { error: 'Enter a dollar amount such as 25 or 12.50.' };
  if (fraction.length > 6) return { error: 'Use at most six decimal places.' };
  const micros = BigInt(whole || '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n) return { error: 'Enter an amount above $0.' };
  if (micros > BigInt(SPEND_LIMIT_MAX_MICROS)) return { error: 'Keep the limit at or below $1,000,000.' };
  return { micros: Number(micros) };
}

/** A warning threshold typed as a whole percentage from 1 to 100. */
export function parseWarnPercent(text: string | null | undefined): { percent: number; error?: undefined } | { error: string; percent?: undefined } {
  const raw = String(text ?? '').trim();
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) return { error: 'Enter a whole percentage from 1 to 100.' };
  return { percent: Number(raw) };
}

/** An estimated amount in dollars; never blank, so a zero reads as $0.00. */
export function spendAmount(micros: number | null | undefined): string {
  return `$${dollarsFromMicros(Number.isSafeInteger(micros) && (micros as number) >= 0 ? micros : 0)}`;
}
