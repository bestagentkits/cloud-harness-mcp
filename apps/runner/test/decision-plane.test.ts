import { describe, expect, it, vi } from 'vitest';
import { RunnerConfigSchema, type DecisionAnswer, type DecisionRequest } from '@cloud-harness/contracts';
import { DecisionPlane, type DecisionProvider, type DecisionTrace, type ProviderEvaluation } from '../src/decision-plane/decision-plane.js';
import { percentile } from '../src/decision-plane/decision-metrics.js';
import { JevDecisionProvider, parseJevAnswers } from '../src/decision-plane/jev-provider.js';
import { rankFromAnswers, rerankDecisionRequest, rerankTools } from '../src/decision-plane/tool-router.js';
import { FailureIntelligence, diagnosisFromAnswers, failureDecisionRequest } from '../src/decision-plane/failure-intelligence.js';
import { createRunnerDecisionPlane } from '../src/decision-plane/runner-decision-plane.js';
import { redactPrompt } from '../src/typesafe-skill-suggester.js';

const request: DecisionRequest = {
  purpose: 'mcp-routing',
  state: 'deploy the app',
  questions: [
    { kind: 'choice', key: 'pick', question: 'Which?', options: { a: 'first', b: 'second' } },
    { kind: 'boolean', key: 'clear', question: 'Clear?' }
  ]
};

function staticProvider(evaluation: ProviderEvaluation | (() => Promise<ProviderEvaluation>)): DecisionProvider & { calls: number } {
  const provider = {
    name: 'static',
    calls: 0,
    async evaluate(): Promise<ProviderEvaluation> {
      provider.calls += 1;
      return typeof evaluation === 'function' ? await evaluation() : evaluation;
    }
  };
  return provider;
}

const decided = (answers: Record<string, DecisionAnswer>): ProviderEvaluation =>
  ({ ok: true, model: 'jev-test', answers, inputTokens: 10, outputTokens: 2, inputBytes: 100, redactionCount: 0 });

const goodAnswers: Record<string, DecisionAnswer> = {
  pick: { kind: 'choice', value: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
  clear: { kind: 'boolean', probability: 0.8 }
};

function plane(provider: DecisionProvider | undefined, options: Partial<ConstructorParameters<typeof DecisionPlane>[0]> = {}) {
  const traces: DecisionTrace[] = [];
  const instance = new DecisionPlane({
    purposes: ['mcp-routing', 'failure-classification'],
    providerFor: () => provider,
    record: (_owner, trace) => traces.push(trace),
    ...options
  });
  return { instance, traces };
}

const describeAnswers = () => ({ selected: 'b', confidence: 0.9, policyEffect: 'rerank' });

describe('DecisionPlane', () => {
  it('makes no call for a purpose the operator did not enable', async () => {
    const provider = staticProvider(decided(goodAnswers));
    const { instance, traces } = plane(provider, { purposes: [] });
    const outcome = await instance.evaluate('owner', request, describeAnswers);
    expect(outcome).toMatchObject({ ok: false, reason: 'purpose_disabled' });
    expect(provider.calls).toBe(0);
    expect(traces).toHaveLength(0);
  });

  it('falls back when the owner has no provider configured', async () => {
    const { instance, traces } = plane(undefined);
    expect(await instance.evaluate('owner', request, describeAnswers)).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(traces[0]).toMatchObject({ outcome: 'fallback', fallbackReason: 'not_configured' });
  });

  it('returns validated answers and records a scalar-only trace', async () => {
    const { instance, traces } = plane(staticProvider(decided(goodAnswers)));
    const outcome = await instance.evaluate('owner', request, describeAnswers);
    expect(outcome.ok).toBe(true);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ outcome: 'decided', selected: 'b', confidence: 0.9, provider: 'static', model: 'jev-test', questionCount: 2, inputTokens: 10 });
    for (const value of Object.values(traces[0]!)) expect(['string', 'number']).toContain(typeof value);
    expect(JSON.stringify(traces[0])).not.toContain('deploy the app');
  });

  it.each([
    ['a choice outside the offered options', { ...goodAnswers, pick: { kind: 'choice', value: 'zzz', confidence: 0.9, probabilities: {} } }],
    ['a missing answer', { pick: goodAnswers.pick! }],
    ['a probability outside [0, 1]', { ...goodAnswers, clear: { kind: 'boolean', probability: 1.5 } }],
    ['the wrong answer kind', { ...goodAnswers, clear: { kind: 'score', value: 0.5, confidence: 0.5 } }]
  ])('rejects %s as a whole', async (_label, answers) => {
    const { instance } = plane(staticProvider(decided(answers as Record<string, DecisionAnswer>)));
    expect(await instance.evaluate('owner', request, describeAnswers)).toMatchObject({ ok: false, reason: 'invalid_answer' });
  });

  it('times out a slow provider and aborts its call', async () => {
    let aborted = false;
    const provider: DecisionProvider = {
      name: 'slow',
      evaluate: (_request, context) => new Promise((resolve) => {
        context.signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ ok: false, reason: 'connection_error' });
        });
      })
    };
    const { instance } = plane(provider, { timeoutMs: 20 });
    expect(await instance.evaluate('owner', request, describeAnswers)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('treats a throwing provider, provider lookup, or audit sink as a fallback, never an exception', async () => {
    const throwing = staticProvider(async () => { throw new Error('boom'); });
    expect(await plane(throwing).instance.evaluate('owner', request, describeAnswers)).toMatchObject({ ok: false, reason: 'connection_error' });
    const lookup = new DecisionPlane({ purposes: ['mcp-routing'], providerFor: () => { throw new Error('keyring'); } });
    expect(await lookup.evaluate('owner', request, describeAnswers)).toMatchObject({ ok: false, reason: 'not_configured' });
    const sink = new DecisionPlane({ purposes: ['mcp-routing'], providerFor: () => staticProvider(decided(goodAnswers)), record: () => { throw new Error('audit'); } });
    expect((await sink.evaluate('owner', request, describeAnswers)).ok).toBe(true);
  });

  it('bounds egress per owner per minute', async () => {
    let now = 0;
    const { instance } = plane(staticProvider(decided(goodAnswers)), { now: () => now });
    for (let call = 0; call < 120; call += 1) await instance.evaluate('owner', request, describeAnswers);
    expect(await instance.evaluate('owner', request, describeAnswers)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((await instance.evaluate('other', request, describeAnswers)).ok).toBe(true);
    now += 61_000;
    expect((await instance.evaluate('owner', request, describeAnswers)).ok).toBe(true);
  });

  it('reports latency percentiles, fallback rate, and token usage per purpose', async () => {
    const { instance } = plane(staticProvider(decided(goodAnswers)));
    await instance.evaluate('owner', request, describeAnswers);
    await instance.evaluate('owner', request, () => ({ selected: 'a', confidence: 0.2, policyEffect: 'rerank' }));
    const { instance: failing } = plane(undefined);
    await failing.evaluate('owner', request, describeAnswers);
    const metrics = instance.status().metrics['mcp-routing']!;
    expect(metrics).toMatchObject({ evaluations: 2, decided: 2, fallback: 0, lowConfidence: 1, inputTokens: 20 });
    expect(failing.status().metrics['mcp-routing']).toMatchObject({ fallback: 1, fallbackRate: 1, fallbackReasons: { not_configured: 1 } });
    expect(percentile([5, 1, 9, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 9, 3], 0.95)).toBe(9);
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe('JevDecisionProvider', () => {
  function capture(response: Response | (() => Promise<Response>)) {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return typeof response === 'function' ? await response() : response;
    });
    return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const signal = new AbortController().signal;

  it('sends the verified wire shape and redacts the state and every criterion before egress', async () => {
    const { bodies, fetchImpl } = capture(json({ model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }, clear: { type: 'noul', noul: 0.4 }, sev: { type: 'score', score: 0.1, confidence: 0.8 } }, usage: { input_tokens: 9, output_tokens: 3 } }));
    const provider = new JevDecisionProvider({ apiKey: () => 'ts_key', secrets: () => ({ OWNER: 'owner-secret-value' }), fetchImpl });
    const result = await provider.evaluate({
      purpose: 'failure-classification',
      state: 'stderr: token owner-secret-value and ghp_abcdefghijklmnopqrstuvwxyz0123',
      questions: [
        { kind: 'choice', key: 'pick', question: 'Which?', options: { a: 'workspace-secret-value', b: 'other' } },
        { kind: 'boolean', key: 'clear', question: 'Clear?' },
        { kind: 'score', key: 'sev', question: 'Severity?', low: 'harmless', high: 'critical' }
      ]
    }, { signal, secrets: () => ({ WORKSPACE: 'workspace-secret-value' }) });
    const wire = JSON.stringify(bodies[0]);
    expect(wire).not.toContain('owner-secret-value');
    expect(wire).not.toContain('workspace-secret-value');
    expect(wire).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(bodies[0]).toMatchObject({
      model: 'jev-latest',
      questions: {
        clear: { type: 'noul', criteria: { true: 'yes', false: 'no' } },
        sev: { type: 'score', criteria: ['harmless', 'critical'] }
      }
    });
    expect(result).toMatchObject({ ok: true, model: 'jev-1.13.0', inputTokens: 9, outputTokens: 3 });
    expect(result.ok && result.redactionCount).toBeGreaterThanOrEqual(3);
    expect(result.ok && result.answers).toEqual({
      pick: { kind: 'choice', value: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
      clear: { kind: 'boolean', probability: 0.4 },
      sev: { kind: 'score', value: 0.1, confidence: 0.8 }
    });
  });

  it('fails closed without egress when redaction cannot read its secrets', async () => {
    const { fetchImpl } = capture(json({}));
    const provider = new JevDecisionProvider({ apiKey: () => 'ts_key', secrets: () => { throw new Error('keyring'); }, fetchImpl });
    expect(await provider.evaluate(request, { signal })).toMatchObject({ ok: false, reason: 'redaction_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an endpoint outside the TypeSafe allowlist or without HTTPS', async () => {
    const { fetchImpl } = capture(json({}));
    for (const endpoint of ['https://evil.example/v1', 'http://api.typesafe.ai/v1/systemone']) {
      const provider = new JevDecisionProvider({ apiKey: () => 'ts_key', endpoint, fetchImpl });
      expect(await provider.evaluate(request, { signal })).toMatchObject({ ok: false, reason: 'invalid_endpoint' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'], [422, 'unprocessable'], [429, 'rate_limited'], [529, 'upstream_unavailable'], [400, 'connection_error']
  ])('maps HTTP %i to %s', async (status, reason) => {
    const { fetchImpl } = capture(json({ detail: 'x' }, status));
    expect(await new JevDecisionProvider({ apiKey: () => 'k', fetchImpl }).evaluate(request, { signal })).toMatchObject({ ok: false, reason });
  });

  it('reports an abort as a timeout and a malformed body as unexpected', async () => {
    const aborting = capture(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    expect(await new JevDecisionProvider({ apiKey: () => 'k', fetchImpl: aborting.fetchImpl }).evaluate(request, { signal })).toMatchObject({ reason: 'timeout' });
    const malformed = capture(json({ nope: true }));
    expect(await new JevDecisionProvider({ apiKey: () => 'k', fetchImpl: malformed.fetchImpl }).evaluate(request, { signal })).toMatchObject({ reason: 'unexpected_response' });
  });

  it('reads only the questions it asked', () => {
    const parsed = parseJevAnswers({ answers: { pick: { type: 'choice', choice: 'a', confidence: 0.7 }, injected: { type: 'noul', noul: 1 } } }, request);
    expect(Object.keys(parsed!.answers)).toEqual(['pick']);
  });

  it('refuses a body above the egress ceiling', async () => {
    const { fetchImpl } = capture(json({}));
    const options = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`o${index}`, 'x'.repeat(400)]));
    const questions = Array.from({ length: 2 }, (_, index) => ({ kind: 'choice' as const, key: `q${index}`, question: 'q', options }));
    expect(await new JevDecisionProvider({ apiKey: () => 'k', fetchImpl }).evaluate({ purpose: 'mcp-routing', state: 's', questions }, { signal }))
      .toMatchObject({ ok: false, reason: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('tool router', () => {
  const input = {
    query: 'deploy to production',
    candidates: [
      { tool: 'docker.container_run', description: 'Run a container' },
      { tool: 'vercel.deploy', description: 'Deploy to Vercel' },
      { tool: 'github.create_deployment', description: 'Create a deployment' }
    ]
  };
  const answers = (fits: number[], choice = 't1'): Record<string, DecisionAnswer> => ({
    best_tool: { kind: 'choice', value: choice, confidence: 0.8, probabilities: { t0: 0.1, t1: 0.8, t2: 0.1 } },
    ...Object.fromEntries(fits.map((probability, index) => [`fits_t${index}`, { kind: 'boolean' as const, probability }]))
  });

  it('addresses candidates by position so tool names never become question keys', () => {
    const built = rerankDecisionRequest(input);
    expect(built.questions.map((question) => question.key)).toEqual(['best_tool', 'fits_t0', 'fits_t1', 'fits_t2']);
    expect(built.questions[0]).toMatchObject({ options: { t1: 'vercel.deploy: Deploy to Vercel' } });
  });

  it('returns a permutation ordered by relevance with lexical position as the tie-break', () => {
    const ranked = rankFromAnswers(input, answers([0.1, 0.9, 0.1], 't1'));
    expect(ranked.ordering).toEqual(['vercel.deploy', 'docker.container_run', 'github.create_deployment']);
    expect(ranked.relevance['vercel.deploy']).toBeCloseTo(0.87);
  });

  it('abstains when no candidate is relevant and when the plane is disabled', async () => {
    const lowAnswers: Record<string, DecisionAnswer> = {
      ...answers([0.05, 0.05, 0.05]),
      best_tool: { kind: 'choice', value: 't0', confidence: 0.34, probabilities: { t0: 0.34, t1: 0.33, t2: 0.33 } }
    };
    const { instance } = plane(staticProvider(decided(lowAnswers)));
    expect(await rerankTools(instance, 'owner', input)).toMatchObject({ applied: false, reason: 'low_confidence', ordering: [] });
    const disabled = plane(staticProvider(decided(lowAnswers)), { purposes: [] }).instance;
    expect(await rerankTools(disabled, 'owner', input)).toMatchObject({ applied: false, reason: 'purpose_disabled' });
  });

  it('applies a confident rerank', async () => {
    const { instance, traces } = plane(staticProvider(decided(answers([0.1, 0.9, 0.2]))));
    const result = await rerankTools(instance, 'owner', input);
    expect(result).toMatchObject({ applied: true, ordering: ['vercel.deploy', 'github.create_deployment', 'docker.container_run'] });
    expect(traces[0]).toMatchObject({ purpose: 'mcp-routing', selected: 'vercel.deploy', policyEffect: 'rerank' });
  });
});

describe('failure intelligence', () => {
  const context = {
    ownerId: 'owner', workspaceId: 'ws_1', operation: 'github pr_create', deterministicCode: 'GITHUB_ACTION_FAILED',
    exitCode: 1, stderr: 'dial tcp: lookup api.github.com: i/o timeout', stdout: ''
  };
  const failureAnswers = (failureType: string, confidence: number): Record<string, DecisionAnswer> => ({
    failure_type: { kind: 'choice', value: failureType, confidence, probabilities: {} },
    retry_succeeds: { kind: 'boolean', probability: 0.71 },
    credential_refresh: { kind: 'boolean', probability: 0.1 },
    workspace_recreate: { kind: 'boolean', probability: 0.05 },
    agent_needed: { kind: 'boolean', probability: 0.2 },
    human_needed: { kind: 'boolean', probability: 0.6 }
  });

  it('builds a bounded state that names the deterministic code and the repeat count', () => {
    const built = failureDecisionRequest({ ...context, stderr: 'x'.repeat(10_000) }, 2);
    expect(built.state).toContain('deterministic classification: GITHUB_ACTION_FAILED');
    expect(built.state).toContain('prior failures of this operation in the last 15 minutes: 2');
    expect(built.state.length).toBeLessThan(2_600);
    expect(built.questions[0]).toMatchObject({ kind: 'choice', key: 'failure_type' });
  });

  it('reports a low-confidence classification as unknown with its real confidence', () => {
    expect(diagnosisFromAnswers(failureAnswers('code_error', 0.3), 0, 'dec_1')).toMatchObject({ failureType: 'unknown', confidence: 0.3 });
    expect(diagnosisFromAnswers(failureAnswers('transient_network', 0.95), 1, 'dec_1')).toEqual({
      advisory: true, source: 'decision-plane', decisionId: 'dec_1', failureType: 'transient_network', confidence: 0.95,
      retryLikelyToSucceed: 0.71, credentialRefreshNeeded: false, workspaceRecreateNeeded: false, agentNeeded: false, humanNeeded: true, priorFailures: 1
    });
  });

  it('counts repeated failures of the same operation and returns nothing when unavailable', async () => {
    const provider = staticProvider(decided(failureAnswers('transient_network', 0.9)));
    const intelligence = new FailureIntelligence(plane(provider).instance);
    expect(await intelligence.diagnose(context)).toMatchObject({ failureType: 'transient_network', priorFailures: 0 });
    expect(await intelligence.diagnose(context)).toMatchObject({ priorFailures: 1 });
    const off = new FailureIntelligence(plane(provider, { purposes: ['mcp-routing'] }).instance);
    expect(await off.diagnose(context)).toBeUndefined();
    const unconfigured = new FailureIntelligence(plane(undefined).instance);
    expect(await unconfigured.diagnose(context)).toBeUndefined();
  });
});

describe('decision plane configuration', () => {
  const base = { serviceToken: 'a'.repeat(40), jobsRoot: '/jobs', stateDb: '/state/db.sqlite', executorImage: 'executor:test', allowedGitHosts: ['github.com'] };
  it('is off by default and accepts only implemented purposes', () => {
    expect(RunnerConfigSchema.parse(base).decisionPlanePurposes).toEqual([]);
    expect(RunnerConfigSchema.parse({ ...base, decisionPlanePurposes: ['mcp-routing'] }).decisionPlanePurposes).toEqual(['mcp-routing']);
    expect(RunnerConfigSchema.safeParse({ ...base, decisionPlanePurposes: ['execution-risk'] }).success).toBe(false);
    expect(RunnerConfigSchema.safeParse({ ...base, decisionPlanePurposes: ['mcp-routing', 'mcp-routing'] }).success).toBe(false);
  });
});

describe('decision plane review hardening', () => {
  const failureContext = {
    ownerId: 'owner', workspaceId: 'ws_hardening', operation: 'github pr_create', deterministicCode: 'GITHUB_ACTION_FAILED',
    exitCode: 1, stdout: ''
  };
  const jevFailureBody = {
    model: 'jev-1.13.0',
    answers: {
      failure_type: { type: 'choice', choice: 'auth', confidence: 0.9, probabilities: { auth: 0.9, unknown: 0.1 } },
      retry_succeeds: { type: 'noul', noul: 0.1 }, credential_refresh: { type: 'noul', noul: 0.9 },
      workspace_recreate: { type: 'noul', noul: 0.1 }, agent_needed: { type: 'noul', noul: 0.1 }, human_needed: { type: 'noul', noul: 0.2 }
    },
    usage: { input_tokens: 5, output_tokens: 1 }
  };

  it('redacts output before cutting the tail, so a secret straddling the boundary leaves no fragment', async () => {
    const secret = 'Q7wZr2Lp9XvK4mTn8BcY1dHs6JfG3aEu';
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify(jevFailureBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = new JevDecisionProvider({ apiKey: () => 'k'.repeat(32), fetchImpl });
    const intelligence = new FailureIntelligence(new DecisionPlane({ purposes: ['failure-classification'], providerFor: () => provider }));
    // The 1,500-character tail starts 16 characters into the secret.
    const stderr = `${'a'.repeat(3_000)} ${secret}${'b'.repeat(1_500 - (secret.length - 16))}`;
    const diagnosis = await intelligence.diagnose({ ...failureContext, stderr, secrets: () => ({ WORKSPACE_TOKEN: secret }) });
    expect(diagnosis).toMatchObject({ failureType: 'auth' });
    expect(bodies).toHaveLength(1);
    for (let start = 0; start + 8 <= secret.length; start += 1) expect(bodies[0]).not.toContain(secret.slice(start, start + 8));
  });

  it('leaves no fragment when redaction shrinks long output that repeats a long secret', async () => {
    const secret = `${'Rm4Tq8'.repeat(333)}Zx`;
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify(jevFailureBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = new JevDecisionProvider({ apiKey: () => 'k'.repeat(32), fetchImpl });
    const traces: DecisionTrace[] = [];
    const intelligence = new FailureIntelligence(new DecisionPlane({ purposes: ['failure-classification'], providerFor: () => provider, record: (_owner, trace) => traces.push(trace) }));
    const stderr = `${secret.repeat(8)}${'e'.repeat(500)}`;
    await intelligence.diagnose({ ...failureContext, stderr, secrets: () => ({ WORKSPACE_TOKEN: secret }) });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('Rm4Tq8Rm');
    expect(traces[0]?.redactionCount).toBe(8);
  });

  it('keeps redacting the plane key when a caller secret reuses its name', async () => {
    const planeKey = 'Pl4neKeyValueThatMustNeverLeave99';
    let seen = '';
    const provider: DecisionProvider = {
      name: 'capture',
      async evaluate(sent, context) {
        const redacted = redactPrompt({ prompt: sent.state, secrets: context.secrets });
        seen = redacted.ok ? redacted.outcome.text : '';
        return { ok: false, reason: 'upstream_unavailable' };
      }
    };
    const instance = new DecisionPlane({ purposes: ['failure-classification'], providerFor: () => provider, secretsFor: () => ({ TYPESAFE_API_KEY: planeKey }) });
    await instance.evaluate('owner', { ...request, purpose: 'failure-classification', state: `leak ${planeKey}` }, describeAnswers, { secrets: () => ({ TYPESAFE_API_KEY: 'a-different-workspace-value' }) });
    expect(seen).toContain('leak');
    expect(seen).not.toContain(planeKey);
  });

  it('sends nothing when redaction of the output cannot complete', async () => {
    const provider = staticProvider(decided({}));
    const intelligence = new FailureIntelligence(plane(provider).instance);
    const result = await intelligence.diagnose({ ...failureContext, stderr: 'boom', secrets: () => { throw new Error('snapshot unreadable'); } });
    expect(result).toBeUndefined();
    expect(provider.calls).toBe(0);
  });

  it('redacts the plane-owned secrets from tool descriptions before they are shortened', async () => {
    const secret = 'Hk3Vn8Qz1Wr5Ty7Ui9Op2As4Df6Gh0Jl';
    let seen = '';
    const provider: DecisionProvider = {
      name: 'capture',
      async evaluate(sent) { seen = JSON.stringify(sent); return { ok: false, reason: 'upstream_unavailable' }; }
    };
    const instance = new DecisionPlane({ purposes: ['mcp-routing'], providerFor: () => provider, secretsFor: () => ({ PROVIDER: secret }) });
    const description = `${'d'.repeat(230)}${secret}`;
    await rerankTools(instance, 'owner', { query: 'q', candidates: [{ tool: 'a.one', description }, { tool: 'b.two', description: 'two' }] });
    for (let start = 0; start + 8 <= secret.length; start += 1) expect(seen).not.toContain(secret.slice(start, start + 8));
  });

  it('answers not_configured for an owner without a key, with no audit row or metric', async () => {
    const { instance, traces } = plane(undefined);
    const result = await rerankTools(instance, 'owner', { query: 'q', candidates: [{ tool: 'a.one', description: '' }, { tool: 'b.two', description: '' }] });
    expect(result).toMatchObject({ applied: false, reason: 'not_configured' });
    expect(traces).toHaveLength(0);
    expect(instance.metrics.snapshot()['mcp-routing']).toBeUndefined();
  });

  it('audits a rate-limited burst once per window while still counting every refusal', async () => {
    const { instance, traces } = plane(staticProvider(decided(goodAnswers)));
    for (let call = 0; call < 120; call += 1) await instance.evaluate('owner', request, describeAnswers);
    for (let call = 0; call < 5; call += 1) expect(await instance.evaluate('owner', request, describeAnswers)).toMatchObject({ reason: 'rate_limited' });
    expect(traces.filter((trace) => trace.fallbackReason === 'rate_limited')).toHaveLength(1);
    expect(instance.metrics.snapshot()['mcp-routing']?.fallbackReasons.rate_limited).toBe(5);
  });

  it('aborts the provider call and answers cancelled when the caller cancels', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: DecisionProvider = {
      name: 'slow',
      evaluate: (_sent, context) => new Promise<ProviderEvaluation>(() => { providerSignal = context.signal; })
    };
    const { instance } = plane(provider, { timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = instance.evaluate('owner', request, describeAnswers, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(providerSignal?.aborted).toBe(true);
    const already = new AbortController();
    already.abort();
    expect(await instance.evaluate('owner', request, describeAnswers, { signal: already.signal })).toMatchObject({ reason: 'cancelled' });
  });

  it('rejects a choice whose probabilities fall outside [0, 1]', async () => {
    const outOfRange = { ...goodAnswers, pick: { kind: 'choice' as const, value: 'b', confidence: 0.9, probabilities: { a: -0.2, b: 1.7 } } };
    expect(await plane(staticProvider(decided(outOfRange))).instance.evaluate('owner', request, describeAnswers)).toMatchObject({ reason: 'invalid_answer' });
  });

  it('counts unusable usage numbers as zero tokens', () => {
    const parsed = parseJevAnswers({ ...jevFailureBody, answers: { pick: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }, clear: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: -4, output_tokens: Number.POSITIVE_INFINITY } }, request);
    expect(parsed).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('closes every purpose when the operator turns TYPESAFE_EGRESS off', () => {
    const build = (typesafeEgress: 'on' | 'off') => createRunnerDecisionPlane({
      purposes: ['mcp-routing', 'failure-classification'], typesafeEgress,
      database: {} as never, keyring: undefined, modelProfiles: undefined, recordAudit: () => undefined
    });
    expect(build('on').status().purposes).toEqual(['mcp-routing', 'failure-classification']);
    expect(build('off').status().purposes).toEqual([]);
    expect(build('off').enabled('mcp-routing')).toBe(false);
  });
});
