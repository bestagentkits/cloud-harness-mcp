import { describe, expect, it, vi } from 'vitest';
import { TypesafeSkillSuggester, parseAnswer, redactPrompt, type RosterEntry } from '../src/typesafe-skill-suggester.js';
import { GATE_THRESHOLD, MAX_EGRESS_BYTES } from '../src/typesafe-questions.js';

/** A provider key in the shape model-profile-state-repository would decrypt for the redactor. */
const PROVIDER_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
const WORKSPACE_SECRET = 'super-secret-workspace-value';
const LONG_PROMPT = 'Refactor the authentication middleware so the deprecated option is removed.';

function roster(...names: string[]): RosterEntry[] {
  return names.map((name) => ({
    name,
    source: 'owner',
    contentSha256: `${name}-sha`,
    indexDescription: `${name} description`,
    descriptionFull: `${name} full description`,
    bodyExcerpt: `${name} body excerpt`
  }));
}

function answerResponse(choice: string, nouls: Record<string, number>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-1.13.0',
      answers: {
        skill: { type: 'choice', choice, confidence: 0.8, probabilities: {} },
        ...Object.fromEntries(Object.entries(nouls).map(([name, value]) => [name, { type: 'noul', noul: value }]))
      },
      usage: { input_tokens: 100, output_tokens: 20 }
    })
  };
}

/** The exact response the live endpoint returned during verification, used to pin the parser. */
const LIVE_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    pick: { type: 'choice', choice: 'alpha', confidence: 0.82, probabilities: { alpha: 0.91, beta: 0.09 } },
    clear: { type: 'noul', noul: 0.4 }
  },
  usage: { input_tokens: 329, output_tokens: 48 }
};

const HEALTHY_GATE = { acts_on_user_system: 1, would_follow_documented_procedure: 1, prose_suffices: 0 };

function suggesterWith(handler: (body: any, call: number) => unknown, overrides: Record<string, unknown> = {}) {
  let call = 0;
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    call += 1;
    return handler(JSON.parse(init.body), call) as never;
  });
  const suggester = new TypesafeSkillSuggester({
    apiKey: () => 'ts_live_key',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => Date.now(),
    ...overrides
  });
  return { suggester, fetchImpl, calls: () => call };
}

describe('answer parsing', () => {
  it('reads the shape the live endpoint actually returns', () => {
    const parsed = parseAnswer(LIVE_RESPONSE);

    expect(parsed?.choice).toBe('alpha');
    expect(parsed?.nouls.clear).toBe(0.4);
    expect(parsed?.usage).toEqual({ inputTokens: 329, outputTokens: 48 });
  });

  it('reports an unexpected shape rather than guessing at one', () => {
    expect(parseAnswer({ answer: { choice: 'alpha' } })).toBeUndefined();
    expect(parseAnswer(undefined)).toBeUndefined();
    expect(parseAnswer({ answers: 'not a map' })).toBeUndefined();
  });

  it('defaults usage to zero when the endpoint omits it', () => {
    const parsed = parseAnswer({ answers: { clear: { type: 'noul', noul: 0.5 } } });
    expect(parsed?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('prompt redaction', () => {
  it('replaces a known secret value and a recognisable key shape', () => {
    const result = redactPrompt({
      prompt: `Use ${WORKSPACE_SECRET} and Bearer abcdefghijklmnopqrst for the call`,
      secrets: { WORKSPACE_TOKEN: WORKSPACE_SECRET }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.text).not.toContain(WORKSPACE_SECRET);
    expect(result.outcome.text).toContain('[REDACTED_SECRET: WORKSPACE_TOKEN]');
    expect(result.outcome.text).toContain('[REDACTED_BEARER]');
    expect(result.outcome.count).toBeGreaterThan(0);
  });

  it('truncates a payload above the bound and marks it, rather than sending it whole', () => {
    const result = redactPrompt({ prompt: 'x'.repeat(MAX_EGRESS_BYTES * 2) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.byteLength(result.outcome.text, 'utf8')).toBeLessThanOrEqual(MAX_EGRESS_BYTES);
    expect(result.outcome.truncated).toBe(true);
    expect(result.outcome.text).toContain('[TRUNCATED]');
  });

  it('fails closed instead of returning the prompt unredacted', () => {
    const hostile = { get token(): string { throw new Error('the secret snapshot is unavailable'); } } as Record<string, string>;
    const result = redactPrompt({ prompt: LONG_PROMPT, secrets: () => hostile });

    expect(result.ok).toBe(false);
  });
});

describe('suggestion short circuit', () => {
  it('sends nothing when the kill switch is off, the roster is empty, or the prompt is too short', async () => {
    const healthy = () => answerResponse('tdd', { ...HEALTHY_GATE, 'fits::tdd': 1 });
    const disabledSuggester = suggesterWith(healthy, { enabled: () => false }).suggester;

    const disabled = await disabledSuggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd1' });
    expect(disabled.reason).toBe('disabled');

    const { suggester, fetchImpl } = suggesterWith(healthy);
    const empty = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: [], rosterDigest: 'd2' });
    expect(empty.reason).toBe('empty_roster');
    const short = await suggester.suggest({ ownerId: 'o', prompt: 'hi', roster: roster('tdd'), rosterDigest: 'd3' });
    expect(short.reason).toBe('prompt_too_short');
    const slash = await suggester.suggest({ ownerId: 'o', prompt: '/help', roster: roster('tdd'), rosterDigest: 'd4' });
    expect(slash.reason).toBe('slash_command');

    expect(fetchImpl).not.toHaveBeenCalled();
  }, 20_000);

  it('returns not_configured with zero outbound calls when no key is set', async () => {
    const fetchImpl = vi.fn();
    const suggester = new TypesafeSkillSuggester({ apiKey: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTPS endpoint before any request', async () => {
    const fetchImpl = vi.fn();
    const suggester = new TypesafeSkillSuggester({
      apiKey: () => 'ts_live_key',
      endpoint: 'http://api.typesafe.ai/v1/systemone',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('invalid_endpoint');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('redaction fail closed', () => {
  it('sends nothing and reports redaction_failed when the secret snapshot cannot be read', async () => {
    const { suggester, fetchImpl } = suggesterWith(
      () => answerResponse('tdd', { ...HEALTHY_GATE, 'fits::tdd': 1 }),
      { secrets: () => { throw new Error('keyring unavailable'); } }
    );

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('redaction_failed');
    expect(result.suggested).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts a workspace secret or a decrypted provider key in the outbound body', async () => {
    let seenBody = '';
    const { suggester } = suggesterWith((body) => {
      seenBody = JSON.stringify(body);
      return answerResponse('tdd', { ...HEALTHY_GATE, 'fits::tdd': 0.9 });
    }, {
      secrets: () => ({ WORKSPACE_TOKEN: WORKSPACE_SECRET, MODEL_OPENAI_KEY: PROVIDER_KEY })
    });

    const result = await suggester.suggest({
      ownerId: 'o',
      prompt: `Please use ${WORKSPACE_SECRET} and ${PROVIDER_KEY} to continue.`,
      roster: roster('tdd'),
      rosterDigest: 'd'
    });

    // Both sources are named explicitly, because the provider credential does not travel through the
    // workspace secret snapshot and would otherwise never be redacted.
    expect(seenBody).not.toContain(WORKSPACE_SECRET);
    expect(seenBody).not.toContain(PROVIDER_KEY);
    expect(seenBody).toContain('[REDACTED_SECRET: WORKSPACE_TOKEN]');
    expect(seenBody).toContain('[REDACTED_SECRET: MODEL_OPENAI_KEY]');
    // The result carries no prompt text and no secret.
    expect(JSON.stringify(result)).not.toContain(WORKSPACE_SECRET);
    expect(JSON.stringify(result)).not.toContain(PROVIDER_KEY);
    expect(result.redactionCount).toBeGreaterThanOrEqual(2);
  });
});

describe('gate and fit thresholds', () => {
  it('stops after the first call when the gate is below the threshold', async () => {
    // Only one gate question is satisfied, so the mean sits below the threshold.
    const belowGate = { acts_on_user_system: 1, would_follow_documented_procedure: 0, prose_suffices: 1 };
    const { suggester, fetchImpl } = suggesterWith(() => answerResponse('tdd', belowGate));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd', 'review'), rosterDigest: 'd' });

    expect(result.reason).toBe('below_gate');
    expect(result.suggested).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reranks when the gate passes but reports below_fit when no candidate fits', async () => {
    const { suggester, fetchImpl } = suggesterWith((_body, call) => call === 1
      ? answerResponse('tdd', HEALTHY_GATE)
      : answerResponse('tdd', { 'fits::tdd': GATE_THRESHOLD > 0 ? 0 : 0 }));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd', 'review'), rosterDigest: 'd' });

    expect(result.reason).toBe('below_fit');
    expect(result.suggested).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns the roster name with gate, fit, and confidence on the healthy path', async () => {
    const { suggester } = suggesterWith((_body, call) => call === 1
      ? answerResponse('tdd', HEALTHY_GATE)
      : answerResponse('tdd', { 'fits::tdd': 0.8 }));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd', 'review'), rosterDigest: 'd' });

    expect(result.suggested).toEqual({ name: 'tdd', gate: 1, fit: 0.8, confidence: 0.8 });
    expect(result.reason).toBeUndefined();
    // Usage travels with the result, because the audit row records it and the phase requires it.
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it('discards a choice the roster does not contain', async () => {
    const { suggester } = suggesterWith(() =>
      answerResponse('totally-made-up', HEALTHY_GATE));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('invalid_choice');
    expect(result.suggested).toBeNull();
  });

  it('reports an unexpected response shape instead of guessing at it', async () => {
    const { suggester } = suggesterWith(() => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('unexpected_response');
  });
});

describe('failure modes stay bounded and never throw', () => {
  it.each([
    [401, 'unauthorized'],
    [422, 'unprocessable']
  ])('maps %i to %s without a retry', async (status, reason) => {
    const { suggester, fetchImpl } = suggesterWith(() => ({ ok: false, status, json: async () => ({}) }));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, 'rate_limited'],
    [529, 'upstream_unavailable']
  ])('retries %i once before reporting %s', async (status, reason) => {
    const { suggester, fetchImpl } = suggesterWith(() => ({ ok: false, status, json: async () => ({}) }));

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a timeout rather than waiting past the budget', async () => {
    const { suggester } = suggesterWith(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('timeout');
    expect(result.suggested).toBeNull();
  });

  it('reports a connection error rather than failing the caller', async () => {
    const { suggester } = suggesterWith(() => { throw new TypeError('fetch failed'); });

    const result = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(result.reason).toBe('connection_error');
    expect(result.suggested).toBeNull();
  });
});

describe('cache and rate ceiling', () => {
  it('serves a repeated prompt from cache without a second outbound call and stores no prompt text', async () => {
    const { suggester, fetchImpl } = suggesterWith((_body, call) => call === 1
      ? answerResponse('tdd', HEALTHY_GATE)
      : answerResponse('tdd', { 'fits::tdd': 0.9 }));

    const first = await suggester.suggest({ ownerId: 'o', workspaceId: 'ws', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });
    const second = await suggester.suggest({ ownerId: 'o', workspaceId: 'ws', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'd' });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.suggested).toEqual(first.suggested);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The cache is memory-only and keyed by a digest, so no entry holds the prompt.
    const entries = JSON.stringify([...((suggester as unknown as { cache: Map<string, unknown> }).cache).entries()]);
    expect(entries).not.toContain(LONG_PROMPT);
  });

  it('returns rate_limited with no further outbound call once the minute is spent', async () => {
    const belowGate = { acts_on_user_system: 1, would_follow_documented_procedure: 0, prose_suffices: 1 };
    const { suggester, fetchImpl } = suggesterWith(() => answerResponse('tdd', belowGate));

    for (let index = 0; index < 60; index += 1) {
      await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: `d${index}` });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(60);

    const limited = await suggester.suggest({ ownerId: 'o', prompt: LONG_PROMPT, roster: roster('tdd'), rosterDigest: 'over-budget' });

    expect(limited.reason).toBe('rate_limited');
    expect(fetchImpl).toHaveBeenCalledTimes(60);
  }, 30_000);
});
