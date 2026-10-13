import { describe, expect, it } from 'vitest';
import {
  BODY_EXCERPT_MAX,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  CALL_TIMEOUT_MS,
  DESCRIPTION_FULL_MAX,
  FITS_THRESHOLD,
  GATE_QUESTIONS,
  GATE_THRESHOLD,
  INDEX_DESCRIPTION_MAX,
  MAX_EGRESS_BYTES,
  MAX_EGRESS_CEILING,
  MIN_PROMPT_CHARS,
  RATE_LIMIT_PER_MINUTE,
  SHORTLIST,
  SHORT_CIRCUIT_REASONS,
  TOTAL_BUDGET_MS,
  TYPESAFE_ALLOWED_HOSTS,
  TYPESAFE_DEFAULT_ENDPOINT,
  gateValue,
  shortCircuitReason
} from '../src/typesafe-questions.js';

describe('typesafe question map', () => {
  it('names exactly the three gate questions the design calls for', () => {
    expect(GATE_QUESTIONS.map((question) => question.key)).toEqual([
      'acts_on_user_system', 'would_follow_documented_procedure', 'prose_suffices'
    ]);
  });

  it('inverts only the question whose agreement means a skill is not needed', () => {
    const inverted = GATE_QUESTIONS.filter((question) => question.inverted).map((question) => question.key);
    expect(inverted).toEqual(['prose_suffices']);
  });

  it('keeps every question and bound reviewable in this one module', () => {
    for (const question of GATE_QUESTIONS) expect(question.text.length).toBeGreaterThan(20);
    expect(SHORTLIST).toBe(3);
    expect(GATE_THRESHOLD).toBeGreaterThan(0);
    expect(FITS_THRESHOLD).toBeGreaterThan(0);
    expect(INDEX_DESCRIPTION_MAX).toBe(60);
    expect(DESCRIPTION_FULL_MAX).toBe(400);
    expect(BODY_EXCERPT_MAX).toBe(700);
    expect(CALL_TIMEOUT_MS).toBe(1_500);
    expect(TOTAL_BUDGET_MS).toBeGreaterThan(CALL_TIMEOUT_MS);
    expect(CACHE_TTL_MS).toBe(15 * 60_000);
    expect(CACHE_MAX_ENTRIES).toBe(500);
    expect(RATE_LIMIT_PER_MINUTE).toBe(60);
  });

  it('never lets the configured payload bound exceed the hard ceiling', () => {
    expect(MAX_EGRESS_BYTES).toBeLessThanOrEqual(MAX_EGRESS_CEILING);
    expect(MAX_EGRESS_BYTES).toBe(4_096);
    expect(MAX_EGRESS_CEILING).toBe(8_192);
  });

  it('requires an HTTPS endpoint on an allowlisted host', () => {
    expect(TYPESAFE_DEFAULT_ENDPOINT.startsWith('https://')).toBe(true);
    expect(TYPESAFE_ALLOWED_HOSTS).toContain(new URL(TYPESAFE_DEFAULT_ENDPOINT).host);
  });
});

describe('gate value', () => {
  it('averages the three questions with prose_suffices inverted', () => {
    // 1 + 1 + (1 - 1) = 2 over three questions.
    expect(gateValue({ acts_on_user_system: 1, would_follow_documented_procedure: 1, prose_suffices: 1 })).toBeCloseTo(2 / 3);
    // 1 + 1 + (1 - 0) = 3 over three questions, the strongest possible gate.
    expect(gateValue({ acts_on_user_system: 1, would_follow_documented_procedure: 1, prose_suffices: 0 })).toBeCloseTo(1);
    // Agreeing that prose suffices alone must not clear the threshold.
    expect(gateValue({ prose_suffices: 1 })).toBeLessThan(GATE_THRESHOLD);
  });

  it('counts a missing answer as zero rather than as neutral', () => {
    expect(gateValue({ acts_on_user_system: 1, would_follow_documented_procedure: 1 })).toBeCloseTo(2 / 3);
    expect(gateValue({})).toBe(0);
  });

  it('bounds an out-of-range answer instead of letting it dominate the mean', () => {
    expect(gateValue({ acts_on_user_system: 5, would_follow_documented_procedure: -3, prose_suffices: 0 })).toBeCloseTo(2 / 3);
  });
});

describe('local short circuit', () => {
  const longPrompt = 'Refactor the authentication middleware to drop the deprecated option.';

  it('returns no reason when the engine may run', () => {
    expect(shortCircuitReason({ enabled: true, rosterSize: 2, prompt: longPrompt })).toBeNull();
  });

  it('covers exactly the four reviewed reasons', () => {
    expect([...SHORT_CIRCUIT_REASONS]).toEqual(['disabled', 'empty_roster', 'prompt_too_short', 'slash_command']);
  });

  it('reports the first condition that applies, with the kill switch ahead of everything else', () => {
    expect(shortCircuitReason({ enabled: false, rosterSize: 0, prompt: 'x' })).toBe('disabled');
    expect(shortCircuitReason({ enabled: true, rosterSize: 0, prompt: longPrompt })).toBe('empty_roster');
    expect(shortCircuitReason({ enabled: true, rosterSize: 2, prompt: '/help' })).toBe('slash_command');
    expect(shortCircuitReason({ enabled: true, rosterSize: 2, prompt: 'too short' })).toBe('prompt_too_short');
  });

  it('treats a slash command with arguments as a prompt rather than a command', () => {
    expect(shortCircuitReason({ enabled: true, rosterSize: 2, prompt: '/review the middleware change' })).toBeNull();
  });

  it('measures the prompt after trimming, so whitespace cannot make a short prompt look long', () => {
    expect(shortCircuitReason({ enabled: true, rosterSize: 2, prompt: `   ${'a'.repeat(MIN_PROMPT_CHARS - 1)}   ` })).toBe('prompt_too_short');
  });
});
