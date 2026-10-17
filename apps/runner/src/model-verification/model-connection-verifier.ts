import { randomUUID } from 'node:crypto';
import {
  HarnessError,
  getModelProvider,
  resolveProviderUpstreamUrl,
  type AgentModelApiMode,
  type AgentModelProfileMetadata,
  type AgentModelProfileRevision,
  type AgentModelPricing,
  type ModelConnectionVerifyInput,
  type ModelConnectionVerifyResult,
  type ModelProviderKind,
  type ModelVerificationCheck,
  type ModelVerificationCheckName,
  type ModelVerificationOutcome,
  type ModelVerificationRef,
  type ModelVerificationUsage,
  type ProviderAuthMode
} from '@cloud-harness/contracts';
import { ProviderHttpError, assertProviderRequestUrl, type ProviderHttpClient, type ProviderHttpRequest, type ProviderHttpResponse } from '../model-provider-http.js';
import type { ModelChangeActor } from '../model-profile-guard.js';
import type { ModelProfileStateRepository, VerificationCredential } from '../model-profile-state-repository.js';
import {
  classifyHttpFailure, classifyStreamError, classifyTransportFailure, isScopeRefusal, isToolsUnsupported, outcomeForCategory, sanitizeMessage,
  type ClassifiedFailure
} from './failure-classification.js';
import { DraftVerificationStore, type DraftVerificationRoute } from './draft-verification-store.js';
import { calledTool, createStreamProbe, parseNonStreamedAnswer } from './stream-probe.js';
import { VerificationRateLimiter } from './verification-rate-limiter.js';

// Runner-side connection check for a model provider credential and model. Every
// request goes through the pinned provider HTTP client to a registry host (or the
// operator's custom upstream), is bounded in time and size, and never returns or
// records the credential.

const LISTING_TIMEOUT_MS = 8_000;
const LISTING_MAX_BYTES = 4 * 1024 * 1024;
const INFERENCE_TIMEOUT_MS = 20_000;
const INFERENCE_MAX_BYTES = 256 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
// One deadline for the whole run, name resolution included. It stays well
// inside the API's runner request timeout so the caller always gets a result.
const TOTAL_BUDGET_MS = 45_000;
const MIN_REQUEST_MS = 1_000;
const PROMPT = 'Reply with OK.';
// Several providers enforce a minimum output cap of 16 tokens.
const INFERENCE_MAX_OUTPUT_TOKENS = 16;
const TOOL_MAX_OUTPUT_TOKENS = 128;
const TOOL_NAME = 'report_status';
const ANTHROPIC_VERSION = '2023-06-01';

// OpenRouter's model list is public, so a key is checked against its key endpoint instead.
const KEY_CHECK_URLS: Partial<Record<ModelProviderKind, string>> = {
  openrouter: 'https://openrouter.ai/api/v1/key'
};

/** The route fields of a revision that a draft check must match. */
export type DraftRevisionRoute = Pick<AgentModelProfileRevision, 'credentialId' | 'model' | 'apiMode' | 'upstreamUrl'>;

export type VerificationAudit = (
  principalId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  generation: number,
  details: Record<string, string | number | boolean>
) => void;

export interface ModelConnectionVerifierOptions {
  repository: ModelProfileStateRepository;
  http: ProviderHttpClient;
  audit?: VerificationAudit;
  now?: () => number;
  rateLimiter?: VerificationRateLimiter;
  drafts?: DraftVerificationStore;
  // Overrides the run's total time budget; tests use a short one.
  totalBudgetMs?: number;
}

interface VerificationTarget {
  kind: 'profile' | 'draft';
  profileId?: string;
  profileGeneration?: number;
  revisionId?: string;
  pricing: AgentModelPricing | null;
  credential: VerificationCredential;
  model: string | null;
  apiMode: AgentModelApiMode;
  // Resolved lazily: a draft without a model never needs an inference URL.
  upstreamUrl: () => string;
  runInference: boolean;
  runTools: boolean;
  // Sent as the provider's session header, when it has one, on every request of this check.
  sessionId: string;
}

interface ModelListing {
  ids: Set<string>;
  complete: boolean;
}

interface InferenceEvidence {
  protocol: ModelVerificationCheck;
  streaming: ModelVerificationCheck;
  failure?: ClassifiedFailure;
  usage?: ModelVerificationUsage;
}

type HeaderStyle = ProviderAuthMode | 'anthropic';

function credentialHeaders(style: HeaderStyle, secret: string): Record<string, string> {
  if (style === 'anthropic') return { 'x-api-key': secret, 'anthropic-version': ANTHROPIC_VERSION };
  if (style === 'x-api-key') return { 'x-api-key': secret };
  return { authorization: `Bearer ${secret}` };
}

/**
 * The Chat Completions output cap, named as the model gateway names it: OpenAI
 * (the provider, or a custom upstream on api.openai.com) takes
 * `max_completion_tokens` because its reasoning models refuse `max_tokens`;
 * every other provider takes `max_tokens`.
 */
export function chatOutputCap(provider: ModelProviderKind, upstreamUrl: string, tokens: number): { max_completion_tokens: number } | { max_tokens: number } {
  let host = '';
  try { host = new URL(upstreamUrl).hostname.toLowerCase(); } catch { /* the request itself reports a bad URL */ }
  return provider === 'openai' || host === 'api.openai.com' ? { max_completion_tokens: tokens } : { max_tokens: tokens };
}

function normalizeModelId(id: string): string {
  return id.startsWith('models/') ? id.slice('models/'.length) : id;
}

function check(name: ModelVerificationCheckName, outcome: ModelVerificationOutcome, elapsedMs: number, failure?: ClassifiedFailure, message?: string): ModelVerificationCheck {
  const result: ModelVerificationCheck = { name, outcome, elapsedMs: Math.max(0, Math.round(elapsedMs)) };
  if (failure) {
    result.errorCategory = failure.category;
    if (failure.httpStatus !== undefined) result.httpStatus = failure.httpStatus;
    result.message = failure.message;
  } else if (message !== undefined) {
    result.message = message;
  }
  return result;
}

function failedCheck(name: ModelVerificationCheckName, elapsedMs: number, failure: ClassifiedFailure): ModelVerificationCheck {
  return check(name, outcomeForCategory(failure.category), elapsedMs, failure);
}

const notTested = (name: ModelVerificationCheckName, message?: string): ModelVerificationCheck => check(name, 'not_tested', 0, undefined, message);

/** Worst outcome wins; a check that did not run does not count. */
export function overallOutcome(checks: readonly ModelVerificationCheck[]): ModelVerificationOutcome {
  if (checks.some((entry) => entry.outcome === 'failed')) return 'failed';
  if (checks.some((entry) => entry.outcome === 'limited')) return 'limited';
  if (checks.some((entry) => entry.outcome === 'verified')) return 'verified';
  return 'not_tested';
}

/**
 * What the run proved about the key alone, for the credential's own status. A
 * refused model list (a key scoped away from listing) proves nothing either
 * way, so inference decides when it ran, and an inference that rejects the
 * key overrides a listing that accepted it.
 */
function credentialOutcome(checks: readonly ModelVerificationCheck[]): ModelVerificationOutcome {
  // A provider that rejects the key during inference has the last word.
  const inference = checks.filter((entry) => entry.name !== 'authentication' && entry.name !== 'model_access');
  if (inference.some((entry) => entry.errorCategory === 'auth')) return 'failed';
  const authentication = checks.find((entry) => entry.name === 'authentication');
  const listingRefused = authentication?.outcome === 'limited' && authentication.errorCategory === 'access';
  if (authentication && authentication.outcome !== 'not_tested' && !listingRefused) return authentication.outcome;
  if (inference.some((entry) => entry.outcome === 'verified')) return 'verified';
  return listingRefused ? 'limited' : 'not_tested';
}

function costMicros(tokens: number, pricePerMillion: number): number {
  return Number((BigInt(tokens) * BigInt(pricePerMillion) + 999_999n) / 1_000_000n);
}

function addUsage(left: ModelVerificationUsage | undefined, right: ModelVerificationUsage | undefined): ModelVerificationUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens };
}

export class ModelConnectionVerifier {
  private readonly now: () => number;
  private readonly rateLimiter: VerificationRateLimiter;
  private readonly drafts: DraftVerificationStore;
  private readonly totalBudgetMs: number;

  constructor(private readonly options: ModelConnectionVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.rateLimiter = options.rateLimiter ?? new VerificationRateLimiter();
    this.drafts = options.drafts ?? new DraftVerificationStore(this.now);
    this.totalBudgetMs = options.totalBudgetMs ?? TOTAL_BUDGET_MS;
  }

  /**
   * Checks a route with bounded probes. `actor` names the channel that asked, for
   * the audit entry only; it never changes what is checked.
   */
  async verify(principalId: string, input: ModelConnectionVerifyInput, actor: ModelChangeActor = 'dashboard'): Promise<ModelConnectionVerifyResult> {
    const target = this.resolveTarget(principalId, input);
    // Only a request that will reach the provider uses up the principal's allowance.
    this.rateLimiter.take(principalId);
    const startedAt = this.now();
    const deadline = startedAt + this.totalBudgetMs;
    const secret = target.credential.secret;
    const provider = target.credential.provider;

    const { check: authentication, listing } = await this.checkAuthentication(target, deadline);
    const authFailed = authentication.outcome === 'failed';
    const skipped = 'skipped because authentication failed';

    let inference: InferenceEvidence | undefined;
    if (target.runInference && !authFailed) inference = await this.checkInference(target, deadline);
    const protocol = inference?.protocol ?? notTested('protocol', authFailed && target.runInference ? skipped : undefined);
    const streaming = inference?.streaming ?? notTested('streaming_inference', authFailed && target.runInference ? skipped : undefined);

    let toolCall: ModelVerificationCheck;
    let toolUsage: ModelVerificationUsage | undefined;
    if (!target.runTools) toolCall = notTested('tool_call');
    else if (authFailed) toolCall = notTested('tool_call', skipped);
    else if (inference?.failure && outcomeForCategory(inference.failure.category) === 'failed') toolCall = notTested('tool_call', 'skipped because inference failed');
    else ({ check: toolCall, usage: toolUsage } = await this.checkToolCall(target, deadline));

    const modelAccess = this.modelAccess(target, authFailed, listing, inference, toolCall, secret);
    const checks = [authentication, modelAccess, protocol, streaming, toolCall];
    const usage = addUsage(inference?.usage, toolUsage);
    const checkedAt = this.now();
    const result: ModelConnectionVerifyResult = {
      outcome: overallOutcome(checks),
      checkedAt,
      elapsedMs: Math.max(0, checkedAt - startedAt),
      provider,
      model: target.model,
      apiMode: target.apiMode,
      checks,
      ...(usage ? { usage } : {}),
      estimatedCostMicros: target.pricing && usage
        ? costMicros(usage.inputTokens, target.pricing.inputMicrosPerMillionTokens) + costMicros(usage.outputTokens, target.pricing.outputMicrosPerMillionTokens)
        : null
    };
    this.persist(principalId, target, result);
    this.options.audit?.(
      principalId,
      'model_connection.verified',
      target.kind === 'profile' ? 'model_profile' : 'model_credential',
      target.kind === 'profile' ? target.profileId! : target.credential.id,
      target.kind === 'profile' ? target.profileGeneration! : target.credential.generation,
      {
        actor,
        outcome: result.outcome,
        provider,
        target: target.kind,
        credentialId: target.credential.id,
        keyVersion: target.credential.activeVersion,
        ...(target.model ? { model: target.model } : {}),
        apiMode: target.apiMode,
        elapsedMs: result.elapsedMs,
        ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {})
      }
    );
    const verificationRef = this.rememberDraft(principalId, target, result);
    return verificationRef ? { ...result, verificationRef } : result;
  }

  /**
   * Keeps the result on the new revision a profile save just created, when a
   * draft check by the same principal covered exactly that route: credential,
   * key version, model, API mode, and resolved upstream. Any other reference,
   * including an expired or spent one, leaves the save as it is: the returned
   * profile simply has no `lastVerification`.
   */
  attachDraftVerification(principalId: string, ref: string | undefined, profile: AgentModelProfileMetadata): AgentModelProfileMetadata {
    const revision = profile.activeRevision;
    if (ref === undefined || !revision) return profile;
    const route = this.draftRoute(principalId, revision);
    if (!route) return profile;
    const result = this.drafts.take(principalId, ref, route);
    if (!result) return profile;
    let recorded = false;
    try {
      recorded = this.options.repository.recordVerification(principalId, {
        targetKind: 'profile', targetId: profile.id, revisionId: revision.id, credentialVersion: null,
        outcome: result.outcome, resultJson: JSON.stringify(result), checkedAt: result.checkedAt
      });
    } catch {
      // The save is already committed; losing the check only leaves the revision unverified.
    }
    return recorded ? { ...profile, lastVerification: { outcome: result.outcome, checkedAt: result.checkedAt, revisionId: revision.id } } : profile;
  }

  /**
   * Whether `attachDraftVerification` would keep the draft check for a revision with
   * this route. It only looks, so the reference stays available for the save.
   */
  draftVerificationAttachable(principalId: string, ref: string | undefined, revision: DraftRevisionRoute): boolean {
    if (ref === undefined) return false;
    const route = this.draftRoute(principalId, revision);
    return route !== undefined && this.drafts.peek(principalId, ref, route);
  }

  /** The draft route a revision matches: its route plus the credential's current key version. */
  private draftRoute(principalId: string, revision: DraftRevisionRoute): DraftVerificationRoute | undefined {
    const credential = this.options.repository.getCredential(principalId, revision.credentialId);
    if (!credential) return undefined;
    return {
      credentialId: revision.credentialId,
      credentialVersion: credential.activeVersion,
      model: revision.model,
      apiMode: revision.apiMode,
      upstreamUrl: revision.upstreamUrl
    };
  }

  /** Only a draft that names a model can match a profile, and only a route that resolves can be saved. */
  private rememberDraft(principalId: string, target: VerificationTarget, result: ModelConnectionVerifyResult): ModelVerificationRef | undefined {
    if (target.kind !== 'draft' || target.model === null) return undefined;
    let upstreamUrl: string;
    try {
      upstreamUrl = target.upstreamUrl();
    } catch {
      return undefined;
    }
    return this.drafts.remember(principalId, {
      credentialId: target.credential.id,
      credentialVersion: target.credential.activeVersion,
      model: target.model,
      apiMode: target.apiMode,
      upstreamUrl
    }, result);
  }

  private resolveTarget(principalId: string, input: ModelConnectionVerifyInput): VerificationTarget {
    const repository = this.options.repository;
    if ('profileId' in input) {
      const profile = repository.listProfiles(principalId).find((candidate) => candidate.id === input.profileId);
      if (!profile) throw new HarnessError('NOT_FOUND', 'model profile was not found', 404, false);
      const revision = profile.activeRevision;
      if (!revision) throw new HarnessError('INVALID_INPUT', 'model profile has no active revision to verify', 400, false);
      const credential = repository.getActiveCredentialForVerification(principalId, revision.credentialId);
      return {
        kind: 'profile',
        profileId: profile.id,
        profileGeneration: profile.generation,
        revisionId: revision.id,
        pricing: revision.pricing,
        credential,
        model: revision.model,
        apiMode: revision.apiMode,
        upstreamUrl: () => revision.upstreamUrl,
        runInference: input.checks?.inference ?? true,
        runTools: input.checks?.tools ?? false,
        sessionId: randomUUID()
      };
    }
    const credential = repository.getActiveCredentialForVerification(principalId, input.credentialId);
    const definition = getModelProvider(credential.provider);
    if (input.customUpstreamUrl !== undefined && !definition.requiresCustomUpstream) {
      throw new HarnessError('INVALID_INPUT', 'customUpstreamUrl applies only to the custom provider', 400, false);
    }
    const model = input.model ?? null;
    const runInference = input.checks?.inference ?? model !== null;
    const runTools = input.checks?.tools ?? false;
    if ((runInference || runTools) && model === null) {
      throw new HarnessError('INVALID_INPUT', 'a model is required for the inference and tool checks', 400, false);
    }
    const defaultMode: AgentModelApiMode = definition.requiresCustomUpstream || definition.endpoints['chat-completions'] !== undefined
      ? 'chat-completions'
      : 'responses';
    const apiMode = input.apiMode ?? defaultMode;
    // Validate the mode and endpoint up front, so an unsupported draft fails before any request.
    const upstream = runInference || runTools ? resolveProviderUpstreamUrl(credential.provider, apiMode, input.customUpstreamUrl) : undefined;
    return {
      kind: 'draft',
      pricing: null,
      credential,
      model,
      apiMode,
      upstreamUrl: () => upstream ?? resolveProviderUpstreamUrl(credential.provider, apiMode, input.customUpstreamUrl),
      runInference,
      runTools,
      sessionId: randomUUID()
    };
  }

  private remaining(deadline: number, cap: number): number {
    return Math.min(cap, deadline - this.now());
  }

  /**
   * Sends one request, bounded by its share of the run's deadline whatever the
   * client does: the client's own timeout already covers name resolution, and
   * the race guarantees the run never outlives its budget.
   */
  private async send(target: VerificationTarget, request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const provider = target.credential.provider;
    const custom = provider === 'custom' ? target.upstreamUrl() : undefined;
    assertProviderRequestUrl(provider, request.url, custom);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProviderHttpError('timeout', `provider did not answer within ${request.timeoutMs} ms`)), request.timeoutMs);
    });
    // A provider that asks for a session header gets it on every request of the check.
    const sessionHeader = getModelProvider(provider).sessionHeader;
    const outbound = sessionHeader === null ? request : { ...request, headers: { ...request.headers, [sessionHeader]: target.sessionId } };
    try {
      return await Promise.race([this.options.http.request(outbound), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkAuthentication(target: VerificationTarget, deadline: number): Promise<{ check: ModelVerificationCheck; listing?: ModelListing }> {
    const { provider, secret, authMode } = target.credential;
    const definition = getModelProvider(provider);
    if (definition.requiresCustomUpstream) {
      return { check: notTested('authentication', 'custom providers are checked through inference') };
    }
    const keyCheckUrl = KEY_CHECK_URLS[provider];
    const modelsEndpoint = definition.modelsEndpoint;
    const started = this.now();
    let authCheck: ModelVerificationCheck;
    let listing: ModelListing | undefined;
    if (keyCheckUrl) {
      authCheck = await this.probe('authentication', target, started, {
        url: keyCheckUrl, method: 'GET', headers: credentialHeaders(authMode, secret),
        timeoutMs: this.remaining(deadline, LISTING_TIMEOUT_MS), maxResponseBytes: 64 * 1024
      });
      // The public list never carries the key; it only tells whether the model ID exists.
      if (modelsEndpoint && target.model !== null && authCheck.outcome !== 'failed') {
        listing = await this.fetchListing(target, modelsEndpoint.url, {}, deadline);
      }
      return listing ? { check: authCheck, listing } : { check: authCheck };
    }
    if (!modelsEndpoint || modelsEndpoint.auth === 'none') {
      return { check: notTested('authentication', 'this provider has no key check endpoint') };
    }
    const style: HeaderStyle = modelsEndpoint.auth === 'anthropic' ? 'anthropic' : 'bearer';
    const url = modelsEndpoint.auth === 'anthropic' ? `${modelsEndpoint.url}?limit=1000` : modelsEndpoint.url;
    const timeoutMs = this.remaining(deadline, LISTING_TIMEOUT_MS);
    if (timeoutMs < MIN_REQUEST_MS) return { check: this.budgetExhausted('authentication') };
    try {
      const response = await this.send(target, { url, method: 'GET', headers: credentialHeaders(style, secret), timeoutMs, maxResponseBytes: LISTING_MAX_BYTES });
      const elapsed = this.now() - started;
      if (response.status < 200 || response.status >= 300) {
        const failure = classifyHttpFailure(provider, response.status, response.body, secret);
        if (response.status === 401 || response.status === 403) {
          // A restricted key may be refused the model list yet still run inference.
          const exercised = target.runInference || target.runTools;
          if (exercised || failure.category !== 'auth' || isScopeRefusal(response.body)) {
            return {
              check: check('authentication', 'limited', elapsed, {
                category: 'access',
                httpStatus: response.status,
                message: exercised
                  ? 'The provider refused the model list for this key; the inference check decides whether the key works.'
                  : 'The provider refused the model list for this key; it may lack permission to list models.'
              })
            };
          }
        }
        return { check: failedCheck('authentication', elapsed, failure) };
      }
      authCheck = check('authentication', 'verified', elapsed);
      listing = parseListing(response);
      return listing ? { check: authCheck, listing } : { check: authCheck };
    } catch (error) {
      return { check: failedCheck('authentication', this.now() - started, classifyTransportFailure(error, secret)) };
    }
  }

  private async probe(
    name: ModelVerificationCheckName,
    target: VerificationTarget,
    started: number,
    request: { url: string; method: 'GET'; headers: Record<string, string>; timeoutMs: number; maxResponseBytes: number }
  ): Promise<ModelVerificationCheck> {
    const { provider, secret } = target.credential;
    if (request.timeoutMs < MIN_REQUEST_MS) return this.budgetExhausted(name);
    try {
      const response = await this.send(target, request);
      const elapsed = this.now() - started;
      if (response.status >= 200 && response.status < 300) return check(name, 'verified', elapsed);
      return failedCheck(name, elapsed, classifyHttpFailure(provider, response.status, response.body, secret));
    } catch (error) {
      return failedCheck(name, this.now() - started, classifyTransportFailure(error, secret));
    }
  }

  private async fetchListing(target: VerificationTarget, url: string, headers: Record<string, string>, deadline: number): Promise<ModelListing | undefined> {
    const timeoutMs = this.remaining(deadline, LISTING_TIMEOUT_MS);
    if (timeoutMs < MIN_REQUEST_MS) return undefined;
    try {
      const response = await this.send(target, { url, method: 'GET', headers, timeoutMs, maxResponseBytes: LISTING_MAX_BYTES });
      return response.status >= 200 && response.status < 300 ? parseListing(response) : undefined;
    } catch {
      return undefined;
    }
  }

  private budgetExhausted(name: ModelVerificationCheckName): ModelVerificationCheck {
    return check(name, 'limited', 0, { category: 'timeout', message: 'The verification time budget ran out before this check.' });
  }

  private async checkInference(target: VerificationTarget, deadline: number): Promise<InferenceEvidence> {
    const { provider, secret, authMode } = target.credential;
    const started = this.now();
    const timeoutMs = this.remaining(deadline, INFERENCE_TIMEOUT_MS);
    if (timeoutMs < MIN_REQUEST_MS) {
      const exhausted = this.budgetExhausted('protocol');
      return { protocol: exhausted, streaming: { ...exhausted, name: 'streaming_inference' } };
    }
    const body = target.apiMode === 'chat-completions'
      ? { model: target.model, messages: [{ role: 'user', content: PROMPT }], ...chatOutputCap(provider, target.upstreamUrl(), INFERENCE_MAX_OUTPUT_TOKENS), stream: true, stream_options: { include_usage: true } }
      : { model: target.model, input: PROMPT, max_output_tokens: INFERENCE_MAX_OUTPUT_TOKENS, stream: true };
    const probe = createStreamProbe(target.apiMode);
    let response: ProviderHttpResponse;
    try {
      response = await this.send(target, {
        url: target.upstreamUrl(), method: 'POST', headers: credentialHeaders(authMode, secret), body: JSON.stringify(body),
        timeoutMs, maxResponseBytes: INFERENCE_MAX_BYTES, onLine: probe.onLine
      });
    } catch (error) {
      const failure = classifyTransportFailure(error, secret);
      const elapsed = this.now() - started;
      // Events that arrived before a timeout still prove the protocol.
      const protocol = probe.state.protocolEvents > 0 ? check('protocol', 'verified', elapsed) : failedCheck('protocol', elapsed, failure);
      return { protocol, streaming: failedCheck('streaming_inference', elapsed, failure), failure, ...(probe.state.usage ? { usage: probe.state.usage } : {}) };
    }
    const elapsed = this.now() - started;
    if (response.status < 200 || response.status >= 300) {
      const failure = classifyHttpFailure(provider, response.status, response.body, secret);
      return { protocol: failedCheck('protocol', elapsed, failure), streaming: failedCheck('streaming_inference', elapsed, failure), failure };
    }
    const state = probe.state;
    const usage = state.usage;
    if (state.streamError !== undefined) {
      const failure = classifyStreamError(provider, state.streamError, secret);
      const protocol = state.protocolEvents > 0 ? check('protocol', 'verified', elapsed) : failedCheck('protocol', elapsed, failure);
      return { protocol, streaming: failedCheck('streaming_inference', elapsed, failure), failure, ...(usage ? { usage } : {}) };
    }
    if (state.protocolEvents === 0) {
      if (state.jsonEvents === 0) {
        const document = parseNonStreamedAnswer(target.apiMode, response.body);
        if (document.matches) {
          const failure: ClassifiedFailure = { category: 'unsupported_protocol', message: 'The provider answered without streaming.' };
          return { protocol: check('protocol', 'verified', elapsed), streaming: failedCheck('streaming_inference', elapsed, failure), failure, ...(document.usage ? { usage: document.usage } : {}) };
        }
        const failure: ClassifiedFailure = { category: 'invalid_response', message: 'The provider answer was not a recognizable event stream.' };
        return { protocol: failedCheck('protocol', elapsed, failure), streaming: failedCheck('streaming_inference', elapsed, failure), failure };
      }
      const failure: ClassifiedFailure = {
        category: 'unsupported_protocol',
        message: state.foreignEvents > 0
          ? `The endpoint streamed events of a different API mode than ${target.apiMode}.`
          : `The endpoint streamed events that are not ${target.apiMode} events.`
      };
      return { protocol: failedCheck('protocol', elapsed, failure), streaming: failedCheck('streaming_inference', elapsed, failure), failure };
    }
    if (!state.completed) {
      const failure: ClassifiedFailure = response.truncated
        ? { category: 'invalid_response', message: 'The stream exceeded the verification size limit before it finished.' }
        : { category: 'invalid_response', message: 'The stream ended before the answer finished.' };
      return { protocol: check('protocol', 'verified', elapsed), streaming: failedCheck('streaming_inference', elapsed, failure), failure, ...(usage ? { usage } : {}) };
    }
    return {
      protocol: check('protocol', 'verified', elapsed),
      streaming: check('streaming_inference', 'verified', elapsed, undefined, usage ? undefined : 'The provider did not report token usage.'),
      ...(usage ? { usage } : {})
    };
  }

  private async checkToolCall(target: VerificationTarget, deadline: number): Promise<{ check: ModelVerificationCheck; usage?: ModelVerificationUsage }> {
    const { provider, secret, authMode } = target.credential;
    const started = this.now();
    const timeoutMs = this.remaining(deadline, TOOL_TIMEOUT_MS);
    if (timeoutMs < MIN_REQUEST_MS) return { check: this.budgetExhausted('tool_call') };
    const parameters = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false };
    const description = 'Report the status of this connection check.';
    const prompt = `Call ${TOOL_NAME} with status "ok".`;
    const body = target.apiMode === 'chat-completions'
      ? {
        model: target.model, messages: [{ role: 'user', content: prompt }], ...chatOutputCap(provider, target.upstreamUrl(), TOOL_MAX_OUTPUT_TOKENS), stream: false,
        tools: [{ type: 'function', function: { name: TOOL_NAME, description, parameters } }],
        tool_choice: { type: 'function', function: { name: TOOL_NAME } }
      }
      : {
        model: target.model, input: prompt, max_output_tokens: TOOL_MAX_OUTPUT_TOKENS, stream: false,
        tools: [{ type: 'function', name: TOOL_NAME, description, parameters }],
        tool_choice: { type: 'function', name: TOOL_NAME }
      };
    try {
      const response = await this.send(target, {
        url: target.upstreamUrl(), method: 'POST', headers: credentialHeaders(authMode, secret), body: JSON.stringify(body),
        timeoutMs, maxResponseBytes: INFERENCE_MAX_BYTES
      });
      const elapsed = this.now() - started;
      if (response.status < 200 || response.status >= 300) {
        const failure = classifyHttpFailure(provider, response.status, response.body, secret);
        if (isToolsUnsupported(failure, response.body)) {
          return { check: check('tool_call', 'limited', elapsed, { ...failure, category: 'unsupported_protocol', message: sanitizeMessage(`The model or provider does not accept tool calls: ${failure.message}`, secret) }) };
        }
        return { check: failedCheck('tool_call', elapsed, failure) };
      }
      const answer = calledTool(target.apiMode, response.body, TOOL_NAME);
      const usage = answer.usage;
      if (answer.called) return { check: check('tool_call', 'verified', elapsed), ...(usage ? { usage } : {}) };
      const failure: ClassifiedFailure = answer.parsed
        ? { category: 'unsupported_protocol', message: 'The model answered without calling the requested tool.' }
        : { category: 'invalid_response', message: 'The tool-call answer was not valid JSON.' };
      return { check: check('tool_call', answer.parsed ? 'limited' : 'failed', elapsed, failure), ...(usage ? { usage } : {}) };
    } catch (error) {
      return { check: failedCheck('tool_call', this.now() - started, classifyTransportFailure(error, secret)) };
    }
  }

  private modelAccess(
    target: VerificationTarget,
    authFailed: boolean,
    listing: ModelListing | undefined,
    inference: InferenceEvidence | undefined,
    toolCall: ModelVerificationCheck,
    secret: string
  ): ModelVerificationCheck {
    if (target.model === null) return notTested('model_access');
    if (authFailed) return notTested('model_access', 'skipped because authentication failed');
    const elapsed = 0;
    // A model that answered is reachable, whatever a listing says.
    if (inference?.protocol.outcome === 'verified' || toolCall.outcome === 'verified') return check('model_access', 'verified', elapsed);
    const failure = inference?.failure;
    if (failure && (failure.category === 'not_found' || failure.category === 'access')) return failedCheck('model_access', elapsed, failure);
    if (listing) {
      const wanted = normalizeModelId(target.model);
      if (listing.ids.has(wanted)) return check('model_access', 'verified', elapsed, undefined, 'listed by the provider');
      // A complete list is decisive only when no inference ran; an inference that
      // ran but proved nothing (rate limit, quota, timeout) leaves the answer open.
      if (listing.complete && !target.runInference) {
        return check('model_access', 'failed', elapsed, { category: 'not_found', message: sanitizeMessage(`The provider does not list the model ${target.model}.`, secret) });
      }
      if (listing.complete) {
        return check('model_access', 'limited', elapsed, {
          category: 'not_found',
          message: sanitizeMessage(`The provider does not list the model ${target.model}, and inference could not confirm it.`, secret)
        });
      }
      return check('model_access', 'limited', elapsed, { category: 'not_found', message: 'The model was not in the partial model list the provider returned.' });
    }
    return notTested('model_access');
  }

  private persist(principalId: string, target: VerificationTarget, result: ModelConnectionVerifyResult): void {
    const repository = this.options.repository;
    const resultJson = JSON.stringify(result);
    if (target.kind === 'profile') {
      repository.recordVerification(principalId, {
        targetKind: 'profile', targetId: target.profileId!, revisionId: target.revisionId!, credentialVersion: null,
        outcome: result.outcome, resultJson, checkedAt: result.checkedAt
      });
    }
    const keyOutcome = credentialOutcome(result.checks);
    if (keyOutcome === 'not_tested') return;
    const keyChecks = result.checks.filter((entry) => entry.name === 'authentication' || entry.errorCategory === 'auth');
    repository.recordVerification(principalId, {
      targetKind: 'credential', targetId: target.credential.id, revisionId: null, credentialVersion: target.credential.activeVersion,
      outcome: keyOutcome, resultJson: JSON.stringify({ outcome: keyOutcome, checkedAt: result.checkedAt, provider: result.provider, checks: keyChecks }),
      checkedAt: result.checkedAt
    });
  }
}

function parseListing(response: ProviderHttpResponse): ModelListing | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const document = parsed as Record<string, unknown>;
  const entries = Array.isArray(document.data) ? document.data : Array.isArray(document.models) ? document.models : undefined;
  if (!entries) return undefined;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : undefined;
    if (id) ids.add(normalizeModelId(id));
  }
  return { ids, complete: !response.truncated && document.has_more !== true };
}
