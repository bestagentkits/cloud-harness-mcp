import { createHash } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { request as octokitRequest } from '@octokit/request';
import {
  GitHubRepositoryCreateResultSchema,
  type ErrorCode,
  type GitHubRepositoryCreateCapability,
  type GitHubRepositoryCreateInput,
  type GitHubRepositoryCreateOrganization,
  type GitHubRepositoryCreateResult,
  type RunnerConfig,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { classifyGitHubFailure } from './github-error-classifier.js';
import type { GitHubInstallationRecord, GitHubInstallationStore } from './github-installation-store.js';
import type { RepositoryCreateIdempotencyRecord } from './state-store.js';

const OPERATION = 'github_repository_create';
const REQUIRED_CAPABILITY = 'github.administration:write';
const GITHUB_API = 'https://api.github.com';
const MAX_DETAIL_CHARS = 500;
const PERMISSION_REMEDY = 'Grant the GitHub App the repository permission "Administration: Read and write", then approve the permission change on the organization installation (Organization settings > GitHub Apps). Also confirm the organization policy allows repository creation.';

/** The runner's persisted idempotency outcomes for repository creation. */
export interface RepositoryCreateIdempotencyStore {
  getRepositoryCreateIdempotency(ownerId: string, key: string): RepositoryCreateIdempotencyRecord | undefined;
  reserveRepositoryCreateIdempotency(ownerId: string, key: string, fingerprint: string): void;
  completeRepositoryCreateIdempotency(ownerId: string, key: string, fingerprint: string, resultJson: string): void;
  releaseRepositoryCreateIdempotency(ownerId: string, key: string, fingerprint: string): void;
}

export type RepositoryCreateAudit = (
  principalId: string,
  subjectId: string,
  details: Record<string, string | number | boolean>
) => void;

export type GitHubRepositoryCreatorOptions = {
  config: RunnerConfig;
  installations?: GitHubInstallationStore | undefined;
  idempotency: RepositoryCreateIdempotencyStore;
  audit: RepositoryCreateAudit;
  /**
   * Re-verifies a stored installation after the live check, so discovery reflects the permission
   * GitHub reported and the new repository's grant becomes visible to workspace_open. Best-effort.
   */
  refreshInstallation?: ((principalId: string, installationId: string) => Promise<void>) | undefined;
  request?: typeof fetch;
  authFactory?: typeof createAppAuth;
  timeoutMs?: number;
};

type InstallationPayload = {
  id?: number;
  app_id?: number;
  suspended_at?: string | null;
  account?: { login?: string; type?: string };
  permissions?: Record<string, string | undefined>;
};

type RepositoryPayload = {
  id?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  visibility?: unknown;
  private?: unknown;
  default_branch?: unknown;
};

type GitHubErrorPayload = { message?: unknown; errors?: unknown };

/** A definitive refusal or an unknown outcome, reported as a structured tool result. */
class CreateFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    /** True when GitHub may have created the repository even though no result was recorded. */
    readonly outcomeUnknown = false
  ) {
    super(message);
  }
}

/**
 * Creates organization-owned repositories through the principal's GitHub App installation for
 * that organization. The App installation token is minted only after the installation is verified
 * live to belong to the organization and to grant `administration: write`; it never leaves this
 * module and never appears in results, errors, or audit records. No operator-wide fallback
 * credential is ever used.
 */
export class GitHubRepositoryCreator {
  readonly #request: typeof fetch;
  readonly #authFactory: typeof createAppAuth;
  readonly #timeoutMs: number;
  /** Serializes calls that share an idempotency key, so concurrent replays cannot double-create. */
  readonly #keyLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: GitHubRepositoryCreatorOptions) {
    this.#request = options.request ?? fetch;
    this.#authFactory = options.authFactory ?? createAppAuth;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Principal-level availability from verified installation records; never mints a token. */
  capability(principalId: string): GitHubRepositoryCreateCapability {
    const base = { tool: OPERATION, personalAccounts: false, requiredPermission: 'administration:write' } as const;
    const githubApp = this.options.config.githubApp;
    if (!githubApp) {
      return { ...base, available: false, organizations: [], reason: 'No GitHub App is configured on this harness; repository creation requires one.' };
    }
    const records = (this.options.installations?.listInstallations(principalId) ?? [])
      .filter((record) => record.appId === String(githubApp.appId) && record.status !== 'uninstalled');
    const organizations = records
      .filter((record) => record.accountType !== 'User')
      .slice(0, 100)
      .map(organizationAvailability);
    const available = organizations.some((organization) => organization.available);
    if (available) return { ...base, available, organizations };
    const authMode = this.options.config.authMode ?? 'owner-bearer';
    const configuredUnverified = authMode !== 'cloudflare-access'
      && githubApp.installationId !== undefined
      && !records.some((record) => record.installationId === String(githubApp.installationId));
    const reason = configuredUnverified
      ? 'The configured GitHub App installation has not been verified by the runner yet; github_repository_create verifies it live on use.'
      : organizations.length === 0
        ? 'No GitHub App installation on an organization is connected for this principal.'
        : 'No connected organization installation grants Administration: write.';
    return { ...base, available, organizations, reason };
  }

  async create(principalId: string, input: GitHubRepositoryCreateInput, signal?: AbortSignal): Promise<RunnerResponse> {
    const lockKey = `${principalId}\0${input.idempotencyKey}`;
    const previous = this.#keyLocks.get(lockKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => await this.createUnlocked(principalId, input, signal));
    this.#keyLocks.set(lockKey, run);
    try {
      return await run;
    } finally {
      if (this.#keyLocks.get(lockKey) === run) this.#keyLocks.delete(lockKey);
    }
  }

  private async createUnlocked(principalId: string, input: GitHubRepositoryCreateInput, signal?: AbortSignal): Promise<RunnerResponse> {
    const fingerprint = requestFingerprint(input);
    const key = input.idempotencyKey;
    const prior = this.options.idempotency.getRepositoryCreateIdempotency(principalId, key);
    if (prior && prior.fingerprint !== fingerprint) {
      return failureResponse(input, new CreateFailure('CONFLICT', 'idempotency key reused with different request payload'));
    }
    if (prior?.status === 'SUCCEEDED' && prior.resultJson) {
      const recorded = GitHubRepositoryCreateResultSchema.parse(JSON.parse(prior.resultJson));
      const replay: GitHubRepositoryCreateResult = { ...recorded, created: false, replayed: true };
      return { ok: true, message: `Repository ${replay.fullName} was already created with this idempotencyKey`, data: replay, truncated: false };
    }
    // A PENDING record left by an earlier attempt means GitHub may already hold the repository.
    const earlierAttemptUnresolved = prior?.status === 'PENDING';

    let installationId: string | undefined;
    try {
      installationId = await this.verifiedInstallation(principalId, input.owner, signal);
      const token = await this.mintAdministrationToken(installationId);
      this.options.idempotency.reserveRepositoryCreateIdempotency(principalId, key, fingerprint);
      let result: GitHubRepositoryCreateResult;
      try {
        result = await this.postRepository(token, input, signal);
      } catch (error) {
        if (error instanceof CreateFailure && !error.outcomeUnknown) {
          this.options.idempotency.releaseRepositoryCreateIdempotency(principalId, key, fingerprint);
          if (error.code === 'GITHUB_REPOSITORY_EXISTS' && earlierAttemptUnresolved) {
            throw new CreateFailure('UNKNOWN_REMOTE_STATE', `Repository ${input.owner}/${input.name} exists, and an earlier attempt with this idempotencyKey did not record its outcome, so the harness cannot tell whether that attempt created it. Inspect the repository before using it; the harness never deletes it.`);
          }
        }
        throw error;
      }
      this.options.idempotency.completeRepositoryCreateIdempotency(principalId, key, fingerprint, JSON.stringify(result));
      this.options.audit(principalId, String(result.repositoryId), {
        owner: input.owner,
        name: input.name,
        fullName: result.fullName,
        visibility: result.visibility,
        repositoryId: result.repositoryId,
        installationId,
        idempotencyKey: key,
        success: true
      });
      await this.refresh(principalId, installationId);
      return { ok: true, message: `Repository ${result.fullName} created`, data: result, truncated: false };
    } catch (error) {
      const failure = error instanceof CreateFailure
        ? error
        : new CreateFailure('INTERNAL_ERROR', 'repository creation failed unexpectedly');
      this.options.audit(principalId, `${input.owner}/${input.name}`, {
        owner: input.owner,
        name: input.name,
        visibility: input.visibility,
        idempotencyKey: key,
        success: false,
        errorCode: failure.code,
        ...(installationId ? { installationId } : {})
      });
      if (installationId && (failure.code === 'GITHUB_PERMISSION_MISSING' || failure.code === 'NOT_SUPPORTED')) {
        await this.refresh(principalId, installationId);
      }
      if (!(error instanceof CreateFailure)) throw error;
      return failureResponse(input, failure);
    }
  }

  private async refresh(principalId: string, installationId: string): Promise<void> {
    if (!this.options.refreshInstallation) return;
    if (!this.options.installations?.getInstallation(principalId, installationId)) return;
    try {
      await this.options.refreshInstallation(principalId, installationId);
    } catch { /* discovery refresh is best-effort; the live check already decided */ }
  }

  /** The principal's installation for the organization, verified live against GitHub. */
  private async verifiedInstallation(principalId: string, owner: string, signal?: AbortSignal): Promise<string> {
    const githubApp = this.options.config.githubApp;
    if (!githubApp) {
      throw new CreateFailure('NOT_SUPPORTED', 'No GitHub App is configured on this harness; repository creation requires a GitHub App installed on the organization.');
    }
    const installationId = this.resolveInstallationId(principalId, owner);
    const jwt = await this.appJwt(installationId);
    const response = await this.github(`/app/installations/${encodeURIComponent(installationId)}`, { method: 'GET', token: jwt, signal });
    if (response.status === 404) {
      throw new CreateFailure('NOT_FOUND', `The GitHub App installation for ${owner} no longer exists. Install the App on the organization and connect it again.`);
    }
    if (!response.ok) throw await httpFailure(response, 'verify the organization installation');
    const installation = await response.json() as InstallationPayload;
    if (String(installation.app_id) !== String(githubApp.appId) || !installation.account?.login) {
      throw new CreateFailure('NOT_FOUND', `No GitHub App installation for organization ${owner} is available to this principal.`);
    }
    if (installation.account.login.toLowerCase() !== owner.toLowerCase()) {
      throw new CreateFailure('NOT_FOUND', `No GitHub App installation for organization ${owner} is available to this principal.`);
    }
    if (installation.account.type !== 'Organization') {
      throw new CreateFailure('NOT_SUPPORTED', `${owner} is a personal GitHub account. github_repository_create creates organization-owned repositories only: GitHub App installation tokens cannot create repositories for a user account. Create it in an organization where the App is installed, or create it on github.com and then call workspace_open.`);
    }
    if (installation.suspended_at) {
      throw new CreateFailure('FORBIDDEN', `The GitHub App installation on ${owner} is suspended. An organization owner must unsuspend it.`);
    }
    if (installation.permissions?.administration !== 'write') {
      throw new CreateFailure('GITHUB_PERMISSION_MISSING', `The GitHub App installation on ${owner} does not grant Administration: write, which GitHub requires to create repositories. Write access to existing repositories does not count. ${PERMISSION_REMEDY}`);
    }
    return installationId;
  }

  private resolveInstallationId(principalId: string, owner: string): string {
    const githubApp = this.options.config.githubApp!;
    const login = owner.toLowerCase();
    const matching = (this.options.installations?.listInstallations(principalId) ?? []).filter((record) =>
      record.appId === String(githubApp.appId) && record.accountLogin.toLowerCase() === login && record.status !== 'uninstalled');
    const active = matching.find((record) => record.status === 'active') ?? matching[0];
    if (active) return active.installationId;
    // owner-bearer mode serves one owner through the operator-configured installation; the live
    // check still proves it belongs to the requested organization. cloudflare-access never uses it.
    if ((this.options.config.authMode ?? 'owner-bearer') !== 'cloudflare-access' && githubApp.installationId !== undefined) {
      return String(githubApp.installationId);
    }
    throw new CreateFailure('NOT_FOUND', `No GitHub App installation for organization ${owner} is connected for this principal. Install the GitHub App on the organization and connect the installation from the dashboard GitHub page.`);
  }

  private auth(installationId: string) {
    const githubApp = this.options.config.githubApp!;
    const request = octokitRequest.defaults({ request: { fetch: this.#request } });
    return this.#authFactory({ appId: githubApp.appId, privateKey: githubApp.privateKey, installationId: Number(installationId), request });
  }

  private async appJwt(installationId: string): Promise<string> {
    try {
      return (await this.auth(installationId)({ type: 'app' })).token;
    } catch {
      throw new CreateFailure('UNAVAILABLE', 'GitHub App authentication failed', true);
    }
  }

  /** An installation token narrowed to `administration: write`, with no repository restriction. */
  private async mintAdministrationToken(installationId: string): Promise<string> {
    let authentication: { token: string; permissions?: Record<string, string> };
    try {
      authentication = await this.auth(installationId)({ type: 'installation', installationId: Number(installationId), permissions: { administration: 'write' } });
    } catch (error) {
      if (errorStatus(error) === 422) {
        throw new CreateFailure('GITHUB_PERMISSION_MISSING', `The GitHub App installation cannot grant Administration: write. ${PERMISSION_REMEDY}`);
      }
      throw new CreateFailure('UNAVAILABLE', 'GitHub App could not mint an installation token with Administration: write', true);
    }
    if (authentication.permissions && authentication.permissions.administration !== 'write') {
      throw new CreateFailure('GITHUB_PERMISSION_MISSING', `The minted GitHub App token does not carry Administration: write. ${PERMISSION_REMEDY}`);
    }
    return authentication.token;
  }

  private async postRepository(token: string, input: GitHubRepositoryCreateInput, signal?: AbortSignal): Promise<GitHubRepositoryCreateResult> {
    const body: Record<string, string | boolean> = { name: input.name, visibility: input.visibility };
    if (input.description !== undefined) body.description = input.description;
    if (input.autoInit !== undefined) body.auto_init = input.autoInit;
    if (input.gitignoreTemplate !== undefined) body.gitignore_template = input.gitignoreTemplate;
    if (input.licenseTemplate !== undefined) body.license_template = input.licenseTemplate;
    let response: Response;
    try {
      response = await this.github(`/orgs/${encodeURIComponent(input.owner)}/repos`, { method: 'POST', token, body, signal, rethrow: true });
    } catch {
      // The request may have reached GitHub; the PENDING record makes a retry with the same key report it.
      throw new CreateFailure('UNKNOWN_REMOTE_STATE', `The create request for ${input.owner}/${input.name} did not complete, so GitHub may or may not have created the repository. Retry with the same idempotencyKey.`, true, undefined, true);
    }
    if (response.status === 201) {
      const payload = await response.json().catch(() => undefined) as RepositoryPayload | undefined;
      const result = repositoryResult(payload);
      if (!result) {
        throw new CreateFailure('UNKNOWN_REMOTE_STATE', `GitHub accepted the create request for ${input.owner}/${input.name} but returned an unreadable repository record. Inspect the repository before retrying.`, false, undefined, true);
      }
      return result;
    }
    if (response.status === 422) {
      const payload = await response.json().catch(() => undefined) as GitHubErrorPayload | undefined;
      const detail = errorDetail(payload);
      if (/already exists/i.test(detail)) {
        throw new CreateFailure('GITHUB_REPOSITORY_EXISTS', `Repository ${input.owner}/${input.name} already exists. Choose another name, or open the existing repository with workspace_open.`);
      }
      throw new CreateFailure('INVALID_INPUT', `GitHub refused the repository settings: ${detail}`.slice(0, 2_000));
    }
    if (response.status === 404) {
      throw new CreateFailure('NOT_FOUND', `Organization ${input.owner} was not found or is not visible to the GitHub App installation.`);
    }
    throw await httpFailure(response, 'create the repository');
  }

  private async github(path: string, init: {
    method: 'GET' | 'POST';
    token: string;
    body?: Record<string, unknown>;
    signal?: AbortSignal | undefined;
    rethrow?: boolean;
  }): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    try {
      return await this.#request(new URL(path, GITHUB_API), {
        method: init.method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${init.token}`,
          'x-github-api-version': '2022-11-28',
          ...(init.body ? { 'content-type': 'application/json' } : {})
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      });
    } catch (error) {
      if (init.rethrow) throw error;
      throw new CreateFailure('UNAVAILABLE', 'GitHub could not be reached', true);
    }
  }
}

function organizationAvailability(record: GitHubInstallationRecord): GitHubRepositoryCreateOrganization {
  const administration = record.administration ?? null;
  const base = { login: record.accountLogin, administration };
  if (record.status !== 'active') return { ...base, available: false, reason: `installation is ${record.status}` };
  if (administration === null || record.accountType === undefined) {
    return { ...base, available: false, reason: 'installation permissions not verified yet; refresh the installation from the dashboard GitHub page, or call github_repository_create, which verifies live' };
  }
  if (administration !== 'write') return { ...base, available: false, reason: 'installation does not grant Administration: write' };
  return { ...base, available: true };
}

/** Normalized request identity: logins are case-insensitive, absent options are explicit. */
function requestFingerprint(input: GitHubRepositoryCreateInput): string {
  return createHash('sha256').update(JSON.stringify({
    operation: OPERATION,
    owner: input.owner.toLowerCase(),
    name: input.name,
    visibility: input.visibility,
    description: input.description ?? null,
    autoInit: input.autoInit ?? null,
    gitignoreTemplate: input.gitignoreTemplate ?? null,
    licenseTemplate: input.licenseTemplate ?? null
  })).digest('hex');
}

function repositoryResult(payload: RepositoryPayload | undefined): GitHubRepositoryCreateResult | undefined {
  if (!payload) return undefined;
  const visibility = payload.visibility === 'public' || payload.visibility === 'private'
    ? payload.visibility
    : typeof payload.private === 'boolean' ? (payload.private ? 'private' : 'public') : undefined;
  const parsed = GitHubRepositoryCreateResultSchema.safeParse({
    fullName: payload.full_name,
    repositoryId: payload.id,
    htmlUrl: payload.html_url,
    visibility,
    defaultBranch: payload.default_branch,
    created: true,
    replayed: false
  });
  return parsed.success ? parsed.data : undefined;
}

function errorDetail(payload: GitHubErrorPayload | undefined): string {
  if (!payload) return 'no detail';
  const parts: string[] = [];
  if (typeof payload.message === 'string') parts.push(payload.message);
  if (Array.isArray(payload.errors)) {
    for (const item of payload.errors) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && 'message' in item && typeof item.message === 'string') parts.push(item.message);
    }
  }
  return (parts.join('; ') || 'no detail').slice(0, MAX_DETAIL_CHARS);
}

function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1_000;
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1_000 - now);
  return undefined;
}

/** Maps a non-success GitHub response through the shared classifier, keeping rate limits distinct. */
async function httpFailure(response: Response, step: string): Promise<CreateFailure> {
  const payload = await response.json().catch(() => undefined) as GitHubErrorPayload | undefined;
  const detail = errorDetail(payload);
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null;
  if (response.status === 429 || ((response.status === 403 || response.status === 429) && exhausted)) {
    const wait = retryAfterMs(response);
    return new CreateFailure('GITHUB_RATE_LIMITED', `GitHub rate limit reached while trying to ${step}: ${detail}`, true, wait ?? 60_000);
  }
  const classified = classifyGitHubFailure(`HTTP ${response.status}: ${detail}`, '', OPERATION);
  if (classified.code === 'GITHUB_PERMISSION_MISSING') {
    return new CreateFailure('GITHUB_PERMISSION_MISSING', `GitHub refused to ${step} (HTTP ${response.status}: ${detail}). ${PERMISSION_REMEDY}`);
  }
  if (classified.code === 'GITHUB_RATE_LIMITED') {
    return new CreateFailure('GITHUB_RATE_LIMITED', `GitHub rate limit reached while trying to ${step}: ${detail}`, true, classified.retryAfterMs);
  }
  return new CreateFailure(classified.code, `GitHub could not ${step} (HTTP ${response.status}): ${detail}`, classified.retryable, classified.retryAfterMs);
}

function failureResponse(input: GitHubRepositoryCreateInput, failure: CreateFailure): RunnerResponse {
  const message = failure.message.slice(0, 2_000);
  return {
    ok: false,
    message,
    error: {
      code: failure.code,
      message,
      retryable: failure.retryable,
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: Math.max(0, Math.round(failure.retryAfterMs)) } : {}),
      operation: OPERATION,
      repository: `${input.owner}/${input.name}`,
      ...(failure.code === 'GITHUB_PERMISSION_MISSING' ? { requiredCapability: REQUIRED_CAPABILITY } : {})
    },
    truncated: false
  };
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('status' in error && typeof error.status === 'number') return error.status;
  if ('response' in error && typeof error.response === 'object' && error.response !== null
    && 'status' in error.response && typeof error.response.status === 'number') return error.response.status;
  return undefined;
}
