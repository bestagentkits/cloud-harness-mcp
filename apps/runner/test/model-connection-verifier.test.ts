import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessError, ModelConnectionVerifyResultSchema, ModelProfileIdSchema,
  type AgentModelApiMode, type MetadataRunnerRequest, type ModelConnectionVerifyResult, type ModelProviderKind,
  type ProviderAuthMode, type RunnerConfig
} from '@cloud-harness/contracts';
import { ArtifactStore } from '../src/artifact-store.js';
import { DashboardControlService } from '../src/dashboard-control-service.js';
import { MetadataStore } from '../src/metadata-store.js';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { ProviderHttpError, type ProviderHttpClient, type ProviderHttpRequest, type ProviderHttpResponse } from '../src/model-provider-http.js';
import { DRAFT_VERIFICATION_TTL_MS, DraftVerificationStore } from '../src/model-verification/draft-verification-store.js';
import { ModelConnectionVerifier, chatOutputCap, type VerificationAudit } from '../src/model-verification/model-connection-verifier.js';
import { VerificationRateLimiter } from '../src/model-verification/verification-rate-limiter.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore, downgradeStateSchemaToV10, downgradeStateSchemaToV11, downgradeStateSchemaToV8, downgradeStateSchemaToV9 } from '../src/state-store.js';
import type { WorkspaceService } from '../src/workspace-service.js';

const SECRET = 'sk-test-verification-secret-0123456789';

// 'hang' never answers, like a provider (or name lookup) that stalls.
type Reply = { status: number; body: string } | Error | 'hang';
type Handler = (request: ProviderHttpRequest) => Reply;

/** Replays a canned answer, feeding streamed lines through onLine exactly as the real client does. */
function fakeHttp(handler: Handler): { client: ProviderHttpClient; requests: ProviderHttpRequest[] } {
  const requests: ProviderHttpRequest[] = [];
  const client: ProviderHttpClient = {
    async request(request): Promise<ProviderHttpResponse> {
      requests.push(request);
      const reply = handler(request);
      if (reply === 'hang') return await new Promise<never>(() => undefined);
      if (reply instanceof Error) {
        // A timeout after partial output: deliver the lines first, then fail.
        const partial = (reply as Error & { partial?: string }).partial;
        if (partial && request.onLine) for (const line of partial.split('\n')) request.onLine(line);
        throw reply;
      }
      if (request.onLine) {
        for (const line of reply.body.split('\n')) {
          if (request.onLine(line) === false) return { status: reply.status, headers: {}, body: reply.body, truncated: true };
        }
      }
      return { status: reply.status, headers: {}, body: reply.body, truncated: false };
    }
  };
  return { client, requests };
}

const sse = (events: unknown[], done = true) => [...events.map((event) => `data: ${JSON.stringify(event)}`), ...(done ? ['data: [DONE]'] : []), ''].join('\n\n');
const chatStream = () => sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }
]);
const responsesStream = () => sse([
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_text.delta', delta: 'OK' },
  { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 3 } } }
], false);
const listing = (ids: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ data: ids.map((id) => ({ id })), ...extra });

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    try { close(); } catch { /* ignore */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(handler: Handler, options: { limiter?: VerificationRateLimiter; totalBudgetMs?: number; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-verify-')); roots.push(root);
  const store = new StateStore(join(root, 'state.db'));
  closers.push(() => store.close());
  const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
  const repo = new ModelProfileStateRepository(store.database, keyring);
  const p1 = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-1' });
  const p2 = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-2' });
  const http = fakeHttp(handler);
  const audits: Array<Parameters<VerificationAudit>> = [];
  const verifier = new ModelConnectionVerifier({
    repository: repo,
    http: http.client,
    audit: (...args) => { audits.push(args); },
    rateLimiter: options.limiter ?? new VerificationRateLimiter(1_000),
    ...(options.now ? { now: options.now } : {}),
    ...(options.totalBudgetMs !== undefined ? { totalBudgetMs: options.totalBudgetMs } : {})
  });
  const credential = (provider: ModelProviderKind = 'openai', authMode?: ProviderAuthMode, principal = p1) =>
    repo.createCredential(principal, { label: `${provider} key`, provider, apiKey: SECRET, ...(authMode ? { authMode } : {}) });
  const profile = (credentialId: string, model: string, apiMode: AgentModelApiMode = 'chat-completions', extra: { customUpstreamUrl?: string } = {}, principal = p1) =>
    repo.createProfile(principal, {
      profileId: ModelProfileIdSchema.parse(`profile-${randomBytes(4).toString('hex')}`),
      displayName: 'Profile',
      credentialId: credentialId as never,
      model,
      apiMode,
      ...extra,
      pricing: { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 },
      limits: { maxInputTokens: 1000, maxOutputTokens: 1000, maxCostMicros: 1_000_000 },
      maxProxyOperations: ['files_read']
    });
  return { store, repo, verifier, requests: http.requests, audits, p1, p2, credential, profile };
}

const byName = (result: ModelConnectionVerifyResult, name: string) => result.checks.find((entry) => entry.name === name)!;
const json = (body: unknown) => JSON.stringify(body);

function openAiHandler(overrides: { inference?: Reply; models?: Reply; tools?: Reply } = {}): Handler {
  return (request) => {
    if (request.url.endsWith('/v1/models')) return overrides.models ?? { status: 200, body: listing(['gpt-test', 'gpt-other']) };
    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    if (Array.isArray(body.tools)) return overrides.tools ?? { status: 500, body: '' };
    if (request.url.endsWith('/v1/responses')) return overrides.inference ?? { status: 200, body: responsesStream() };
    return overrides.inference ?? { status: 200, body: chatStream() };
  };
}

describe('model connection verifier', () => {
  it('verifies a saved chat profile, estimates its cost, and records the result against the revision', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const saved = ctx.profile(cred.id, 'gpt-test');
    const result = await ctx.verifier.verify(ctx.p1, { profileId: saved.id });

    expect(ModelConnectionVerifyResultSchema.parse(result)).toEqual(result);
    expect(result.outcome).toBe('verified');
    expect(result.checks.map((entry) => [entry.name, entry.outcome])).toEqual([
      ['authentication', 'verified'], ['model_access', 'verified'], ['protocol', 'verified'],
      ['streaming_inference', 'verified'], ['tool_call', 'not_tested']
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 2 });
    // 12 × 2 µ$/token rounds up to 24, 2 × 8 µ$/token to 16.
    expect(result.estimatedCostMicros).toBe(40);

    const [models, inference] = ctx.requests;
    expect(models?.url).toBe('https://api.openai.com/v1/models');
    expect(models?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
    expect(inference?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(inference?.timeoutMs).toBeLessThanOrEqual(20_000);
    expect(inference?.maxResponseBytes).toBe(256 * 1024);
    expect(JSON.parse(inference?.body ?? '')).toEqual({
      model: 'gpt-test', messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 16, stream: true, stream_options: { include_usage: true }
    });

    const listed = ctx.repo.listProfiles(ctx.p1)[0]!;
    expect(listed.lastVerification).toEqual({ outcome: 'verified', checkedAt: result.checkedAt, revisionId: saved.activeRevisionId });
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification).toEqual({ outcome: 'verified', checkedAt: result.checkedAt, revisionId: null });

    // A new revision has not been checked, so it reads as not verified.
    ctx.repo.updateProfile(ctx.p1, saved.id, { model: 'gpt-other', expectedGeneration: saved.generation });
    expect(ctx.repo.listProfiles(ctx.p1)[0]?.lastVerification).toBeUndefined();
    // Rotating the key does the same for the credential.
    ctx.repo.rotateCredential(ctx.p1, cred.id, { apiKey: `${SECRET}-2`, expectedGeneration: 1 });
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification).toBeUndefined();

    expect(ctx.audits).toHaveLength(1);
    expect(ctx.audits[0]?.slice(0, 4)).toEqual([ctx.p1, 'model_connection.verified', 'model_profile', saved.id]);
    expect(ctx.audits[0]?.[5]).toMatchObject({ outcome: 'verified', provider: 'openai', target: 'profile', model: 'gpt-test' });
  });

  it('names the chat output cap the way the gateway does for each provider', async () => {
    const toolAnswer = json({ choices: [{ message: { tool_calls: [{ function: { name: 'report_status', arguments: '{}' } }] } }] });
    const handler: Handler = (request) => {
      if (request.method === 'GET') return { status: 200, body: listing(['m']) };
      return Array.isArray((JSON.parse(request.body ?? '{}') as Record<string, unknown>).tools) ? { status: 200, body: toolAnswer } : { status: 200, body: chatStream() };
    };
    for (const [provider, field, other] of [['openai', 'max_completion_tokens', 'max_tokens'], ['deepseek', 'max_tokens', 'max_completion_tokens']] as const) {
      const ctx = setup(handler);
      await ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential(provider).id, model: 'm', checks: { tools: true } });
      const [inference, tool] = ctx.requests.filter((request) => request.method === 'POST').map((request) => JSON.parse(request.body ?? '{}') as Record<string, unknown>);
      expect(inference?.[field], provider).toBe(16);
      expect(tool?.[field], provider).toBe(128);
      expect(inference).not.toHaveProperty(other);
      expect(tool).not.toHaveProperty(other);
    }
  });

  it('uses max_completion_tokens for a custom upstream on api.openai.com, like the gateway', () => {
    expect(chatOutputCap('custom', 'https://api.openai.com/v1/chat/completions', 16)).toEqual({ max_completion_tokens: 16 });
    expect(chatOutputCap('custom', 'https://llm.example.com/v1/chat/completions', 16)).toEqual({ max_tokens: 16 });
  });

  it('audits the credential generation and keeps the key version as a detail', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    ctx.store.database.prepare('UPDATE model_provider_credentials SET generation = 7 WHERE id = ?').run(cred.id);
    await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    expect(ctx.audits[0]?.[4]).toBe(7);
    expect(ctx.audits[0]?.[5]).toMatchObject({ keyVersion: 1, credentialId: cred.id });
  });

  it('names the channel that asked in the audit entry, the Dashboard by default', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    await ctx.verifier.verify(ctx.p1, { credentialId: cred.id }, 'mcp');
    expect(ctx.audits.map((entry) => entry[5].actor)).toEqual(['dashboard', 'mcp']);
  });

  it('verifies a responses-mode draft without saving a profile or revision', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test', apiMode: 'responses' });

    expect(result.outcome).toBe('verified');
    expect(result.apiMode).toBe('responses');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(result.estimatedCostMicros).toBeNull();
    expect(JSON.parse(ctx.requests[1]?.body ?? '')).toEqual({ model: 'gpt-test', input: 'Reply with OK.', max_output_tokens: 16, stream: true });
    expect(ctx.repo.listProfiles(ctx.p1)).toHaveLength(0);
    const revisions = ctx.store.database.prepare('SELECT count(*) AS count FROM agent_model_profile_revisions').get() as { count: number };
    expect(revisions.count).toBe(0);
    const rows = ctx.store.database.prepare('SELECT target_kind FROM model_verification_results').all() as Array<{ target_kind: string }>;
    expect(rows.map((row) => row.target_kind)).toEqual(['credential']);
    expect(ctx.audits[0]?.slice(1, 4)).toEqual(['model_connection.verified', 'model_credential', cred.id]);
  });

  it('runs only the key check for a draft without a model', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    expect(result.outcome).toBe('verified');
    expect(result.model).toBeNull();
    expect(ctx.requests).toHaveLength(1);
    expect(result.checks.filter((entry) => entry.outcome !== 'not_tested').map((entry) => entry.name)).toEqual(['authentication']);
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: cred.id, checks: { inference: true } })).rejects.toThrow('a model is required');
  });

  it('fails a key check on a rejected key without echoing the provider text', async () => {
    const ctx = setup(openAiHandler({ models: { status: 401, body: json({ error: { message: `Incorrect API key provided: ${SECRET.slice(0, 8)}****6789` } }) } }));
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    expect(result.outcome).toBe('failed');
    expect(byName(result, 'authentication')).toMatchObject({ outcome: 'failed', errorCategory: 'auth', httpStatus: 401, message: 'The provider rejected the API key.' });
    expect(ctx.requests).toHaveLength(1);
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification?.outcome).toBe('failed');
  });

  it('lets inference decide the key when the model list refuses it', async () => {
    const refused = { status: 401, body: json({ error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.' } }) };
    const ctx = setup(openAiHandler({ models: refused }));
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    expect(byName(result, 'authentication')).toMatchObject({ outcome: 'limited', errorCategory: 'access', httpStatus: 401 });
    expect(byName(result, 'streaming_inference').outcome).toBe('verified');
    expect(byName(result, 'model_access').outcome).toBe('verified');
    expect(result.outcome).toBe('limited');
    expect(ctx.requests).toHaveLength(2);
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification?.outcome).toBe('verified');

    // An inference that rejects the key settles it as failed.
    const rejected = setup(openAiHandler({ models: refused, inference: { status: 401, body: '{}' } }));
    const rejectedCred = rejected.credential();
    const failed = await rejected.verifier.verify(rejected.p1, { credentialId: rejectedCred.id, model: 'gpt-test' });
    expect(failed.outcome).toBe('failed');
    expect(byName(failed, 'streaming_inference')).toMatchObject({ outcome: 'failed', errorCategory: 'auth' });
    expect(rejected.repo.listCredentials(rejected.p1)[0]?.lastVerification?.outcome).toBe('failed');

    // Without inference, scope text on a 401 still reads as limited rather than a bad key.
    const keyOnly = setup(openAiHandler({ models: refused }));
    const keyOnlyResult = await keyOnly.verifier.verify(keyOnly.p1, { credentialId: keyOnly.credential().id });
    expect(byName(keyOnlyResult, 'authentication')).toMatchObject({ outcome: 'limited', errorCategory: 'access' });
    expect(keyOnly.repo.listCredentials(keyOnly.p1)[0]?.lastVerification?.outcome).toBe('limited');
  });

  it('maps Gemini key errors (400 INVALID_ARGUMENT and 403) to auth, and other 403s to access', async () => {
    const gemini400 = json([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]);
    for (const reply of [{ status: 400, body: gemini400 }, { status: 403, body: json({ error: { message: 'API_KEY_INVALID' } }) }]) {
      const ctx = setup(() => reply);
      const cred = ctx.credential('google');
      const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
      expect(byName(result, 'authentication')).toMatchObject({ errorCategory: 'auth', outcome: 'failed' });
      expect(ctx.requests[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
    }
    const ctx = setup(() => ({ status: 403, body: json({ error: { message: 'Project has no access to this API' } }) }));
    const cred = ctx.credential('google');
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    // A 403 that is not a bad key is a key scoped away from listing models.
    expect(byName(result, 'authentication')).toMatchObject({ errorCategory: 'access', outcome: 'limited', httpStatus: 403 });
  });

  it('matches Gemini model IDs that the listing prefixes with models/', async () => {
    const ctx = setup((request) => request.method === 'GET'
      ? { status: 200, body: listing(['models/gemini-test']) }
      : { status: 200, body: chatStream() });
    const cred = ctx.credential('google');
    const listed = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gemini-test', checks: { inference: false } });
    expect(byName(listed, 'model_access')).toMatchObject({ outcome: 'verified' });
    const absent = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gemini-missing', checks: { inference: false } });
    expect(absent.outcome).toBe('failed');
    expect(byName(absent, 'model_access')).toMatchObject({ outcome: 'failed', errorCategory: 'not_found' });
  });

  it('treats a model absent from a partial listing as limited, not failed', async () => {
    const ctx = setup(() => ({ status: 200, body: listing(['claude-a'], { has_more: true }) }));
    const cred = ctx.credential('anthropic');
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'claude-z', checks: { inference: false } });
    expect(byName(result, 'model_access')).toMatchObject({ outcome: 'limited', errorCategory: 'not_found' });
    expect(result.outcome).toBe('limited');
  });

  it('treats a model missing from a complete listing as limited when inference proved nothing', async () => {
    const ctx = setup(openAiHandler({ models: { status: 200, body: listing(['gpt-other']) }, inference: { status: 429, body: json({ error: { message: 'Rate limit reached' } }) } }));
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential().id, model: 'gpt-test' });
    expect(byName(result, 'model_access')).toMatchObject({ outcome: 'limited', errorCategory: 'not_found' });
    expect(result.outcome).toBe('limited');
  });

  it('fails model access on a 404 from inference', async () => {
    const ctx = setup(openAiHandler({ inference: { status: 404, body: json({ error: { message: 'The model `gpt-gone` does not exist', code: 'model_not_found' } }) } }));
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-gone' });
    expect(result.outcome).toBe('failed');
    expect(byName(result, 'model_access')).toMatchObject({ outcome: 'failed', errorCategory: 'not_found', httpStatus: 404 });
    expect(byName(result, 'streaming_inference')).toMatchObject({ outcome: 'failed', errorCategory: 'not_found' });
  });

  it('reports rate limits, exhausted quota, timeouts and network errors as limited, never failed', async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 429, body: json({ error: { message: 'Rate limit reached' } }) }, 'rate_limited'],
      [{ status: 429, body: json({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }) }, 'quota'],
      [{ status: 402, body: json({ error: { message: 'Insufficient Balance' } }) }, 'quota'],
      [{ status: 503, body: 'overloaded' }, 'upstream'],
      [new ProviderHttpError('timeout', 'provider did not answer within 20000 ms'), 'timeout'],
      [new ProviderHttpError('network', 'provider request failed: Error'), 'network']
    ];
    for (const [reply, category] of cases) {
      const ctx = setup(openAiHandler({ inference: reply }));
      const cred = ctx.credential();
      const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
      expect(result.outcome, category).toBe('limited');
      expect(byName(result, 'streaming_inference'), category).toMatchObject({ outcome: 'limited', errorCategory: category });
      // The listing still proves the model exists.
      expect(byName(result, 'model_access').outcome, category).toBe('verified');
    }
  });

  it('keeps protocol evidence from events that arrived before a timeout', async () => {
    const timeout = Object.assign(new ProviderHttpError('timeout', 'provider did not answer within 20000 ms'), {
      partial: sse([{ choices: [{ index: 0, delta: { content: 'O' }, finish_reason: null }] }], false)
    });
    const ctx = setup(openAiHandler({ inference: timeout }));
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    expect(byName(result, 'protocol').outcome).toBe('verified');
    expect(byName(result, 'streaming_inference')).toMatchObject({ outcome: 'limited', errorCategory: 'timeout' });
  });

  it('waits for a finish reason or [DONE] even when usage arrives early', async () => {
    const usageFirst = sse([
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } },
      { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }
    ], false);
    const ctx = setup(openAiHandler({ inference: { status: 200, body: usageFirst } }));
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential().id, model: 'gpt-test' });
    expect(byName(result, 'streaming_inference').outcome).toBe('verified');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 1 });

    const unfinished = sse([
      { choices: [{ index: 0, delta: { content: 'O' }, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 1 } }
    ], false);
    const cut = setup(openAiHandler({ inference: { status: 200, body: unfinished } }));
    const cutResult = await cut.verifier.verify(cut.p1, { credentialId: cut.credential().id, model: 'gpt-test' });
    expect(byName(cutResult, 'streaming_inference')).toMatchObject({ outcome: 'failed', errorCategory: 'invalid_response' });
  });

  it('classifies an error reported inside the stream like an HTTP failure', async () => {
    const opening = { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    const cases: Array<[unknown, string, string]> = [
      [{ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 'quota', 'limited'],
      [{ error: { code: 429, message: 'Rate limit exceeded upstream' } }, 'rate_limited', 'limited'],
      [{ error: { code: 404, message: 'No endpoints found for gpt-test' } }, 'not_found', 'failed'],
      [{ error: { code: 401, message: 'User not found.' } }, 'auth', 'failed'],
      [{ error: { message: 'Internal failure' } }, 'upstream', 'limited']
    ];
    for (const [event, category, outcome] of cases) {
      const ctx = setup(openAiHandler({ inference: { status: 200, body: sse([opening, event], false) } }));
      const result = await ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential().id, model: 'gpt-test' });
      expect(byName(result, 'streaming_inference'), category).toMatchObject({ outcome, errorCategory: category });
      expect(byName(result, 'streaming_inference').httpStatus, category).toBeUndefined();
      if (category === 'auth') expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification?.outcome).toBe('failed');
    }
    const ctx = setup(openAiHandler({ inference: { status: 200, body: sse([{ type: 'response.created', response: {} }, { type: 'response.failed', response: { error: { code: 'model_not_found', message: 'The model does not exist' } } }], false) } }));
    const responses = await ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential().id, model: 'gpt-test', apiMode: 'responses' });
    expect(byName(responses, 'streaming_inference')).toMatchObject({ outcome: 'failed', errorCategory: 'not_found' });
  });

  it('keeps the whole run inside one deadline and marks the checks it could not finish', async () => {
    const ctx = setup(() => 'hang', { totalBudgetMs: 1_200 });
    const startedAt = Date.now();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential().id, model: 'gpt-test', checks: { tools: true } });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(byName(result, 'authentication')).toMatchObject({ outcome: 'limited', errorCategory: 'timeout' });
    for (const name of ['protocol', 'streaming_inference', 'tool_call']) {
      expect(byName(result, name), name).toMatchObject({ outcome: 'limited', errorCategory: 'timeout' });
    }
    expect(result.outcome).toBe('limited');
    expect(ctx.requests).toHaveLength(1);
  });

  it('fails a malformed stream and a stream of the wrong API family', async () => {
    const garbage = setup(openAiHandler({ inference: { status: 200, body: '<html>gateway</html>' } }));
    const cred = garbage.credential();
    const malformed = await garbage.verifier.verify(garbage.p1, { credentialId: cred.id, model: 'gpt-test' });
    expect(malformed.outcome).toBe('failed');
    expect(byName(malformed, 'protocol')).toMatchObject({ outcome: 'failed', errorCategory: 'invalid_response' });

    const foreign = setup(openAiHandler({ inference: { status: 200, body: responsesStream() } }));
    const cred2 = foreign.credential();
    const mismatch = await foreign.verifier.verify(foreign.p1, { credentialId: cred2.id, model: 'gpt-test' });
    expect(byName(mismatch, 'protocol')).toMatchObject({ outcome: 'failed', errorCategory: 'unsupported_protocol' });

    const plain = setup(openAiHandler({ inference: { status: 200, body: json({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } }));
    const cred3 = plain.credential();
    const unstreamed = await plain.verifier.verify(plain.p1, { credentialId: cred3.id, model: 'gpt-test' });
    expect(byName(unstreamed, 'protocol').outcome).toBe('verified');
    expect(byName(unstreamed, 'streaming_inference')).toMatchObject({ outcome: 'failed', errorCategory: 'unsupported_protocol' });
  });

  it('verifies a forced tool call and reports a model without tools as limited', async () => {
    const toolAnswer = json({
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report_status', arguments: '{"status":"ok"}' } }] } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 }
    });
    const ctx = setup(openAiHandler({ tools: { status: 200, body: toolAnswer } }));
    const cred = ctx.credential();
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test', checks: { tools: true } });
    expect(result.outcome).toBe('verified');
    expect(byName(result, 'tool_call').outcome).toBe('verified');
    expect(result.usage).toEqual({ inputTokens: 52, outputTokens: 10 });
    const toolRequest = JSON.parse(ctx.requests[2]?.body ?? '{}') as Record<string, unknown>;
    expect(toolRequest.tool_choice).toEqual({ type: 'function', function: { name: 'report_status' } });
    expect(toolRequest.tools).toEqual([{ type: 'function', function: expect.objectContaining({ name: 'report_status' }) }]);

    const responses = setup(openAiHandler({ tools: { status: 200, body: json({ object: 'response', output: [{ type: 'function_call', name: 'report_status', arguments: '{}' }] }) } }));
    const cred2 = responses.credential();
    const responsesResult = await responses.verifier.verify(responses.p1, { credentialId: cred2.id, model: 'gpt-test', apiMode: 'responses', checks: { tools: true } });
    expect(byName(responsesResult, 'tool_call').outcome).toBe('verified');
    const responsesTool = JSON.parse(responses.requests[2]?.body ?? '{}') as Record<string, unknown>;
    expect(responsesTool.tool_choice).toEqual({ type: 'function', name: 'report_status' });

    const unsupported = setup(openAiHandler({ tools: { status: 400, body: json({ error: { message: 'tools is not supported for this model' } }) } }));
    const cred3 = unsupported.credential();
    const limited = await unsupported.verifier.verify(unsupported.p1, { credentialId: cred3.id, model: 'gpt-test', checks: { tools: true } });
    expect(limited.outcome).toBe('limited');
    expect(byName(limited, 'tool_call')).toMatchObject({ outcome: 'limited', errorCategory: 'unsupported_protocol', httpStatus: 400 });
  });

  it('uses the native Anthropic headers for the models list and the credential auth mode for inference', async () => {
    const ctx = setup((request) => request.method === 'GET'
      ? { status: 200, body: listing(['claude-test']) }
      : { status: 200, body: chatStream() });
    const bearer = ctx.credential('anthropic');
    await ctx.verifier.verify(ctx.p1, { credentialId: bearer.id, model: 'claude-test' });
    expect(ctx.requests[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(ctx.requests[0]?.headers).toEqual({ 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' });
    expect(ctx.requests[1]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });

    const apiKey = ctx.credential('anthropic', 'x-api-key');
    await ctx.verifier.verify(ctx.p1, { credentialId: apiKey.id, model: 'claude-test' });
    expect(ctx.requests[3]?.headers).toEqual({ 'x-api-key': SECRET });
  });

  it('checks an OpenRouter key against its key endpoint and reads the public list without the key', async () => {
    const ctx = setup((request) => {
      if (request.url.endsWith('/api/v1/key')) return { status: 200, body: json({ data: { label: 'k' } }) };
      if (request.url.endsWith('/api/v1/models')) return { status: 200, body: listing(['openai/gpt-test']) };
      return { status: 200, body: chatStream() };
    });
    const cred = ctx.credential('openrouter');
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'openai/gpt-test' });
    expect(result.outcome).toBe('verified');
    expect(ctx.requests.map((request) => request.url)).toEqual([
      'https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/chat/completions'
    ]);
    expect(ctx.requests[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
    expect(ctx.requests[1]?.headers).toEqual({});
  });

  it('sends the OpenCode Go session header with one id per check on every request', async () => {
    const toolAnswer = json({
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report_status', arguments: '{"status":"ok"}' } }] } }],
      usage: { prompt_tokens: 40, completion_tokens: 8 }
    });
    const ctx = setup((request) => {
      // Answer as a provider that refuses a request without the session header would, so a missing header fails the check.
      if (!request.headers?.['x-opencode-session']) return { status: 400, body: json({ error: { type: 'MissingSessionID', message: 'missing session id' } }) };
      if (request.url.endsWith('/v1/models')) return { status: 200, body: listing(['kimi-k2.5']) };
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      return Array.isArray(body.tools) ? { status: 200, body: toolAnswer } : { status: 200, body: chatStream() };
    });
    const cred = ctx.credential('opencode-go');
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'kimi-k2.5', checks: { tools: true } });
    expect(result.outcome).toBe('verified');
    expect(ctx.requests.map((request) => request.url)).toEqual([
      'https://opencode.ai/inference/go/v1/models',
      'https://opencode.ai/inference/go/openai/v1/chat/completions',
      'https://opencode.ai/inference/go/openai/v1/chat/completions'
    ]);
    const first = ctx.requests.map((request) => request.headers?.['x-opencode-session']);
    expect(first[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(new Set(first).size).toBe(1);
    expect(ctx.requests[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}`, 'x-opencode-session': first[0] });

    await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    expect(ctx.requests[3]?.headers?.['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(ctx.requests[3]?.headers?.['x-opencode-session']).not.toBe(first[0]);
  });

  it('checks a custom provider through inference only and refuses a private upstream', async () => {
    const ctx = setup(() => ({ status: 200, body: chatStream() }));
    const cred = ctx.credential('custom');
    const result = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'local-model', customUpstreamUrl: 'https://llm.example.org/v1/chat/completions' });
    expect(byName(result, 'authentication').outcome).toBe('not_tested');
    expect(result.outcome).toBe('verified');
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification?.outcome).toBe('verified');

    const blocked = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'local-model', customUpstreamUrl: 'https://10.0.0.5/v1/chat/completions' });
    expect(blocked.outcome).toBe('failed');
    expect(byName(blocked, 'protocol')).toMatchObject({ outcome: 'failed', errorCategory: 'forbidden_host' });
    expect(ctx.requests).toHaveLength(1);
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: ctx.credential().id, customUpstreamUrl: 'https://llm.example.org/v1' }))
      .rejects.toThrow('only to the custom provider');
  });

  it('never returns, stores or audits the credential, even when the provider echoes it', async () => {
    const echo = json({ error: { message: `upstream failure for key ${SECRET} and sk-proj-abcdef****wxyz` } });
    const ctx = setup(openAiHandler({ inference: { status: 500, body: echo }, tools: { status: 500, body: echo } }));
    const cred = ctx.credential();
    const saved = ctx.profile(cred.id, 'gpt-test');
    const result = await ctx.verifier.verify(ctx.p1, { profileId: saved.id, checks: { tools: true } });
    expect(result.outcome).toBe('limited');
    const stored = ctx.store.database.prepare('SELECT result_json FROM model_verification_results').all() as Array<{ result_json: string }>;
    for (const text of [JSON.stringify(result), JSON.stringify(ctx.audits), ...stored.map((row) => row.result_json)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('abcdef****');
    }
    expect(byName(result, 'streaming_inference').message).toContain('[redacted]');
    expect(byName(result, 'streaming_inference').message!.length).toBeLessThanOrEqual(300);
  });

  it('refuses a disabled credential and another principal\'s credential or profile', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const saved = ctx.profile(cred.id, 'gpt-test');
    await expect(ctx.verifier.verify(ctx.p2, { credentialId: cred.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ctx.verifier.verify(ctx.p2, { profileId: saved.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    ctx.store.database.prepare("UPDATE model_provider_credentials SET status = 'DISABLED' WHERE id = ?").run(cred.id);
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: cred.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ctx.verifier.verify(ctx.p1, { profileId: saved.id })).rejects.toThrow('disabled');
    expect(ctx.requests).toHaveLength(0);
    expect(ctx.audits).toHaveLength(0);
  });

  it('limits checks per principal', async () => {
    let now = 1_000_000;
    const ctx = setup(openAiHandler(), { limiter: new VerificationRateLimiter(2, 60_000, () => now) });
    const cred = ctx.credential();
    await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    await ctx.verifier.verify(ctx.p1, { credentialId: cred.id });
    const refused = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HarnessError);
    expect(refused).toMatchObject({ code: 'LIMIT_EXCEEDED', status: 429 });
    // Another principal has its own window.
    await expect(ctx.verifier.verify(ctx.p2, { credentialId: ctx.credential('openai', undefined, ctx.p2).id })).resolves.toBeDefined();
    now += 60_000;
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: cred.id })).resolves.toBeDefined();
  });

  it('does not spend the allowance on a request that never reaches the provider', async () => {
    const ctx = setup(openAiHandler(), { limiter: new VerificationRateLimiter(1, 60_000) });
    const cred = ctx.credential();
    await expect(ctx.verifier.verify(ctx.p1, { profileId: 'missing-profile' as never })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: cred.id, checks: { inference: true } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: cred.id })).resolves.toBeDefined();
    await expect(ctx.verifier.verify(ctx.p1, { credentialId: cred.id })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('never lets an older check replace a newer stored result', () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const record = (outcome: 'verified' | 'failed', checkedAt: number) => ctx.repo.recordVerification(ctx.p1, {
      targetKind: 'credential', targetId: cred.id, revisionId: null, credentialVersion: 1, outcome, resultJson: '{}', checkedAt
    });
    expect(record('verified', 2_000)).toBe(true);
    expect(record('failed', 1_000)).toBe(false);
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification).toMatchObject({ outcome: 'verified', checkedAt: 2_000 });
    expect(record('failed', 3_000)).toBe(true);
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification).toMatchObject({ outcome: 'failed', checkedAt: 3_000 });
  });

  it('keeps the active key version\'s result across key versions whatever the timestamps', () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const record = (credentialVersion: number, outcome: 'verified' | 'failed', checkedAt: number) => ctx.repo.recordVerification(ctx.p1, {
      targetKind: 'credential', targetId: cred.id, revisionId: null, credentialVersion, outcome, resultJson: '{}', checkedAt
    });
    expect(record(1, 'failed', 1_000)).toBe(true);
    const rotated = ctx.repo.rotateCredential(ctx.p1, cred.id, { apiKey: `${SECRET}-2`, expectedGeneration: 1 });
    expect(rotated.activeVersion).toBe(2);
    expect(record(2, 'verified', 2_000)).toBe(true);
    // A check of the old key that finishes later never replaces the current key's result.
    expect(record(1, 'failed', 3_000)).toBe(false);
    expect(ctx.repo.listCredentials(ctx.p1)[0]?.lastVerification).toMatchObject({ outcome: 'verified', checkedAt: 2_000 });
  });

  it('keeps the active revision\'s result across revisions whatever the timestamps', () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const saved = ctx.profile(cred.id, 'gpt-test');
    const oldRevision = saved.activeRevisionId;
    const record = (revisionId: string | null, outcome: 'verified' | 'failed', checkedAt: number) => ctx.repo.recordVerification(ctx.p1, {
      targetKind: 'profile', targetId: saved.id, revisionId, credentialVersion: null, outcome, resultJson: '{}', checkedAt
    });
    expect(record(oldRevision, 'failed', 5_000)).toBe(true);
    const updated = ctx.repo.updateProfile(ctx.p1, saved.id, { displayName: 'Renamed', expectedGeneration: saved.generation });
    // An earlier draft check attached to the new revision replaces the old revision's newer result.
    expect(record(updated.activeRevisionId, 'verified', 4_000)).toBe(true);
    expect(ctx.repo.listProfiles(ctx.p1)[0]?.lastVerification).toMatchObject({ outcome: 'verified', checkedAt: 4_000 });
    // A late result for the old revision never replaces the active revision's.
    expect(record(oldRevision, 'failed', 6_000)).toBe(false);
    expect(ctx.repo.listProfiles(ctx.p1)[0]?.lastVerification).toMatchObject({ outcome: 'verified', checkedAt: 4_000 });
  });

  it('does not store a result for a target that was deleted or belongs to another principal', () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const saved = ctx.profile(cred.id, 'gpt-test');
    const count = () => (ctx.store.database.prepare('SELECT count(*) AS count FROM model_verification_results').get() as { count: number }).count;
    expect(ctx.repo.recordVerification(ctx.p2, {
      targetKind: 'credential', targetId: cred.id, revisionId: null, credentialVersion: 1, outcome: 'verified', resultJson: '{}', checkedAt: 1
    })).toBe(false);
    ctx.repo.deleteProfile(ctx.p1, saved.id, saved.generation);
    expect(ctx.repo.recordVerification(ctx.p1, {
      targetKind: 'profile', targetId: saved.id, revisionId: saved.activeRevisionId, credentialVersion: null, outcome: 'verified', resultJson: '{}', checkedAt: 1
    })).toBe(false);
    ctx.repo.deleteCredential(ctx.p1, cred.id, 1);
    expect(ctx.repo.recordVerification(ctx.p1, {
      targetKind: 'credential', targetId: cred.id, revisionId: null, credentialVersion: 1, outcome: 'verified', resultJson: '{}', checkedAt: 1
    })).toBe(false);
    expect(count()).toBe(0);
  });

  it('drops stored results when the state schema is downgraded below the model tables', () => {
    const ctx = setup(openAiHandler());
    const tables = () => new Set((ctx.store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(tables().has('model_verification_results')).toBe(true);
    downgradeStateSchemaToV11(ctx.store.database);
    downgradeStateSchemaToV10(ctx.store.database);
    downgradeStateSchemaToV9(ctx.store.database);
    downgradeStateSchemaToV8(ctx.store.database);
    expect(tables().has('model_verification_results')).toBe(false);
  });

  it('removes stored results with the profile and the credential', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const saved = ctx.profile(cred.id, 'gpt-test');
    await ctx.verifier.verify(ctx.p1, { profileId: saved.id });
    const count = () => (ctx.store.database.prepare('SELECT count(*) AS count FROM model_verification_results').get() as { count: number }).count;
    expect(count()).toBe(2);
    ctx.repo.deleteProfile(ctx.p1, saved.id, saved.generation);
    expect(count()).toBe(1);
    ctx.repo.deleteCredential(ctx.p1, cred.id, 1);
    expect(count()).toBe(0);
  });
});

describe('draft verification attached to a profile save', () => {
  it('keeps a matching draft result on the revision the save creates, once', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const draft = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    expect(draft.verificationRef).toMatch(/^vref_[0-9a-f]{32}$/);
    expect(ModelConnectionVerifyResultSchema.parse(draft)).toEqual(draft);

    const saved = ctx.verifier.attachDraftVerification(ctx.p1, draft.verificationRef, ctx.profile(cred.id, 'gpt-test'));
    expect(saved.lastVerification).toEqual({ outcome: 'verified', checkedAt: draft.checkedAt, revisionId: saved.activeRevisionId });
    expect(ctx.repo.listProfiles(ctx.p1)[0]?.lastVerification).toEqual(saved.lastVerification);
    const stored = ctx.store.database.prepare("SELECT revision_id, result_json FROM model_verification_results WHERE target_kind = 'profile'").get() as { revision_id: string; result_json: string };
    expect(stored.revision_id).toBe(saved.activeRevisionId);
    // The reference is a handle, not part of the result the runner keeps.
    expect(stored.result_json).not.toContain('vref_');

    // Single use: the same reference never attaches to a second save.
    const again = ctx.verifier.attachDraftVerification(ctx.p1, draft.verificationRef, ctx.profile(cred.id, 'gpt-test'));
    expect(again.lastVerification).toBeUndefined();
  });

  it('reports whether a draft result would attach without spending the reference', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const draft = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    const route = { credentialId: cred.id, model: 'gpt-test', apiMode: 'chat-completions' as const, upstreamUrl: 'https://api.openai.com/v1/chat/completions' };
    expect(ctx.verifier.draftVerificationAttachable(ctx.p1, draft.verificationRef, route)).toBe(true);
    expect(ctx.verifier.draftVerificationAttachable(ctx.p1, draft.verificationRef, route)).toBe(true);
    expect(ctx.verifier.draftVerificationAttachable(ctx.p1, draft.verificationRef, { ...route, model: 'gpt-other' })).toBe(false);
    expect(ctx.verifier.draftVerificationAttachable(ctx.p2, draft.verificationRef, route)).toBe(false);
    expect(ctx.verifier.draftVerificationAttachable(ctx.p1, undefined, route)).toBe(false);
    // Looking, even at a mismatched route, left the reference for the save.
    const saved = ctx.verifier.attachDraftVerification(ctx.p1, draft.verificationRef, ctx.profile(cred.id, 'gpt-test'));
    expect(saved.lastVerification?.outcome).toBe('verified');
    expect(ctx.verifier.draftVerificationAttachable(ctx.p1, draft.verificationRef, route)).toBe(false);
  });

  it('never reports an expired draft result as attachable', () => {
    let now = 1_000;
    const store = new DraftVerificationStore(() => now);
    const route = { credentialId: 'cred_1', credentialVersion: 1, model: 'm', apiMode: 'chat-completions' as const, upstreamUrl: 'https://api.openai.com/v1/chat/completions' };
    const ref = store.remember('p1', route, {} as ModelConnectionVerifyResult);
    expect(store.peek('p1', ref, route)).toBe(true);
    now += DRAFT_VERIFICATION_TTL_MS;
    expect(store.peek('p1', ref, route)).toBe(false);
  });

  it('keeps a draft result on an updated revision, and never a stale one', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const original = ctx.profile(cred.id, 'gpt-test');
    const draft = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-other' });
    const updated = ctx.verifier.attachDraftVerification(ctx.p1, draft.verificationRef,
      ctx.repo.updateProfile(ctx.p1, original.id, { model: 'gpt-other', expectedGeneration: original.generation }));
    expect(updated.lastVerification?.revisionId).toBe(updated.activeRevisionId);
    expect(updated.activeRevisionId).not.toBe(original.activeRevisionId);
  });

  it('does not attach when the model, API mode, upstream, or key version differs', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const attach = (ref: string | undefined, saved: ReturnType<typeof ctx.profile>) => ctx.verifier.attachDraftVerification(ctx.p1, ref, saved).lastVerification;

    const model = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    expect(attach(model.verificationRef, ctx.profile(cred.id, 'gpt-other'))).toBeUndefined();
    // A mismatch spends the reference, so it cannot be retried against the right route.
    expect(attach(model.verificationRef, ctx.profile(cred.id, 'gpt-test'))).toBeUndefined();

    const mode = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test', apiMode: 'chat-completions' });
    expect(attach(mode.verificationRef, ctx.profile(cred.id, 'gpt-test', 'responses'))).toBeUndefined();

    const rotated = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    ctx.repo.rotateCredential(ctx.p1, cred.id, { apiKey: `${SECRET}-next`, expectedGeneration: 1 });
    expect(attach(rotated.verificationRef, ctx.profile(cred.id, 'gpt-test'))).toBeUndefined();

    const custom = ctx.credential('custom');
    const upstream = await ctx.verifier.verify(ctx.p1, { credentialId: custom.id, model: 'local', customUpstreamUrl: 'https://llm.example.org/v1/chat/completions' });
    expect(attach(upstream.verificationRef, ctx.profile(custom.id, 'local', 'chat-completions', { customUpstreamUrl: 'https://other.example.org/v1/chat/completions' }))).toBeUndefined();
    const sameUpstream = await ctx.verifier.verify(ctx.p1, { credentialId: custom.id, model: 'local', customUpstreamUrl: 'https://llm.example.org/v1/chat/completions' });
    expect(attach(sameUpstream.verificationRef, ctx.profile(custom.id, 'local', 'chat-completions', { customUpstreamUrl: 'https://llm.example.org/v1/chat/completions' }))?.outcome).toBe('verified');

    expect(attach(undefined, ctx.profile(cred.id, 'gpt-test'))).toBeUndefined();
    expect(attach('vref_000000000000000000000000000000ff', ctx.profile(cred.id, 'gpt-test'))).toBeUndefined();
    expect((ctx.store.database.prepare("SELECT count(*) AS count FROM model_verification_results WHERE target_kind = 'profile'").get() as { count: number }).count).toBe(1);
  });

  it('does not attach a draft result once it has expired', async () => {
    let clock = 1_000_000;
    const ctx = setup(openAiHandler(), { now: () => clock });
    const cred = ctx.credential();
    const fresh = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    const stale = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    clock += DRAFT_VERIFICATION_TTL_MS - 1;
    expect(ctx.verifier.attachDraftVerification(ctx.p1, fresh.verificationRef, ctx.profile(cred.id, 'gpt-test')).lastVerification?.outcome).toBe('verified');
    clock += 1;
    expect(ctx.verifier.attachDraftVerification(ctx.p1, stale.verificationRef, ctx.profile(cred.id, 'gpt-test')).lastVerification).toBeUndefined();
  });

  it('refuses another principal and leaves the owner\'s reference unspent', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const draft = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });

    const store = new DraftVerificationStore();
    const route = { credentialId: cred.id, credentialVersion: 1, model: 'gpt-test', apiMode: 'chat-completions' as const, upstreamUrl: 'https://api.openai.com/v1/chat/completions' };
    const ref = store.remember(ctx.p1, route, draft);
    expect(store.take(ctx.p2, ref, route)).toBeUndefined();
    expect(store.take(ctx.p1, ref, route)).toBe(draft);
    expect(store.take(ctx.p1, ref, route)).toBeUndefined();

    // Through the verifier: another principal's save of its own profile cannot use the reference.
    const otherCred = ctx.credential('openai', undefined, ctx.p2);
    expect(ctx.verifier.attachDraftVerification(ctx.p2, draft.verificationRef, ctx.profile(otherCred.id, 'gpt-test', 'chat-completions', {}, ctx.p2)).lastVerification).toBeUndefined();
    expect(ctx.verifier.attachDraftVerification(ctx.p1, draft.verificationRef, ctx.profile(cred.id, 'gpt-test')).lastVerification?.outcome).toBe('verified');
  });

  it('issues a reference only for a draft that names a model', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    expect((await ctx.verifier.verify(ctx.p1, { credentialId: cred.id })).verificationRef).toBeUndefined();
    const saved = ctx.profile(cred.id, 'gpt-test');
    expect((await ctx.verifier.verify(ctx.p1, { profileId: saved.id })).verificationRef).toBeUndefined();
  });

  it('attaches to an update that switches credential only when the check was of the new credential', async () => {
    const ctx = setup(openAiHandler());
    const first = ctx.credential();
    const second = ctx.credential();
    const switchTo = async (checked: string) => {
      const original = ctx.profile(first.id, 'gpt-test');
      const check = await ctx.verifier.verify(ctx.p1, { credentialId: checked, model: 'gpt-test' });
      return ctx.verifier.attachDraftVerification(ctx.p1, check.verificationRef,
        ctx.repo.updateProfile(ctx.p1, original.id, { credentialId: second.id as never, expectedGeneration: original.generation }));
    };

    expect((await switchTo(first.id)).lastVerification).toBeUndefined();
    const attached = await switchTo(second.id);
    expect(attached.activeRevision?.credentialId).toBe(second.id);
    expect(attached.lastVerification?.revisionId).toBe(attached.activeRevisionId);
  });

  it('never fails a committed save when the result cannot be stored', async () => {
    const ctx = setup(openAiHandler());
    const cred = ctx.credential();
    const draft = await ctx.verifier.verify(ctx.p1, { credentialId: cred.id, model: 'gpt-test' });
    const saved = ctx.profile(cred.id, 'gpt-test');
    ctx.repo.recordVerification = () => { throw new Error('database is locked'); };
    const result = ctx.verifier.attachDraftVerification(ctx.p1, draft.verificationRef, saved);
    expect(result).toBe(saved);
    expect(result.lastVerification).toBeUndefined();
  });

  it('keeps at most a bounded number of references and drops the oldest first', () => {
    const store = new DraftVerificationStore();
    const route = { credentialId: 'cred_1', credentialVersion: 1, model: 'm', apiMode: 'chat-completions' as const, upstreamUrl: 'https://example.org/v1/chat/completions' };
    const result = { outcome: 'verified' } as ModelConnectionVerifyResult;
    const refs = Array.from({ length: 1_001 }, () => store.remember('p1', route, result));
    expect(store.take('p1', refs[0]!, route)).toBeUndefined();
    expect(store.take('p1', refs[1]!, route)).toBe(result);
    expect(store.take('p1', refs[1_000]!, route)).toBe(result);
  });
});

describe('model_connection_verify operation', () => {
  it('dispatches through the dashboard control service and audits the check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'model-verify-svc-')); roots.push(root);
    const databasePath = join(root, 'state.db');
    const principals = new StateStore(databasePath);
    const keyring = new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]);
    const metadata = new MetadataStore(databasePath, keyring);
    closers.push(() => { metadata.database.close(); principals.close(); });
    const artifacts = new ArtifactStore(principals.database, { root: join(root, 'artifacts'), maxArtifactBytes: 1024, maxPrincipalBytes: 4096, defaultRetentionMs: 60_000, maxRetentionMs: 120_000 });
    const repo = new ModelProfileStateRepository(principals.database, keyring);
    const http = fakeHttp(openAiHandler());
    const controls = new DashboardControlService(
      { artifactRetentionSeconds: 60 } as RunnerConfig, principals, metadata, artifacts, {} as WorkspaceService,
      undefined, undefined, repo, undefined, keyring, undefined, http.client
    );
    const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'operator-a' };
    const call = (operation: MetadataRunnerRequest['operation'], input: Record<string, unknown>) =>
      controls.execute({ version: 2, principal, operation, input } as MetadataRunnerRequest);

    const created = await call('model_credential_create', { label: 'OpenAI', provider: 'openai', apiKey: SECRET });
    const credentialId = (created.data as { id: string }).id;
    const verified = await call('model_connection_verify', { credentialId, model: 'gpt-test' });
    expect(verified.ok).toBe(true);
    expect((verified.data as ModelConnectionVerifyResult).outcome).toBe('verified');
    expect(JSON.stringify(verified)).not.toContain(SECRET);

    const listed = await call('model_credential_list', {});
    expect((listed.data as { credentials: Array<{ lastVerification?: { outcome: string } }> }).credentials[0]?.lastVerification?.outcome).toBe('verified');

    const audit = await call('audit_list', { limit: 10 });
    const events = (audit.data as { events: Array<{ action: string; subjectId: string; details: Record<string, unknown> }> }).events;
    const event = events.find((entry) => entry.action === 'model_connection.verified');
    expect(event).toMatchObject({ subjectId: credentialId, details: expect.objectContaining({ outcome: 'verified', target: 'draft' }) });
    expect(JSON.stringify(events)).not.toContain(SECRET);

    // Both target shapes at once is not a valid request.
    await expect(call('model_connection_verify', { credentialId, profileId: 'coding' })).rejects.toThrow();

    // A profile save that names the draft check of its exact route keeps that result.
    const profileInput = {
      displayName: 'Coding', credentialId, model: 'gpt-test', apiMode: 'chat-completions',
      pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      limits: { maxInputTokens: 100, maxOutputTokens: 100, maxCostMicros: 100 },
      maxProxyOperations: ['files_read']
    };
    const { verificationRef } = verified.data as ModelConnectionVerifyResult;
    const createdProfile = await call('model_profile_create', { profileId: 'coding', ...profileInput, verificationRef });
    const saved = createdProfile.data as { activeRevisionId: string; generation: number; lastVerification?: { outcome: string; revisionId: string } };
    expect(saved.lastVerification).toMatchObject({ outcome: 'verified', revisionId: saved.activeRevisionId });

    const responsesCheck = await call('model_connection_verify', { credentialId, model: 'gpt-test', apiMode: 'responses' });
    const updatedProfile = await call('model_profile_update', {
      profileId: 'coding', apiMode: 'responses', expectedGeneration: saved.generation,
      verificationRef: (responsesCheck.data as ModelConnectionVerifyResult).verificationRef
    });
    const updated = updatedProfile.data as { activeRevisionId: string; lastVerification?: { revisionId: string } };
    expect(updated.lastVerification?.revisionId).toBe(updated.activeRevisionId);

    // An unknown reference never fails the save; it just keeps nothing.
    const unverified = await call('model_profile_create', { profileId: 'coding-2', ...profileInput, verificationRef: 'vref_000000000000000000000000000000ff' });
    expect(unverified.ok).toBe(true);
    expect((unverified.data as { lastVerification?: unknown }).lastVerification).toBeUndefined();

    // A save that fails leaves the reference unspent for the save that follows.
    const retryCheck = await call('model_connection_verify', { credentialId, model: 'gpt-test' });
    const retryRef = (retryCheck.data as ModelConnectionVerifyResult).verificationRef;
    const duplicate = await call('model_profile_create', { profileId: 'coding', ...profileInput, verificationRef: retryRef }).catch((error: unknown) => error);
    expect((duplicate as { ok?: boolean }).ok).not.toBe(true);
    const retried = await call('model_profile_create', { profileId: 'coding-3', ...profileInput, verificationRef: retryRef });
    expect((retried.data as { lastVerification?: { outcome: string } }).lastVerification?.outcome).toBe('verified');
  });
});

describe('provider failure classification', () => {
  it('maps documented provider statuses onto verification categories', async () => {
    const { classifyHttpFailure, outcomeForCategory } = await import('../src/model-verification/failure-classification.js');
    const cases: Array<[ModelProviderKind, number, string, string]> = [
      ['openai', 401, '{}', 'auth'],
      ['google', 400, json([{ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' } }]), 'auth'],
      ['google', 400, json({ error: { message: 'models/gemini-x is not found for API version v1beta' } }), 'not_found'],
      ['openai', 400, json({ error: { message: "Unsupported parameter: 'max_tokens'" } }), 'unsupported_protocol'],
      ['openai', 400, json({ error: { message: 'The model `x` does not exist' } }), 'not_found'],
      ['openrouter', 403, json({ error: { message: 'Key limit exceeded (credit limit)' } }), 'quota'],
      ['openai', 403, json({ error: { message: 'Country not supported' } }), 'access'],
      ['openrouter', 402, json({ error: { message: 'Insufficient credits' } }), 'quota'],
      ['openrouter', 429, json({ error: { message: 'Rate limit exceeded' } }), 'rate_limited'],
      ['openai', 429, json({ error: { code: 'insufficient_quota' } }), 'quota'],
      ['anthropic', 529, json({ error: { type: 'overloaded_error' } }), 'upstream'],
      ['deepseek', 404, '', 'not_found']
    ];
    for (const [provider, status, body, category] of cases) {
      expect(classifyHttpFailure(provider, status, body, SECRET).category, `${provider} ${status}`).toBe(category);
    }
    for (const category of ['rate_limited', 'quota', 'timeout', 'network', 'upstream'] as const) expect(outcomeForCategory(category)).toBe('limited');
    for (const category of ['auth', 'access', 'not_found', 'unsupported_protocol', 'forbidden_host', 'invalid_response'] as const) expect(outcomeForCategory(category)).toBe('failed');
  });
});
