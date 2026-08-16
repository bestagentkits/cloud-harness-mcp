import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { ApiConfig, RunnerConfig } from '@cloud-harness/contracts';
import { createApiApp, type ApiRuntime } from '../../apps/api/src/app.js';
import { createRunnerApp } from '../../apps/runner/src/app.js';
import { inspectContainer } from '../../apps/runner/src/docker-engine.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

const bearer = 'e2e-bearer-token-that-is-longer-than-32-characters';
const serviceToken = 'e2e-runner-token-that-is-longer-than-32-characters';
let directory: string;
let store: StateStore;
let service: WorkspaceService;
let runnerServer: Server;
let apiServer: Server;
let apiRuntime: ApiRuntime;
let client: Client;
let workspaceId: string | undefined;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed to listen');
  return address.port;
}

function structured(result: CallToolResult): Record<string, any> {
  expect(result.isError).toBe(false);
  return result.structuredContent as Record<string, any>;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return structured(await client.callTool({ name, arguments: args }));
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-e2e-'));
  const runnerConfig: RunnerConfig = {
    host: '127.0.0.1', port: 0, serviceToken, jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state', 'state.db'),
    executorImage: 'cloud-harness-executor:local', allowedGitHosts: ['github.com'], networkMode: 'none', wallTtlSeconds: 300,
    idleTtlSeconds: 180, maxOutputBytes: 262_144, minFreeBytes: 104_857_600, maxWorkspaceBytes: 536_870_912, reaperIntervalSeconds: 0.05
  };
  store = new StateStore(runnerConfig.stateDb);
  service = new WorkspaceService(runnerConfig, store);
  await service.start();
  runnerServer = createServer(createRunnerApp(runnerConfig, service));
  const runnerPort = await listen(runnerServer);
  const apiConfig: ApiConfig = {
    host: '127.0.0.1', port: 0, ownerId: 'owner', bearerToken: bearer, runnerUrl: `http://127.0.0.1:${runnerPort}`,
    runnerToken: serviceToken, publicHosts: ['127.0.0.1'], allowedOrigins: [], requestTimeoutMs: 120_000, maxBodyBytes: 262_144
  };
  apiRuntime = createApiApp(apiConfig);
  apiServer = createServer(apiRuntime.app);
  const apiPort = await listen(apiServer);
  client = new Client({ name: 'cloud-harness-e2e', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
}, 30_000);

afterAll(async () => {
  if (workspaceId) await service.close('owner', workspaceId).catch(() => undefined);
  await client.close().catch(() => undefined);
  await apiRuntime.close();
  await service.stop();
  store.close();
  await Promise.all([
    new Promise<void>((resolve) => apiServer.close(() => resolve())),
    new Promise<void>((resolve) => runnerServer.close(() => resolve()))
  ]);
  rmSync(directory, { recursive: true, force: true });
});

describe('complete coding workflow through MCP', () => {
  it('uses every required coding domain in a persistent sandbox', async () => {
    const opened = await call('workspace_open', { repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git', idempotencyKey: 'e2e-workspace-1', networkMode: 'none' });
    workspaceId = opened.data.workspaceId;
    const replayed = await call('workspace_open', { repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git', idempotencyKey: 'e2e-workspace-1', networkMode: 'none' });
    expect(replayed.data.workspaceId).toBe(workspaceId);
    expect(JSON.stringify((await call('workspace_list')).data)).toContain(workspaceId);
    expect((await call('workspace_status', { workspaceId })).data.status).toBe('ACTIVE');

    const read = await call('files_read', { workspaceId, path: 'README.md', offset: 0, limit: 65_536 });
    await call('files_apply_patch', { workspaceId, path: 'README.md', oldText: 'Remote coding harness', newText: 'Verified remote coding harness', expectedSha256: read.data.sha256 });
    await call('files_write', { workspaceId, path: 'verification.txt', content: 'cloud harness verified\n' });
    expect(JSON.stringify((await call('files_list', { workspaceId, path: '.', limit: 100 })).data)).toContain('verification.txt');
    expect(JSON.stringify((await call('grep_search', { workspaceId, pattern: 'cloud harness verified', path: '.', maxResults: 10 })).data)).toContain('verification.txt');
    expect(JSON.stringify((await call('exec_run', { workspaceId, command: 'printf exec-ok && test ! -w /etc', cwd: '.', timeoutMs: 10_000, maxOutputBytes: 65_536 })).data)).toContain('exec-ok');

    const shell = await call('shell_open', { workspaceId, cwd: '.', idempotencyKey: 'e2e-shell-1' });
    const shellId = shell.data.id;
    const shellOutput = await call('shell_io', { workspaceId, shellId, input: 'echo shell-ok\n', waitMs: 300 });
    expect(JSON.stringify(shellOutput.data)).toContain('shell-ok');
    const shellDelta = await call('shell_io', { workspaceId, shellId, cursor: shellOutput.cursor, waitMs: 0 });
    expect(shellDelta.data.output).toBe('');
    const boundedShellOutput = await call('shell_io', { workspaceId, shellId, input: 'yes x | head -c 300000\n', cursor: shellDelta.cursor, waitMs: 500 });
    expect(boundedShellOutput.truncated).toBe(true);
    expect(Buffer.byteLength(boundedShellOutput.data.output)).toBeLessThanOrEqual(65_536);
    const futureCursor = await client.callTool({ name: 'shell_io', arguments: { workspaceId, shellId, cursor: '999999999', waitMs: 0 } });
    expect(futureCursor.isError).toBe(true);
    expect((futureCursor.structuredContent as Record<string, any>).error.code).toBe('INVALID_INPUT');
    await call('shell_io', { workspaceId, shellId, input: 'sleep 2; printf leaked > shell-close-leak.txt\n', waitMs: 0 });
    await call('shell_close', { workspaceId, shellId });
    await new Promise((resolve) => setTimeout(resolve, 2_250));
    expect(JSON.stringify((await call('files_list', { workspaceId, path: '.', limit: 100 })).data)).not.toContain('shell-close-leak.txt');

    const task = await call('tasks_run', { workspaceId, command: 'echo task-ok', cwd: '.', idempotencyKey: 'e2e-task-1', timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(JSON.stringify((await call('tasks_status', { workspaceId, taskId: task.data.id })).data)).toContain('task-ok');
    expect((await call('tasks_list', { workspaceId, limit: 100 })).data.tasks.length).toBeGreaterThan(0);

    const cancellable = await call('tasks_run', {
      workspaceId,
      command: 'sleep 3; printf should-not-exist > cancelled-task.txt',
      cwd: '.',
      idempotencyKey: 'e2e-task-cancel-1',
      timeoutMs: 10_000
    });
    expect((await call('tasks_cancel', { workspaceId, taskId: cancellable.data.id })).data.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const cancelledArtifacts = await call('files_list', { workspaceId, path: '.', limit: 100 });
    expect(JSON.stringify(cancelledArtifacts.data)).not.toContain('cancelled-task.txt');
    const firstTaskPage = await call('tasks_list', { workspaceId, limit: 1 });
    expect(firstTaskPage.data.tasks).toHaveLength(1);
    expect(firstTaskPage.cursor).toBeTruthy();
    const secondTaskPage = await call('tasks_list', { workspaceId, limit: 1, cursor: firstTaskPage.cursor });
    expect(secondTaskPage.data.tasks).toHaveLength(1);

    await call('exec_run', { workspaceId, command: 'mkdir -p .agents/skills/demo/scripts .cloud-harness && printf "# Demo skill\\n" > .agents/skills/demo/SKILL.md && printf "#!/bin/sh\\necho skill-ok\\n" > .agents/skills/demo/scripts/run.sh && chmod +x .agents/skills/demo/scripts/run.sh', cwd: '.', timeoutMs: 10_000, maxOutputBytes: 65_536 });
    await call('files_write', { workspaceId, path: '.cloud-harness/hooks.json', content: '{"verify":"echo hook-ok"}' });
    expect(JSON.stringify((await call('skills_list', { workspaceId })).data)).toContain('demo');
    expect(JSON.stringify((await call('skills_read', { workspaceId, name: 'demo' })).data)).toContain('Demo skill');
    expect(JSON.stringify((await call('skills_run', { workspaceId, name: 'demo', script: 'run.sh', args: [], timeoutMs: 10_000 })).data)).toContain('skill-ok');
    expect(JSON.stringify((await call('hooks_list', { workspaceId })).data)).toContain('verify');
    expect(JSON.stringify((await call('hooks_run', { workspaceId, name: 'verify', timeoutMs: 10_000 })).data)).toContain('hook-ok');
    await call('memories_write', { workspaceId, name: 'e2e', content: 'memory-ok' });
    expect(JSON.stringify((await call('memories_list', { workspaceId })).data)).toContain('e2e');
    expect(JSON.stringify((await call('memories_read', { workspaceId, name: 'e2e' })).data)).toContain('memory-ok');

    expect(JSON.stringify((await call('git_status', { workspaceId })).data)).toContain('verification.txt');
    expect(JSON.stringify((await call('git_diff', { workspaceId, staged: false })).data)).toContain('Verified remote coding harness');
    await call('git_commit', { workspaceId, message: 'test: verify harness workflow', authorName: 'Harness Test', authorEmail: 'harness@example.invalid', all: true });
    expect(JSON.stringify((await call('git_log', { workspaceId, limit: 5 })).data)).toContain('verify harness workflow');
    const branches = await call('git_branch', { workspaceId, action: 'list', force: false });
    const initialBranch = branches.data.output.trim().split('\n')[0];
    await call('git_branch', { workspaceId, action: 'create', name: 'e2e-branch', startPoint: 'HEAD', force: false });
    await call('git_checkout', { workspaceId, ref: 'e2e-branch', create: false });
    await call('git_checkout', { workspaceId, ref: initialBranch, create: false });
    await call('git_branch', { workspaceId, action: 'delete', name: 'e2e-branch', force: false });
    const fetchResult = await client.callTool({ name: 'git_fetch', arguments: { workspaceId, remote: 'origin' } });
    expect(fetchResult.isError).toBe(true);
    expect((fetchResult.structuredContent as Record<string, any>).error.code).toBe('UNAVAILABLE');
    await call('worktrees_create', { workspaceId, name: 'verification-tree', ref: 'HEAD', createBranch: false });
    expect(JSON.stringify((await call('worktrees_list', { workspaceId })).data)).toContain('verification-tree');
    await call('worktrees_remove', { workspaceId, name: 'verification-tree', force: true });

    await call('workspace_close', { workspaceId });
    workspaceId = undefined;

    const expiring = await call('workspace_open', { repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git', idempotencyKey: 'e2e-workspace-ttl', networkMode: 'none' });
    workspaceId = expiring.data.workspaceId;
    const expiringRecord = store.byId(workspaceId)!;
    store.update(workspaceId, { expiresAt: Date.now() - 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await call('workspace_status', { workspaceId })).data.status).toBe('CLOSED');
    expect(await inspectContainer(expiringRecord.containerName!)).toBeUndefined();
    workspaceId = undefined;
    const firstWorkspacePage = await call('workspace_list', { limit: 1 });
    expect(firstWorkspacePage.data.workspaces).toHaveLength(1);
    expect(firstWorkspacePage.cursor).toBeTruthy();
    const secondWorkspacePage = await call('workspace_list', { limit: 1, cursor: firstWorkspacePage.cursor });
    expect(secondWorkspacePage.data.workspaces).toHaveLength(1);
  }, 120_000);
});
