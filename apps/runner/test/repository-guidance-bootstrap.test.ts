import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerAgentsConfigSchema, type RunnerConfig } from '@cloud-harness/contracts';
import type { AgentGatewayControl, AgentLeaseGrant } from '../src/agent-gateway-control.js';
import type { AgentLauncher, AgentRuntimeProcess } from '../src/agent-launcher.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';

const WORKER = resolve(__dirname, '../../../worker/harness-worker.mjs');

/**
 * Executor calls run the real worker against a local checkout, so these tests exercise the
 * production discovery, fingerprint, and bounds rather than a hand-written manifest.
 */
const docker = vi.hoisted(() => ({
  checkout: '',
  workerInputs: [] as Array<{ operation: string; input: Record<string, unknown> }>,
  runDocker: vi.fn(async (args: string[], options?: { stdin?: string }) => {
    if (args.includes('/opt/harness/worker-runner.sh')) {
      const request = JSON.parse(options?.stdin ?? '{}') as { operation: string; input: Record<string, unknown> };
      docker.workerInputs.push(request);
      const { spawnSync: run } = await import('node:child_process');
      const result = run(process.execPath, [docker.worker], {
        input: options?.stdin ?? '', encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HARNESS_WORKSPACE_ROOT: docker.checkout }
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1, truncated: false };
    }
    if (args.includes('/usr/bin/du')) return { stdout: '0\t/workspace\n', stderr: '', exitCode: 0, truncated: false };
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  }),
  worker: '',
  removeContainer: vi.fn(async () => undefined),
  inspectContainer: vi.fn(async () => undefined),
  terminateContainerProcessGroup: vi.fn(async () => undefined)
}));

vi.mock('../src/docker-engine.js', () => docker);

import { WorkspaceService } from '../src/workspace-service.js';

const directories: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  docker.workerInputs = [];
  vi.clearAllMocks();
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeGateway implements AgentGatewayControl {
  async issue(input: Omit<AgentLeaseGrant, 'lease'>): Promise<AgentLeaseGrant> { return { ...input, lease: `bearer_${'x'.repeat(48)}` }; }
  async revokeAndDrain(): Promise<void> {}
  async cancelAndDrain(): Promise<void> {}
}

class FakeLauncher implements AgentLauncher {
  readonly inputs: PassThrough[] = [];
  async reconcile(): Promise<void> {}
  async launch(): Promise<AgentRuntimeProcess> {
    const input = new PassThrough();
    this.inputs.push(input);
    const process = { stdin: input, stdout: new PassThrough(), stderr: new PassThrough() } as unknown as ChildProcessWithoutNullStreams;
    return { process, exited: Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>().promise };
  }
  async cleanup(): Promise<void> {}
  async inspect(): Promise<{ container: boolean; network: boolean }> { return { container: false, network: false }; }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ch-guidance-'));
  directories.push(directory);
  const checkout = join(directory, 'checkout');
  mkdirSync(checkout);
  docker.checkout = checkout;
  docker.worker = WORKER;
  const jobsRoot = join(directory, 'jobs');
  mkdirSync(jobsRoot);
  const config = {
    jobsRoot, stateDb: join(directory, 'state.db'), idleTtlSeconds: 3600, wallTtlSeconds: 14400,
    workspaceIdleTimeoutSeconds: 3600, maxOutputBytes: 262144, maxWorkspaceBytes: 104857600, minFreeBytes: 1,
    networkProfile: 'network-none', allowedGitHosts: ['github.com'], executorImage: 'cloud-harness-executor:test',
    agents: RunnerAgentsConfigSchema.parse({
      image: 'cloud-harness-agent:test', gatewayUrl: 'http://model-gateway:3210',
      profiles: [{
        id: 'default', displayName: 'Default', provider: 'test', model: 'test/model',
        inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
        maxInputTokens: 200_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000,
        maxProxyOperations: ['files_read']
      }],
      limits: { minTtlSeconds: 30, maxTtlSeconds: 3_600 }
    })
  } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  stores.push(store);
  const ownerId = store.resolvePrincipal({ kind: 'owner', ownerId: 'owner' });
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'g'.repeat(24)}`, ownerId, idempotencyKey: 'workspace-key',
    repositoryUrl: 'https://github.com/example/repository.git', repositoryRef: null,
    containerName: 'executor', workspacePath: join(jobsRoot, 'ws'), environmentId: null, status: 'ACTIVE',
    networkProfile: 'network-none', createdAt: now, lastActivityAt: now, expiresAt: now + 600_000,
    hardExpiresAt: now + 3_600_000, gitAuthorName: null, gitAuthorEmail: null, mutationLockedUntil: null,
    generation: 1, error: null
  };
  store.create(record);
  const launcher = new FakeLauncher();
  const service = new WorkspaceService(config, store, undefined, undefined, undefined, undefined, { launcher, gateway: new FakeGateway() });
  const write = (path: string, content: string) => {
    mkdirSync(join(checkout, path, '..'), { recursive: true });
    writeFileSync(join(checkout, path), content);
  };
  return { service, store, record, checkout, launcher, write, principal: { kind: 'owner', ownerId: 'owner' } as const };
}

describe('repository guidance bootstrap', () => {
  it('discovers AGENTS.md, CLAUDE.md, REVIEW.md, and DESIGN.md with repository provenance bounds', async () => {
    const { service, record, write } = fixture();
    write('AGENTS.md', '# Agents\nRun npm test.');
    write('CLAUDE.md', '# Claude');
    write('REVIEW.md', '# Review\nBlock on missing tests.');
    write('DESIGN.md', '# Design');
    write('.aider.conf.yml', 'openai-api-key: sk-should-never-be-read');
    const { snapshot, reused } = await service.repositoryGuidance(record);
    expect(reused).toBe(false);
    expect(snapshot.documents.map((d) => d.path).sort()).toEqual(['.aider.conf.yml', 'AGENTS.md', 'CLAUDE.md', 'DESIGN.md', 'REVIEW.md']);
    expect(snapshot.documents.find((d) => d.path === 'REVIEW.md')).toMatchObject({ clients: ['all'], content: '# Review\nBlock on missing tests.' });
    expect(JSON.stringify(snapshot)).not.toContain('sk-should-never-be-read');
  });

  it('reuses the digest-addressed snapshot while unchanged and refreshes after any guidance edit', async () => {
    const { service, record, write } = fixture();
    write('AGENTS.md', 'one');
    const first = await service.repositoryGuidance(record);
    const second = await service.repositoryGuidance(record);
    expect(second).toMatchObject({ reused: true });
    expect(second.snapshot).toBe(first.snapshot);
    expect(docker.workerInputs[1]).toMatchObject({ operation: 'workspace_bootstrap_context', input: { knownFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } });

    write('AGENTS.md', 'two');
    const edited = await service.repositoryGuidance(record);
    expect(edited.reused).toBe(false);
    expect(edited.snapshot.digest).not.toBe(first.snapshot.digest);

    write('REVIEW.md', 'new shared guidance');
    const added = await service.repositoryGuidance(record);
    expect(added.reused).toBe(false);
    expect(added.snapshot.documents.map((d) => d.path)).toContain('REVIEW.md');

    // A new workspace generation never trusts the previous generation's fingerprint.
    await service.repositoryGuidance({ ...record, generation: 2 });
    expect(docker.workerInputs.at(-1)?.input).not.toHaveProperty('knownFingerprint');
  });

  it('never reads guidance through a symlink that escapes the checkout and keeps oversized files unread', async () => {
    const { service, record, checkout, write } = fixture();
    const outside = join(checkout, '..', 'outside.md');
    writeFileSync(outside, 'SECRET OUTSIDE CHECKOUT');
    symlinkSync(outside, join(checkout, 'AGENTS.md'));
    write('REVIEW.md', `# Review\n${'x'.repeat(300 * 1024)}`);
    const { snapshot } = await service.repositoryGuidance(record);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET OUTSIDE CHECKOUT');
    expect(snapshot.documents.find((d) => d.path === 'AGENTS.md')).toBeUndefined();
    expect(snapshot.documents.find((d) => d.path === 'REVIEW.md')).toMatchObject({ contentSha256: '0'.repeat(64) });
    expect(snapshot.documents.find((d) => d.path === 'REVIEW.md')).not.toHaveProperty('content');
    expect(snapshot.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['SCAN_ERROR', 'FILE_TOO_LARGE']));
  });

  it('agrees with workspace_context about which files are active for a profile', async () => {
    const { service, principal, record, write } = fixture();
    write('AGENTS.md', 'base');
    write('AGENTS.override.md', 'override');
    write('REVIEW.md', 'review');
    write('.claude/rules/style.md', 'claude only rule');
    const context = await service.execute(principal, 'workspace_context', { workspaceId: record.id, clientProfile: 'codex', include: ['instructions'] });
    const items = (context.data as { manifest: { items: Array<{ path: string; activeForClient: boolean; inactiveReason?: string }> } }).manifest.items;
    expect(items.map((item) => [item.path, item.activeForClient, item.inactiveReason ?? null])).toEqual([
      ['AGENTS.md', false, 'overridden-by:AGENTS.override.md'],
      ['AGENTS.override.md', true, null],
      ['REVIEW.md', true, null]
    ]);
  });

  it('starts a managed agent with applicable guidance before its task and records what was injected', async () => {
    const { service, principal, record, launcher, write } = fixture();
    write('AGENTS.md', '# Agents\nAlways run npm test.');
    write('CLAUDE.md', '# Claude only');
    write('DESIGN.md', '# Design\nUse tokens.');
    const task = 'Fix the failing test.';
    const spawned = await service.execute(principal, 'agent_spawn', {
      workspaceId: record.id, prompt: task, idempotencyKey: 'spawn-guidance', profileId: 'default', proxyOperations: ['files_read'],
      ttlSeconds: 300, maxOutputBytes: 262_144, maxInputTokens: 100_000, maxOutputTokens: 1_000, maxCostMicros: 100_000
    });
    const agentId = (spawned.data as { agentId: string }).agentId;
    await vi.waitFor(() => expect(launcher.inputs).toHaveLength(1));
    const start = await firstRecord(launcher.inputs[0]!);
    expect(start.type).toBe('start');
    const prompt = start.prompt as string;
    expect(prompt.endsWith(`<user_task>\n${task}\n</user_task>`)).toBe(true);
    expect(prompt).toContain('Always run npm test.');
    expect(prompt).toContain('Use tokens.');
    expect(prompt).not.toContain('# Claude only');

    const logs = await service.execute(principal, 'agent_logs', { workspaceId: record.id, agentId });
    const events = (logs.data as { events: Array<{ type: string; content: string }> }).events;
    const report = JSON.parse(events.find((event) => event.type === 'repository_context')!.content) as Record<string, unknown>;
    expect(report).toMatchObject({
      profile: 'codex',
      injected: [{ path: 'AGENTS.md' }, { path: 'DESIGN.md' }],
      skipped: [{ path: 'CLAUDE.md', reason: 'not-targeted' }],
      snapshotReused: false
    });
    expect(JSON.stringify(report)).not.toContain('Always run npm test.');
    await service.stop?.();
  });

  it('leaves the task untouched when the caller opts out with repositoryContext "none"', async () => {
    const { service, principal, record, launcher, write } = fixture();
    write('AGENTS.md', '# Agents');
    await service.execute(principal, 'agent_spawn', {
      workspaceId: record.id, prompt: 'raw task', idempotencyKey: 'spawn-none', profileId: 'default',
      proxyOperations: ['files_read'], repositoryContext: 'none',
      ttlSeconds: 300, maxOutputBytes: 262_144, maxInputTokens: 100_000, maxOutputTokens: 1_000, maxCostMicros: 100_000
    });
    await vi.waitFor(() => expect(launcher.inputs).toHaveLength(1));
    expect((await firstRecord(launcher.inputs[0]!)).prompt).toBe('raw task');
    expect(docker.workerInputs.some((call) => call.operation === 'workspace_bootstrap_context')).toBe(false);
  });
});

async function firstRecord(stream: PassThrough): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise) => {
    let buffered = '';
    stream.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline !== -1) resolvePromise(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
    });
  });
}

// Keep the static import used so the worker path resolution is type-checked alongside the mock.
void spawnSync;
