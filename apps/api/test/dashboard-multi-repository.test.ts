import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig, RunnerPrincipalSelector, RunnerResponse } from '@cloud-harness/contracts';
import { buildRepositoryExplorerProjection, mapDashboardData } from '../src/dashboard-response.js';
import { createDashboardRouter } from '../src/dashboard-router.js';
import type { DashboardRunnerClient } from '../src/dashboard-types.js';
import {
  filesHref, renderFile, renderFileList, renderRepositoryExplorer, renderRepositoryRequired, renderRepositorySelector,
  renderTerminalPanel, renderWorkspaceDetail, renderWorkspaceIndex, renderWorkspaceTabs, selectedRepository
} from '../dashboard/dashboard-render.js';
import { inRepository, submitPatchEdit, withRepository } from '../dashboard/dashboard.js';
import { createTerminalSession } from '../dashboard/dashboard-terminal.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const apiId = `repo_${'a'.repeat(32)}`;
const webId = `repo_${'b'.repeat(32)}`;
const repositories = [
  { repositoryId: apiId, alias: 'api', repositoryUrl: 'https://github.com/acme/api.git', ref: null, access: 'read-write', primary: true, path: 'repos/api' },
  { repositoryId: webId, alias: 'web', repositoryUrl: 'https://github.com/acme/web.git', ref: 'develop', access: 'read-only', primary: false, path: 'repos/web', internal: 'dropped' }
];
const workspace = {
  workspaceId, repositoryUrl: 'https://github.com/acme/api.git', status: 'ACTIVE', networkProfile: 'network-none',
  createdAt: '2026-10-17T00:00:00.000Z', lastActivityAt: '2026-10-17T00:00:00.000Z', expiresAt: '2026-10-17T02:00:00.000Z'
};

describe('multi-repository workspaces in the dashboard', () => {
  it('projects the repository registry with only its public fields', () => {
    const { workspaces } = mapDashboardData('workspace_list', { workspaces: [{ ...workspace, repositories }] }) as { workspaces: Array<{ repositories: Record<string, unknown>[] }> };
    expect(workspaces[0]!.repositories).toHaveLength(2);
    expect(workspaces[0]!.repositories[1]).not.toHaveProperty('internal');
    expect(workspaces[0]!.repositories[1]).toMatchObject({ alias: 'web', access: 'read-only', path: 'repos/web' });
    const single = mapDashboardData('workspace_status', workspace);
    expect(single).not.toHaveProperty('repositories');
  });

  it('shows the repository count, aliases, and access in the index and detail', () => {
    const index = renderWorkspaceIndex([{ ...workspace, repositories }], { q: 'web', status: '' });
    expect(index).toContain('acme/api');
    expect(index).toContain('2 repositories');
    const detail = renderWorkspaceDetail({ ...workspace, repositories });
    expect(detail).toContain('Repositories');
    expect(detail).toContain('repos/web');
    expect(detail).toContain('Read-only');
    expect(detail).toContain('@ develop');
  });

  it('keeps the single-repository rendering unchanged', () => {
    expect(renderWorkspaceIndex([workspace], { q: '', status: '' })).not.toContain('repositories</span>');
    expect(renderWorkspaceDetail(workspace)).not.toContain('<dt>Repositories</dt>');
  });
});

describe('repository explorer projection', () => {
  const statusData = {
    workspaceId, multiRepository: true, ownerId: 'internal-owner',
    repositories: [
      { ...repositories[0], branch: 'main...origin/main [ahead 2, behind 1]', hasUncommitted: true, status: '## main...origin/main [ahead 2, behind 1]\n M src/index.ts\n?? notes.md', checkoutPath: '/host/jobs/private/repos/api' },
      { ...repositories[1], error: 'fatal: /host/jobs/private/repos/web is not a git repository' }
    ]
  };

  it('derives branch, dirty, unpushed and behind from the status tracking line', () => {
    const mapped = mapDashboardData('workspace_repo_status', statusData) as { multiRepository: boolean; repositories: Record<string, unknown>[] };
    expect(mapped.multiRepository).toBe(true);
    expect(mapped.repositories[0]).toEqual({
      ...repositories[0], branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, dirty: true, changedFiles: 2
    });
  });

  it('reports an unreadable checkout without forwarding raw worker or host text', () => {
    const mapped = mapDashboardData('workspace_repo_status', statusData) as { repositories: Record<string, unknown>[] };
    expect(mapped.repositories[1]).toEqual({ ...repositories[1], internal: undefined, statusError: true });
    const text = JSON.stringify(mapped);
    for (const leaked of ['fatal:', '/host/jobs', 'internal-owner', 'checkoutPath', 'dropped']) expect(text).not.toContain(leaked);
  });

  it('treats a branch without an upstream as having no upstream rather than nothing unpushed', () => {
    const mapped = mapDashboardData('workspace_repo_status', { multiRepository: true, repositories: [{ ...repositories[0], branch: 'feature/x', hasUncommitted: false, status: '## feature/x' }] }) as { repositories: Record<string, unknown>[] };
    expect(mapped.repositories[0]).toMatchObject({ branch: 'feature/x', ahead: 0, dirty: false, changedFiles: 0 });
    expect(mapped.repositories[0]).not.toHaveProperty('upstream');
  });

  it('joins the registry with the status by repository id and states whether status was read', () => {
    const registry = mapDashboardData('workspace_repos_list', { workspaceId, multiRepository: true, repositories });
    const joined = buildRepositoryExplorerProjection(registry, mapDashboardData('workspace_repo_status', statusData)) as { repositories: Record<string, unknown>[]; statusAvailable: boolean };
    expect(joined.statusAvailable).toBe(true);
    expect(joined.repositories.map((entry) => entry.alias)).toEqual(['api', 'web']);
    expect(joined.repositories[0]).toMatchObject({ dirty: true, ahead: 2 });
    const registryOnly = buildRepositoryExplorerProjection(registry) as { repositories: Record<string, unknown>[]; statusAvailable: boolean; multiRepository: boolean };
    expect(registryOnly).toMatchObject({ multiRepository: true, statusAvailable: false });
    expect(registryOnly.repositories[0]).not.toHaveProperty('dirty');
  });
});

const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'operator' };
const config: ApiConfig = {
  host: '127.0.0.1', port: 3000, authMode: 'cloudflare-access', ownerId: 'owner',
  accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'audience',
  accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs', runnerUrl: 'http://runner:3001',
  apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'api-key-audience',
  apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp',
  runnerToken: 'runner-token-that-is-longer-than-32-characters', publicHosts: ['dashboard.example'],
  allowedOrigins: ['https://dashboard.example'], requestTimeoutMs: 60_000, maxBodyBytes: 65_536,
  mcpGatewayTimeoutMs: 30_000, mcpGatewayMaxResponseBytes: 262_144, mcpGatewayMaxToolsPerServer: 500,
  mcpGatewayMaxSchemaBytes: 65_536, mcpGatewayMaxCatalogBytes: 2_097_152, mcpGatewayMaxTraceRows: 20_000,
  mcpGatewayMaxConnections: 32, mcpGatewayAllowInsecureHttp: false, mcpGatewayAllowPrivateEndpoints: false
};

type Reply = { status: number; json: any; headers: IncomingHttpHeaders };
type Call = { operation: string; input: Record<string, unknown> };
const ok = (data: Record<string, unknown>): RunnerResponse => ({ ok: true, message: 'ok', truncated: false, data });

describe('repository-scoped dashboard routes', () => {
  let server: Server;
  let port: number;
  let calls: Call[];
  let multiRepository: boolean;
  let statusFails: boolean;

  beforeEach(async () => {
    calls = [];
    multiRepository = true;
    statusFails = false;
    const runner: DashboardRunnerClient = {
      call: vi.fn(async (operation, input) => {
        calls.push({ operation, input });
        if (operation === 'workspace_repos_list') {
          return ok(multiRepository
            ? { workspaceId, multiRepository: true, repositories }
            : { workspaceId, multiRepository: false, repositories: [{ ...repositories[0], path: '.' }] });
        }
        if (operation === 'workspace_repo_status') {
          if (statusFails) return { ok: false, message: 'busy', truncated: false, error: { code: 'CONFLICT', message: 'workspace is creating', retryable: true } };
          return ok({ workspaceId, multiRepository: true, repositories: repositories.map((entry) => ({ ...entry, branch: 'main', hasUncommitted: false, status: '## main...origin/main' })) });
        }
        if (operation === 'git_status') return ok({ output: '## main...origin/main [ahead 1]' });
        if (operation === 'files_list') return ok({ path: input.path, entries: [] });
        if (operation === 'files_read') return ok({ path: input.path, content: 'x', sha256: 'a'.repeat(64), bytes: 1 });
        return ok({});
      }),
      callInternal: vi.fn(async (operation, input) => {
        calls.push({ operation, input });
        return ok({ terminalId: `term_${'t'.repeat(24)}`, workspaceId, status: 'running', cwd: input.cwd, cols: 80, rows: 24 });
      })
    };
    const app = express();
    app.use((request: any, _response, next) => { request.auth = { token: 'cloudflare-access', clientId: 'operator', scopes: [], extra: { principal } }; next(); });
    app.use('/dashboard', createDashboardRouter(config, runner));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server unavailable');
    port = address.port;
  });

  afterEach(async () => await new Promise<void>((resolve) => server.close(() => resolve())));

  function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: `/dashboard${path}`, method: options.method ?? 'GET', headers: { host: 'dashboard.example', ...options.headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try { if (text) json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: response.statusCode ?? 0, json, headers: response.headers });
        });
      });
      request.on('error', reject); request.end(options.body);
    });
  }

  async function mutationHeaders(): Promise<Record<string, string>> {
    const session = await send('/api/v1/session');
    const cookie = String(session.headers['set-cookie']?.[0]).split(';', 1)[0]!;
    return { origin: 'https://dashboard.example', cookie, 'content-type': 'application/json', 'x-csrf-token': session.json.csrfToken };
  }

  async function mutate(path: string, method: string, payload: Record<string, unknown>, headers?: Record<string, string>): Promise<Reply> {
    const body = JSON.stringify(payload);
    return await send(path, { method, headers: { ...(headers ?? await mutationHeaders()), 'content-length': String(Buffer.byteLength(body)) }, body });
  }

  const base = `/api/v1/workspaces/${workspaceId}`;
  const last = (operation: string) => calls.findLast((call) => call.operation === operation);

  it('combines the registry and per-checkout status for a multi-repository workspace', async () => {
    const response = await send(`${base}/repositories`);
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.operation)).toEqual(['workspace_repos_list', 'workspace_repo_status']);
    expect(last('workspace_repo_status')?.input).toEqual({ workspaceId });
    expect(response.json.data).toMatchObject({ multiRepository: true, statusAvailable: true });
    expect(response.json.data.repositories).toHaveLength(2);
    expect(response.json.data.repositories[1]).toMatchObject({ alias: 'web', branch: 'main', upstream: 'origin/main', ahead: 0, dirty: false });
    expect(JSON.stringify(response.json)).not.toContain('internal');
  });

  it('skips the executor status read for the selector and for a single-repository workspace', async () => {
    const selector = await send(`${base}/repositories?status=false`);
    expect(selector.json.data).toMatchObject({ multiRepository: true, statusAvailable: false });
    expect(calls.map((call) => call.operation)).toEqual(['workspace_repos_list']);
    calls = [];
    multiRepository = false;
    const single = await send(`${base}/repositories`);
    expect(single.json.data).toMatchObject({ multiRepository: false, statusAvailable: false });
    expect(calls.map((call) => call.operation)).toEqual(['workspace_repos_list']);
  });

  it('degrades to the registry when the status read fails, and rejects an unknown status flag', async () => {
    statusFails = true;
    const degraded = await send(`${base}/repositories`);
    expect(degraded.status).toBe(200);
    expect(degraded.json.data).toMatchObject({ multiRepository: true, statusAvailable: false });
    expect((await send(`${base}/repositories?status=maybe`)).status).toBe(400);
  });

  it('passes the selected repository to every Files and Git read', async () => {
    const reads: Array<[string, string]> = [
      [`${base}/files?path=src&repositoryId=web`, 'files_list'],
      [`${base}/files/content?path=README.md&repositoryId=web`, 'files_read'],
      [`${base}/git/status?repositoryId=web`, 'git_status'],
      [`${base}/git/diff?staged=true&repositoryId=web`, 'git_diff'],
      [`${base}/git/log?limit=20&repositoryId=${webId}`, 'git_log'],
      [`${base}/worktrees?repositoryId=web`, 'worktrees_list']
    ];
    for (const [path, operation] of reads) {
      calls = [];
      const response = await send(path);
      expect(response.status, path).toBe(200);
      expect(last(operation)?.input.repositoryId, path).toBe(operation === 'git_log' ? webId : 'web');
      if (operation === 'files_list') expect(last(operation)?.input).toMatchObject({ workspaceId, repositoryId: 'web', path: 'src' });
    }
  });

  it('keeps reads without a selector at the workspace root, exactly as before', async () => {
    for (const [path, operation] of [[`${base}/files?path=.`, 'files_list'], [`${base}/git/status`, 'git_status'], [`${base}/worktrees`, 'worktrees_list']] as const) {
      calls = [];
      expect((await send(path)).status, path).toBe(200);
      expect(last(operation)?.input, path).not.toHaveProperty('repositoryId');
    }
  });

  it('rejects an invalid repository selector at the router boundary before calling the runner', async () => {
    for (const path of [
      `${base}/git/status?repositoryId=Not_An_Alias`,
      `${base}/files?path=.&repositoryId=..%2Fother`,
      `${base}/git/diff?repositoryId=web&repositoryId=api`,
      `${base}/worktrees?repositoryId=${'x'.repeat(41)}`
    ]) {
      calls = [];
      const response = await send(path);
      expect(response.status, path).toBe(400);
      expect(response.json.error, path).toBe('invalid_request');
      expect(calls, path).toEqual([]);
    }
  });

  it('carries the selected repository through Git and Files mutations under the existing CSRF checks', async () => {
    const headers = await mutationHeaders();
    const mutations: Array<[string, string, string, Record<string, unknown>]> = [
      [`${base}/git/fetch`, 'POST', 'git_fetch', { remote: 'origin', repositoryId: 'web' }],
      [`${base}/git/pull`, 'POST', 'git_pull', { remote: 'origin', strategy: 'ff-only', repositoryId: 'web' }],
      [`${base}/git/checkout`, 'POST', 'git_checkout', { ref: 'main', repositoryId: 'web' }],
      [`${base}/git/branch`, 'POST', 'git_branch', { action: 'create', name: 'feature/x', repositoryId: 'web' }],
      [`${base}/git/merge`, 'POST', 'git_merge', { ref: 'main', repositoryId: 'web' }],
      [`${base}/git/rebase`, 'POST', 'git_rebase', { action: 'start', upstream: 'main', repositoryId: 'web' }],
      [`${base}/worktrees`, 'POST', 'worktrees_create', { name: 'review', ref: 'main', repositoryId: 'web' }],
      [`${base}/worktrees/review`, 'DELETE', 'worktrees_remove', { repositoryId: 'web' }],
      [`${base}/files/content`, 'PUT', 'files_write', { path: 'README.md', content: 'x', repositoryId: 'web' }],
      [`${base}/files/directory`, 'POST', 'files_mkdir', { path: 'docs', recursive: true, repositoryId: 'web' }]
    ];
    for (const [path, method, operation, payload] of mutations) {
      const response = await mutate(path, method, payload, headers);
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(last(operation)?.input.repositoryId, `${method} ${path}`).toBe('web');
    }
    calls = [];
    const invalid = await mutate(`${base}/git/fetch`, 'POST', { remote: 'origin', repositoryId: 'Bad Alias' }, headers);
    expect(invalid.status).toBe(400);
    expect(calls).toEqual([]);
    const body = JSON.stringify({ remote: 'origin', repositoryId: 'web' });
    const withoutCsrf = await send(`${base}/git/fetch`, { method: 'POST', headers: { origin: 'https://dashboard.example', cookie: headers.cookie!, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body });
    expect(withoutCsrf.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('opens a repository terminal in that checkout, resolved from the workspace registry', async () => {
    const headers = await mutationHeaders();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ repositoryId: 'web', cols: 100, rows: 30 }, 'repos/web'],
      [{ repositoryId: webId, cwd: 'src' }, 'repos/web/src'],
      [{ repositoryId: 'api', cwd: '.' }, 'repos/api']
    ];
    for (const [payload, cwd] of cases) {
      const response = await mutate(`${base}/terminals`, 'POST', payload, headers);
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(last('terminal_open')?.input, JSON.stringify(payload)).toMatchObject({ workspaceId, cwd });
      expect(last('terminal_open')?.input, JSON.stringify(payload)).not.toHaveProperty('repositoryId');
    }
    calls = [];
    const root = await mutate(`${base}/terminals`, 'POST', {}, headers);
    expect(root.status).toBe(200);
    expect(calls.map((call) => call.operation)).toEqual(['terminal_open']);
    expect(last('terminal_open')?.input).toMatchObject({ cwd: '.' });
  });

  it('refuses a terminal for a repository the workspace does not hold, or a malformed selector', async () => {
    const headers = await mutationHeaders();
    calls = [];
    const unknown = await mutate(`${base}/terminals`, 'POST', { repositoryId: 'docs' }, headers);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe('invalid_request');
    expect(calls.map((call) => call.operation)).toEqual(['workspace_repos_list']);
    calls = [];
    const malformed = await mutate(`${base}/terminals`, 'POST', { repositoryId: '../web' }, headers);
    expect(malformed.status).toBe(400);
    expect(calls).toEqual([]);
    const escape = await mutate(`${base}/terminals`, 'POST', { repositoryId: 'web', cwd: '../api' }, headers);
    expect(escape.status).toBe(400);
    expect(last('terminal_open')).toBeUndefined();
  });

  it('opens a single-repository terminal at the workspace root when its one repository is named', async () => {
    multiRepository = false;
    const response = await mutate(`${base}/terminals`, 'POST', { repositoryId: 'api' });
    expect(response.status).toBe(200);
    expect(last('terminal_open')?.input).toMatchObject({ cwd: '.' });
  });
});

describe('repository explorer and scope controls', () => {
  const listed = repositories.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'internal')));
  const withStatus = [
    { ...listed[0], branch: 'main', upstream: 'origin/main', ahead: 3, behind: 1, dirty: true, changedFiles: 2 },
    { ...listed[1], statusError: true }
  ];

  it('resolves a selector by alias or stable id and nothing else', () => {
    expect(selectedRepository(listed, 'web')?.alias).toBe('web');
    expect(selectedRepository(listed, apiId)?.alias).toBe('api');
    expect(selectedRepository(listed, 'docs')).toBeUndefined();
    expect(selectedRepository(listed, '')).toBeUndefined();
  });

  it('renders branch, uncommitted and unpushed state as text with scoped links', () => {
    const markup = renderRepositoryExplorer({ workspaceId, repositories: withStatus, statusAvailable: true });
    expect(markup).toContain('id="repository-explorer-heading"');
    expect(markup).toContain('Uncommitted changes (2 file(s))');
    expect(markup).toContain('3 unpushed commit(s) · 1 behind');
    expect(markup).toContain('Status unavailable');
    expect(markup).toContain(`href="/dashboard/workspaces/${workspaceId}/git?repository=api"`);
    expect(markup).toContain(`href="/dashboard/workspaces/${workspaceId}/files?repository=web"`);
    expect(markup).toContain(`href="/dashboard/workspaces/${workspaceId}/terminal?repository=web"`);
    expect(markup).toContain('<span class="sr-only"> for web</span>');
    // The table and the card list carry the same rows for the phone breakpoint.
    expect(markup).toContain('class="desktop-table"');
    expect(markup).toContain('class="mobile-list"');
  });

  it('never presents an unread status as a clean checkout', () => {
    const markup = renderRepositoryExplorer({ workspaceId, repositories: listed, statusAvailable: false });
    expect(markup).not.toContain('Clean');
    expect(markup).not.toContain('Nothing unpushed');
    expect(markup).toContain('Not reported');
    expect(markup).toContain('could not be read now');
    const noUpstream = renderRepositoryExplorer({ workspaceId, repositories: [{ ...listed[0], branch: 'feature/x', ahead: 0, behind: 0, dirty: false, changedFiles: 0 }], statusAvailable: true });
    expect(noUpstream).toContain('Clean');
    expect(noUpstream).toContain('No upstream branch');
  });

  it('offers the workspace root for Files and Terminal but requires a choice for Git', () => {
    const files = renderRepositorySelector({ repositories: listed, selected: 'web' });
    expect(files).toContain('<label for="repository-scope-select">Repository</label>');
    expect(files).toContain('<option value="">Workspace root</option>');
    expect(files).toContain('<option value="web" selected>web · acme/web (read-only)</option>');
    expect(files).toContain('type="submit"');
    const git = renderRepositorySelector({ repositories: listed, selected: '', allowRoot: false });
    expect(git).not.toContain('Workspace root');
    expect(git).toContain('<option value="" disabled selected>Choose a repository</option>');
    expect(git).toContain('required');
    expect(renderRepositorySelector({ repositories: listed, selected: 'docs', allowRoot: false })).toContain('disabled selected');
    expect(renderRepositoryRequired(listed)).toContain('This workspace holds 2 repositories');
  });

  it('carries the selected repository on scoped tab and file links only', () => {
    const tabs = renderWorkspaceTabs(workspaceId, 'files', 'web');
    for (const tab of ['files', 'git', 'terminal']) expect(tabs).toContain(`/${tab}?repository=web"`);
    for (const tab of ['summary', 'agents', 'runtime', 'automation']) expect(tabs).toContain(`href="/dashboard/workspaces/${workspaceId}/${tab}"`);
    const list = renderFileList(workspaceId, { path: 'src', entries: [{ name: 'a b.ts', type: 'file' }, { name: 'lib', type: 'directory' }] }, { repository: 'web' });
    expect(list).toContain(`href="/dashboard/workspaces/${workspaceId}/files?path=src%2Fa%20b.ts&file=1&repository=web"`);
    expect(list).toContain(`href="/dashboard/workspaces/${workspaceId}/files?path=src%2Flib&repository=web"`);
    expect(list).toContain('Repository root (web)');
    expect(renderFile(workspaceId, { path: 'README.md', content: '', sha256: 'a' }, { repository: 'web' })).toContain('Repository root (web)');
  });

  it('turns whole-file save off when the read holds only part of the file', () => {
    const whole = renderFile(workspaceId, { path: 'README.md', content: 'hi', sha256: 'a', bytesReturned: 2, totalBytes: 2, eof: true });
    expect(whole).toContain('<button type="submit">Save file</button>');
    expect(whole).not.toContain('readonly');
    expect(whole).not.toContain('file-partial-notice');
    for (const data of [
      { path: 'big.txt', content: 'x', sha256: 'a', bytesReturned: 65_536, totalBytes: 100_000, eof: false },
      // A projection without `eof` (an older runner) is treated as partial: refusing a save is safe, truncating is not.
      { path: 'big.txt', content: 'x', sha256: 'a' }
    ]) {
      const partial = renderFile(workspaceId, data);
      expect(partial).not.toContain('Save file');
      expect(partial).toContain('readonly aria-describedby="file-partial-notice"');
      expect(partial).toContain('id="file-partial-notice"');
      expect(partial).toContain('id="patch-form"');
      expect(partial).toContain('id="delete-file"');
    }
    expect(renderFile(workspaceId, { path: 'big.txt', content: 'x', sha256: 'a', bytesReturned: 65_536, totalBytes: 100_000, eof: false }))
      .toContain(`Showing the first ${(65_536).toLocaleString()} bytes of ${(100_000).toLocaleString()} bytes.`);
    expect(renderFile(workspaceId, { path: 'big.txt', content: 'x', sha256: 'a' })).toContain('The runner did not confirm this is the whole file.');
  });

  it('keeps single-repository tab, file and terminal markup byte-identical', () => {
    const tabs = renderWorkspaceTabs(workspaceId, 'git');
    expect(tabs).not.toContain('repository=');
    expect(tabs).toBe(renderWorkspaceTabs(workspaceId, 'git', ''));
    const list = renderFileList(workspaceId, { path: '.', entries: [{ name: 'a b.ts', type: 'file' }] });
    expect(list).toContain(`<a href="/dashboard/workspaces/${workspaceId}/files?path=.">Workspace root</a>`);
    expect(list).toContain(`href="/dashboard/workspaces/${workspaceId}/files?path=a%20b.ts&file=1"`);
    expect(filesHref(workspaceId, '.')).toBe(`/dashboard/workspaces/${workspaceId}/files?path=.`);
    const terminal = { terminalId: `term_${'t'.repeat(24)}`, status: 'running', cwd: '.', cols: 80, rows: 24, createdAt: '2026-10-17T00:00:00.000Z', idleExpiresAt: '2026-10-17T00:30:00.000Z' };
    expect(renderTerminalPanel({ workspaceId, terminals: [terminal] })).not.toContain(' · in ');
    expect(renderTerminalPanel({ workspaceId, terminals: [{ ...terminal, cwd: 'repos/web' }] })).toContain(' · in <span class="mono">repos/web</span>');
  });

  it('adds the repository to API reads and mutation bodies only when one is selected', async () => {
    expect(withRepository('/workspaces/x/git/status', 'web')).toBe('/workspaces/x/git/status?repositoryId=web');
    expect(withRepository('/workspaces/x/git/log?limit=20', 'web')).toBe('/workspaces/x/git/log?limit=20&repositoryId=web');
    expect(withRepository('/workspaces/x/git/status')).toBe('/workspaces/x/git/status');
    expect(inRepository({ ref: 'main' }, 'web')).toEqual({ ref: 'main', repositoryId: 'web' });
    expect(inRepository({ ref: 'main' })).toEqual({ ref: 'main' });
    const request = vi.fn(async () => ({}));
    const file = { path: 'README.md', sha256: 'a'.repeat(64) };
    await submitPatchEdit({ workspaceId, file, oldText: 'a', newText: 'b', request, onSaved: async () => {}, onConflict: () => {}, onError: () => {}, repositoryId: 'web' });
    expect(JSON.parse((request.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ path: 'README.md', repositoryId: 'web' });
    await submitPatchEdit({ workspaceId, file, oldText: 'a', newText: 'b', request, onSaved: async () => {}, onConflict: () => {}, onError: () => {} });
    expect(JSON.parse((request.mock.calls[1] as unknown as [string, { body: string }])[1].body)).not.toHaveProperty('repositoryId');
  });

  it('opens a terminal session with the selected repository and without one at the root', async () => {
    const open = vi.fn(async () => ({ data: { terminal: { terminalId: `term_${'t'.repeat(24)}`, status: 'exited', cols: 80, rows: 24 } } }));
    const client = { open, read: vi.fn(), input: vi.fn(), resize: vi.fn(async () => ({})), close: vi.fn(), list: vi.fn() };
    const scoped = createTerminalSession({ client, sink: { write: () => {} } });
    await scoped.open({ cols: 80, rows: 24, repositoryId: 'web' });
    expect(open.mock.calls[0]).toEqual([{ repositoryId: 'web', cols: 80, rows: 24 }]);
    scoped.dispose();
    const root = createTerminalSession({ client, sink: { write: () => {} } });
    await root.open({ cols: 80, rows: 24 });
    expect(open.mock.calls[1]).toEqual([{ cols: 80, rows: 24 }]);
    root.dispose();
  });
});
