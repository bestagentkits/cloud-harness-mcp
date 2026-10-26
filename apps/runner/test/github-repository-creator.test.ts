import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubRepositoryCreateInputSchema, type GitHubRepositoryCreateInput, type RunnerConfig } from '@cloud-harness/contracts';
import type { createAppAuth } from '@octokit/auth-app';
import { GitHubRepositoryCreator } from '../src/github-repository-creator.js';
import { InMemoryGitHubInstallationStore, type VerifiedGitHubInstallation } from '../src/github-installation-store.js';
import { StateStore } from '../src/state-store.js';

const INSTALLATION_TOKEN = 'ghs_installationTokenSecretValue0123456789';
const APP_JWT = 'eyJhbGciOiJSUzI1NiJ9.app-jwt-secret.signature';
const githubApp = { appId: 123, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' } as NonNullable<RunnerConfig['githubApp']>;

type Handler = (init: RequestInit) => Response | Promise<Response>;

const directories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* ignore */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function installationPayload(overrides: { login?: string; type?: string; administration?: string; suspended?: boolean } = {}) {
  return {
    id: 456,
    app_id: 123,
    suspended_at: overrides.suspended ? '2026-01-01T00:00:00Z' : null,
    account: { id: 789, login: overrides.login ?? 'acme', type: overrides.type ?? 'Organization' },
    permissions: { contents: 'write', administration: overrides.administration ?? 'write' }
  };
}

function repositoryPayload(name: string, visibility: 'public' | 'private') {
  return { id: 987_654, full_name: `acme/${name}`, html_url: `https://github.com/acme/${name}`, visibility, private: visibility === 'private', default_branch: 'main' };
}

function verifiedInstallation(overrides: Partial<VerifiedGitHubInstallation> = {}): VerifiedGitHubInstallation {
  return {
    appId: 123, installationId: 456, accountId: 789, accountLogin: 'acme',
    issues: 'write', pullRequests: 'write', administration: 'write', accountType: 'Organization',
    status: 'active', repositories: [], ...overrides
  };
}

function fixture(options: {
  authMode?: 'owner-bearer' | 'cloudflare-access';
  githubApp?: RunnerConfig['githubApp'];
  githubToken?: string;
  handlers?: Record<string, Handler>;
  mintError?: { status: number };
  installations?: VerifiedGitHubInstallation[];
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ch-repo-create-'));
  directories.push(directory);
  const store = new StateStore(join(directory, 'state.db'));
  stores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'principal_1' });
  const installations = new InMemoryGitHubInstallationStore();
  for (const installation of options.installations ?? [verifiedInstallation()]) {
    installations.replaceVerified(ownerId, installation, Date.now());
  }
  const config = {
    authMode: options.authMode ?? 'cloudflare-access',
    githubApp: 'githubApp' in options ? options.githubApp : githubApp,
    ...(options.githubToken ? { githubToken: options.githubToken } : {})
  } as RunnerConfig;
  const handlers: Record<string, Handler> = {
    'GET /app/installations/456': () => Response.json(installationPayload()),
    'POST /orgs/acme/repos': (init) => {
      const body = JSON.parse(String(init.body)) as { name: string; visibility: 'public' | 'private' };
      return Response.json(repositoryPayload(body.name, body.visibility), { status: 201 });
    },
    ...options.handlers
  };
  const calls: { method: string; path: string; body?: unknown; authorization?: string }[] = [];
  const request = vi.fn(async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({
      method,
      path: url.pathname,
      ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      authorization: headers.get('authorization') ?? ''
    });
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return Response.json({ message: 'Not Found' }, { status: 404 });
    return await handler(init);
  }) as unknown as typeof fetch;
  const mints: unknown[] = [];
  const authFactory = vi.fn(() => async (parameters: { type: string; permissions?: unknown }) => {
    if (parameters.type === 'app') return { token: APP_JWT };
    mints.push(parameters);
    if (options.mintError) throw Object.assign(new Error('Unprocessable'), { status: options.mintError.status });
    return { token: INSTALLATION_TOKEN, permissions: { administration: 'write', metadata: 'read' } };
  }) as unknown as typeof createAppAuth;
  const audits: { principalId: string; subjectId: string; details: Record<string, string | number | boolean> }[] = [];
  const refreshInstallation = vi.fn(async () => undefined);
  const creator = new GitHubRepositoryCreator({
    config,
    installations,
    idempotency: store,
    audit: (principalId, subjectId, details) => { audits.push({ principalId, subjectId, details }); },
    refreshInstallation,
    request,
    authFactory
  });
  return { creator, ownerId, calls, mints, audits, installations, refreshInstallation, store };
}

function input(overrides: Partial<GitHubRepositoryCreateInput> = {}): GitHubRepositoryCreateInput {
  return GitHubRepositoryCreateInputSchema.parse({ owner: 'acme', name: 'service', visibility: 'public', idempotencyKey: 'create-service-1', ...overrides });
}

const posts = (calls: { method: string; path: string }[]) => calls.filter((call) => call.method === 'POST');

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(INSTALLATION_TOKEN);
  expect(text).not.toContain(APP_JWT);
}

describe('github_repository_create broker', () => {
  it('creates a public organization repository with an administration-scoped installation token', async () => {
    const { creator, ownerId, calls, mints, audits, refreshInstallation } = fixture();
    const result = await creator.create(ownerId, input({ description: 'Service', autoInit: true }));

    expect(result).toMatchObject({
      ok: true,
      data: { fullName: 'acme/service', repositoryId: 987_654, htmlUrl: 'https://github.com/acme/service', visibility: 'public', defaultBranch: 'main', created: true, replayed: false }
    });
    expect(posts(calls)).toEqual([expect.objectContaining({
      path: '/orgs/acme/repos',
      body: { name: 'service', visibility: 'public', description: 'Service', auto_init: true },
      authorization: `Bearer ${INSTALLATION_TOKEN}`
    })]);
    // The installation is verified with the App JWT before any token for the organization is minted.
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/app/installations/456', authorization: `Bearer ${APP_JWT}` });
    expect(mints).toEqual([{ type: 'installation', installationId: 456, permissions: { administration: 'write' } }]);
    expect(audits).toEqual([{
      principalId: ownerId,
      subjectId: '987654',
      details: expect.objectContaining({ owner: 'acme', name: 'service', fullName: 'acme/service', visibility: 'public', repositoryId: 987_654, success: true })
    }]);
    expect(refreshInstallation).toHaveBeenCalledWith(ownerId, '456');
    expectNoSecrets(result);
    expectNoSecrets(audits);
  });

  it('creates a private repository and reports private visibility', async () => {
    const { creator, ownerId, calls } = fixture();
    const result = await creator.create(ownerId, input({ name: 'internal-tool', visibility: 'private', idempotencyKey: 'create-private-1' }));
    expect(result).toMatchObject({ ok: true, data: { fullName: 'acme/internal-tool', visibility: 'private' } });
    expect(posts(calls)[0]?.body).toMatchObject({ visibility: 'private' });
  });

  it('refuses without administration:write and never mints a token or sends the create request', async () => {
    const { creator, ownerId, calls, mints, audits } = fixture({
      handlers: { 'GET /app/installations/456': () => Response.json(installationPayload({ administration: 'read' })) }
    });
    const result = await creator.create(ownerId, input());
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'GITHUB_PERMISSION_MISSING', retryable: false, operation: 'github_repository_create', repository: 'acme/service', requiredCapability: 'github.administration:write' }
    });
    expect(result.error?.message).toMatch(/Administration: Read and write/);
    expect(posts(calls)).toHaveLength(0);
    expect(mints).toHaveLength(0);
    expect(audits[0]?.details).toMatchObject({ success: false, errorCode: 'GITHUB_PERMISSION_MISSING' });
    expectNoSecrets(result);
  });

  it('maps a refused administration mint to a permission error without a create request', async () => {
    const { creator, ownerId, calls } = fixture({ mintError: { status: 422 } });
    const result = await creator.create(ownerId, input());
    expect(result.error?.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(posts(calls)).toHaveLength(0);
  });

  it('reports an existing repository name as a distinct error and never as success', async () => {
    const { creator, ownerId, calls } = fixture({
      handlers: {
        'POST /orgs/acme/repos': () => Response.json({ message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }, { status: 422 })
      }
    });
    const result = await creator.create(ownerId, input());
    expect(result).toMatchObject({ ok: false, error: { code: 'GITHUB_REPOSITORY_EXISTS', retryable: false } });
    expect(result.data).toBeUndefined();
    // A refusal is not recorded, so the same key may be retried later.
    const retry = await creator.create(ownerId, input());
    expect(retry.error?.code).toBe('GITHUB_REPOSITORY_EXISTS');
    expect(posts(calls)).toHaveLength(2);
  });

  it('replays an identical request from the recorded outcome with a single GitHub create call', async () => {
    const { creator, ownerId, calls, mints } = fixture();
    const first = await creator.create(ownerId, input());
    const second = await creator.create(ownerId, input({ owner: 'ACME' }));
    expect(first.data).toMatchObject({ created: true, replayed: false });
    expect(second).toMatchObject({ ok: true, data: { fullName: 'acme/service', repositoryId: 987_654, created: false, replayed: true } });
    expect(posts(calls)).toHaveLength(1);
    expect(mints).toHaveLength(1);
  });

  it('serializes concurrent calls that share a key so only one create request is sent', async () => {
    const { creator, ownerId, calls } = fixture();
    const [left, right] = await Promise.all([creator.create(ownerId, input()), creator.create(ownerId, input())]);
    expect([left.ok, right.ok]).toEqual([true, true]);
    expect([left.data, right.data]).toEqual(expect.arrayContaining([
      expect.objectContaining({ created: true }), expect.objectContaining({ replayed: true })
    ]));
    expect(posts(calls)).toHaveLength(1);
  });

  it('rejects a reused key with different input as an idempotency conflict', async () => {
    const { creator, ownerId, calls } = fixture();
    await creator.create(ownerId, input());
    const conflict = await creator.create(ownerId, input({ visibility: 'private' }));
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(posts(calls)).toHaveLength(1);
  });

  it('refuses a personal user account with an actionable unsupported error', async () => {
    const { creator, ownerId, calls, mints } = fixture({
      installations: [verifiedInstallation({ accountLogin: 'octocat', accountType: 'User' })],
      handlers: { 'GET /app/installations/456': () => Response.json(installationPayload({ login: 'octocat', type: 'User' })) }
    });
    const result = await creator.create(ownerId, input({ owner: 'octocat' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED', retryable: false } });
    expect(result.error?.message).toMatch(/personal GitHub account/);
    expect(posts(calls)).toHaveLength(0);
    expect(mints).toHaveLength(0);
  });

  it('reports a missing installation for the organization without contacting GitHub', async () => {
    const { creator, ownerId, calls } = fixture();
    const result = await creator.create(ownerId, input({ owner: 'other-org' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(result.error?.message).toMatch(/Install the GitHub App on the organization/);
    expect(calls).toHaveLength(0);
  });

  it('reports a removed installation as not found', async () => {
    const { creator, ownerId, calls } = fixture({ handlers: { 'GET /app/installations/456': () => Response.json({ message: 'Not Found' }, { status: 404 }) } });
    const result = await creator.create(ownerId, input());
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(posts(calls)).toHaveLength(0);
  });

  it('distinguishes a rate limit and lets the same key retry afterwards', async () => {
    let limited = true;
    const resetAt = Math.floor(Date.now() / 1_000) + 30;
    const { creator, ownerId, calls } = fixture({
      handlers: {
        'POST /orgs/acme/repos': (init) => {
          if (limited) {
            limited = false;
            return Response.json({ message: 'API rate limit exceeded for installation.' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) } });
          }
          const body = JSON.parse(String(init.body)) as { name: string };
          return Response.json(repositoryPayload(body.name, 'public'), { status: 201 });
        }
      }
    });
    const first = await creator.create(ownerId, input());
    expect(first).toMatchObject({ ok: false, error: { code: 'GITHUB_RATE_LIMITED', retryable: true } });
    expect(first.error?.retryAfterMs).toBeGreaterThan(0);
    const retry = await creator.create(ownerId, input());
    expect(retry).toMatchObject({ ok: true, data: { created: true } });
    expect(posts(calls)).toHaveLength(2);
  });

  it('maps a secondary rate limit with retry-after', async () => {
    const { creator, ownerId } = fixture({
      handlers: { 'POST /orgs/acme/repos': () => Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403, headers: { 'retry-after': '45' } }) }
    });
    const result = await creator.create(ownerId, input());
    expect(result.error).toMatchObject({ code: 'GITHUB_RATE_LIMITED', retryAfterMs: 45_000 });
  });

  it('maps an organization policy refusal to a permission error with remediation', async () => {
    const { creator, ownerId } = fixture({
      handlers: { 'POST /orgs/acme/repos': () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }) }
    });
    const result = await creator.create(ownerId, input());
    expect(result.error).toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', requiredCapability: 'github.administration:write' });
    expect(result.error?.message).not.toMatch(/GH_TOKEN/);
  });

  it('keeps an interrupted create pending and refuses to call a later existing name a plain conflict', async () => {
    let attempt = 0;
    const { creator, ownerId, store } = fixture({
      handlers: {
        'POST /orgs/acme/repos': () => {
          attempt += 1;
          if (attempt === 1) throw new TypeError('socket hang up');
          return Response.json({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, { status: 422 });
        }
      }
    });
    const first = await creator.create(ownerId, input());
    expect(first).toMatchObject({ ok: false, error: { code: 'UNKNOWN_REMOTE_STATE', retryable: true } });
    expect(store.getRepositoryCreateIdempotency(ownerId, 'create-service-1')?.status).toBe('PENDING');
    const retry = await creator.create(ownerId, input());
    expect(retry.error?.code).toBe('UNKNOWN_REMOTE_STATE');
    expect(retry.error?.message).toMatch(/never deletes/);
    // The marker survives the report, so later replays and a changed payload stay guarded.
    expect(store.getRepositoryCreateIdempotency(ownerId, 'create-service-1')?.status).toBe('PENDING');
    expect((await creator.create(ownerId, input())).error?.code).toBe('UNKNOWN_REMOTE_STATE');
    expect((await creator.create(ownerId, input({ visibility: 'private' }))).error?.code).toBe('CONFLICT');
  });

  it('treats a GitHub 5xx on the create request as an unknown outcome and keeps the key pending', async () => {
    let attempt = 0;
    const { creator, ownerId, store } = fixture({
      handlers: {
        'POST /orgs/acme/repos': () => {
          attempt += 1;
          if (attempt === 1) return new Response('bad gateway', { status: 502 });
          return Response.json({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, { status: 422 });
        }
      }
    });
    const first = await creator.create(ownerId, input());
    expect(first).toMatchObject({ ok: false, error: { code: 'UNKNOWN_REMOTE_STATE', retryable: true } });
    expect(store.getRepositoryCreateIdempotency(ownerId, 'create-service-1')?.status).toBe('PENDING');
    const retry = await creator.create(ownerId, input());
    expect(retry.error?.code).toBe('UNKNOWN_REMOTE_STATE');
  });

  it('uses the configured installation in owner-bearer mode only after proving it belongs to the organization', async () => {
    const owned = fixture({ authMode: 'owner-bearer', githubApp: { ...githubApp, installationId: 456 }, installations: [] });
    expect((await owned.creator.create(owned.ownerId, input())).ok).toBe(true);

    const foreign = fixture({ authMode: 'owner-bearer', githubApp: { ...githubApp, installationId: 456 }, installations: [] });
    const result = await foreign.creator.create(foreign.ownerId, input({ owner: 'another-org' }));
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(posts(foreign.calls)).toHaveLength(0);
  });

  it('never uses the operator-configured installation in cloudflare-access mode', async () => {
    const { creator, ownerId, calls } = fixture({ githubApp: { ...githubApp, installationId: 456 }, installations: [] });
    const result = await creator.create(ownerId, input());
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('never falls back to an operator GH_TOKEN when no GitHub App is configured', async () => {
    const { creator, ownerId, calls } = fixture({ authMode: 'owner-bearer', githubApp: undefined, githubToken: 'ghp_operatorWideFallbackToken0123456789' });
    const result = await creator.create(ownerId, input());
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('ghp_operatorWideFallbackToken');
    expect(creator.capability(ownerId)).toMatchObject({ available: false, organizations: [] });
  });
});

describe('github_repository_create capability discovery', () => {
  it('lists organizations whose verified installation grants administration:write', () => {
    const { creator, ownerId } = fixture({
      installations: [
        verifiedInstallation(),
        verifiedInstallation({ installationId: 457, accountId: 790, accountLogin: 'readonly-org', administration: 'read' }),
        verifiedInstallation({ installationId: 458, accountId: 791, accountLogin: 'octocat', accountType: 'User' }),
        verifiedInstallation({ installationId: 459, accountId: 792, accountLogin: 'legacy-org', administration: undefined, accountType: undefined })
      ]
    });
    const capability = creator.capability(ownerId);
    expect(capability).toMatchObject({ tool: 'github_repository_create', available: true, personalAccounts: false, requiredPermission: 'administration:write' });
    expect(capability.organizations).toEqual([
      { login: 'acme', administration: 'write', available: true },
      { login: 'readonly-org', administration: 'read', available: false, reason: 'installation does not grant Administration: write' },
      expect.objectContaining({ login: 'legacy-org', administration: null, available: false })
    ]);
  });

  it('reports unavailability with a reason when no organization grants the permission', () => {
    const { creator, ownerId } = fixture({ installations: [verifiedInstallation({ administration: 'none' })] });
    expect(creator.capability(ownerId)).toMatchObject({
      available: false,
      organizations: [{ login: 'acme', administration: 'none', available: false }],
      reason: 'No connected organization installation grants Administration: write.'
    });
  });
});
