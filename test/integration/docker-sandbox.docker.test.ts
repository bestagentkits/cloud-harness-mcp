import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { inspectContainer, removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

let directory: string;
let store: StateStore;
let service: WorkspaceService;
let workspaceId: string | undefined;
let runnerConfig: RunnerConfig;
let orphanContainer: string | undefined;
let foreignOrphanContainer: string | undefined;
const workspaceCeilingBytes = 64 * 1_024 * 1_024;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cloud-harness-docker-'));
  runnerConfig = {
    authMode: 'cloudflare-access',
    host: '127.0.0.1', port: 3001, serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
    jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state', 'state.db'), executorImage: 'cloud-harness-executor:local',
    allowedGitHosts: ['github.com'], networkMode: 'none', wallTtlSeconds: 300, idleTtlSeconds: 180,
    maxOutputBytes: 262_144, minFreeBytes: 104_857_600, maxWorkspaceBytes: workspaceCeilingBytes, reaperIntervalSeconds: 30
  };
  store = new StateStore(runnerConfig.stateDb);
  service = new WorkspaceService(runnerConfig, store);
  await service.start();
}, 20_000);

afterAll(async () => {
  if (workspaceId) await service.execute('owner', 'workspace_close', { workspaceId }).catch(() => undefined);
  if (orphanContainer) await removeContainer(orphanContainer).catch(() => undefined);
  if (foreignOrphanContainer) await removeContainer(foreignOrphanContainer).catch(() => undefined);
  await service.stop();
  store.close();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    await runDocker([
      'run', '--rm', '--network', 'none', '--user', '0:0',
      '--volume', `${directory}:/target`,
      '--entrypoint', '/bin/sh', runnerConfig.executorImage,
      '-c', 'rm -rf /target/*'
    ]).catch(() => undefined);
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('real Docker sandbox', () => {
  it('clones, persists edits across calls, enforces container policy, and cleans up', async () => {
    const opened = await service.execute('owner', 'workspace_open', {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: 'docker-test-workspace-1', networkMode: 'none'
    });
    expect(opened.ok).toBe(true);
    workspaceId = (opened.data as { workspaceId: string }).workspaceId;
    const record = store.byId(workspaceId);
    expect(record?.containerName).toBeTruthy();
    const inspection = await inspectContainer(record!.containerName!);
    const config = inspection!.Config as { User: string; Env: string[]; Labels: Record<string, string> };
    const hostConfig = inspection!.HostConfig as { ReadonlyRootfs: boolean; NetworkMode: string; CapDrop: string[]; Memory: number; NanoCpus: number; PidsLimit: number; Binds: string[]; Ulimits: Array<{ Name: string; Hard: number; Soft: number }> };
    expect(config.User).toBe('10001:10001');
    expect(config.Env.join('\n')).not.toMatch(/TOKEN|SECRET|AUTHORIZATION/i);
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.NetworkMode).toBe('none');
    expect(hostConfig.CapDrop).toContain('ALL');
    expect(hostConfig.Memory).toBe(1_073_741_824);
    expect(hostConfig.NanoCpus).toBe(1_000_000_000);
    expect(hostConfig.PidsLimit).toBe(256);
    expect(hostConfig.Ulimits).toContainEqual({ Name: 'nofile', Hard: 1024, Soft: 1024 });
    expect(hostConfig.Binds.join('\n')).not.toContain('docker.sock');
    await expect(service.execute('different-owner', 'workspace_status', { workspaceId })).rejects.toThrow('workspace not found');

    const read = await service.execute('owner', 'files_read', { workspaceId, path: 'README.md', offset: 0, limit: 65_536 });
    expect((read.data as { content: string }).content).toContain('cloud-harness-mcp');
    const write = await service.execute('owner', 'files_write', { workspaceId, path: 'sandbox-proof.txt', content: 'persisted sandbox edit\n' });
    expect(write.ok).toBe(true);
    const grep = await service.execute('owner', 'grep_search', { workspaceId, pattern: 'persisted sandbox', path: '.', maxResults: 10 });
    expect(JSON.stringify(grep.data)).toContain('sandbox-proof.txt');
    const exec = await service.execute('owner', 'exec_run', { workspaceId, command: 'id -u && test -w /workspace && test ! -w /etc', cwd: '.', timeoutMs: 10_000, maxOutputBytes: 65_536 });
    expect(JSON.stringify(exec.data)).toContain('10001');
    const status = await service.execute('owner', 'git_status', { workspaceId });
    expect(JSON.stringify(status.data)).toContain('sandbox-proof.txt');
    const memory = await service.execute('owner', 'memories_write', { workspaceId, name: 'verification', content: 'remembered' });
    expect(memory.ok).toBe(true);
    const remembered = await service.execute('owner', 'memories_read', { workspaceId, name: 'verification' });
    expect(JSON.stringify(remembered.data)).toContain('remembered');

    await service.stop();
    store.close();
    store = new StateStore(runnerConfig.stateDb);
    service = new WorkspaceService(runnerConfig, store);
    await service.start();
    expect((await service.execute('owner', 'workspace_status', { workspaceId })).data).toMatchObject({ status: 'ACTIVE' });
    expect(JSON.stringify((await service.execute('owner', 'files_read', { workspaceId, path: 'sandbox-proof.txt', offset: 0, limit: 65_536 })).data)).toContain('persisted sandbox edit');

    const orphanWorkspaceId = `ws_${'z'.repeat(24)}`;
    const orphanDirectory = join(runnerConfig.jobsRoot, orphanWorkspaceId);
    mkdirSync(orphanDirectory, { recursive: true });
    orphanContainer = 'cloud-harness-test-orphan-reconciliation';
    const createdOrphan = await runDocker([
      'create', '--name', orphanContainer, '--label', 'cloud-harness.managed=true',
      '--label', `cloud-harness.instance=${config.Labels['cloud-harness.instance']}`,
      '--label', `cloud-harness.workspace=${orphanWorkspaceId}`, runnerConfig.executorImage
    ]);
    expect(createdOrphan.exitCode).toBe(0);
    foreignOrphanContainer = 'cloud-harness-test-foreign-instance';
    const createdForeign = await runDocker([
      'create', '--name', foreignOrphanContainer, '--label', 'cloud-harness.managed=true',
      '--label', 'cloud-harness.instance=foreign-runner', '--label', `cloud-harness.workspace=${orphanWorkspaceId}`,
      runnerConfig.executorImage
    ]);
    expect(createdForeign.exitCode).toBe(0);
    await service.stop();
    service = new WorkspaceService(runnerConfig, store);
    await service.start();
    expect(await inspectContainer(orphanContainer)).toBeUndefined();
    expect(await inspectContainer(foreignOrphanContainer)).toBeDefined();
    expect(existsSync(orphanDirectory)).toBe(false);
    orphanContainer = undefined;
    await removeContainer(foreignOrphanContainer);
    foreignOrphanContainer = undefined;

    const truncated = await service.execute('owner', 'exec_run', {
      workspaceId, command: 'yes x | head -c 5000', cwd: '.', timeoutMs: 10_000, maxOutputBytes: 1_024
    });
    expect(truncated.truncated).toBe(true);
    const startedAt = Date.now();
    const timed = await service.execute('owner', 'exec_run', {
      workspaceId, command: 'sleep 5', cwd: '.', timeoutMs: 100, maxOutputBytes: 65_536
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect((timed.data as { exitCode: number }).exitCode).not.toBe(0);

    const escaped = await service.execute('owner', 'exec_run', {
      workspaceId, command: `node -e "process.stdout.write('\\\\\\\\'.repeat(200000))"`, cwd: '.', timeoutMs: 10_000, maxOutputBytes: 262_144
    });
    expect(escaped.ok).toBe(true);
    expect((escaped.data as { output: string }).output.length).toBe(200_000);

    const name = record!.containerName!;
    await expect(service.execute('owner', 'exec_run', {
      workspaceId, command: `truncate -s ${workspaceCeilingBytes + 1} soft-ceiling-proof.bin`, cwd: '.', timeoutMs: 10_000, maxOutputBytes: 65_536
    })).rejects.toThrow('workspace soft size ceiling exceeded');
    expect(await inspectContainer(name)).toBeUndefined();
    expect(store.byId(workspaceId)?.status).toBe('CLOSED');
    workspaceId = undefined;

    const cancellableWorkspace = await service.execute('owner', 'workspace_open', {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: 'docker-test-abort-workspace', networkMode: 'none'
    });
    workspaceId = (cancellableWorkspace.data as { workspaceId: string }).workspaceId;
    const cancellableRecord = store.byId(workspaceId)!;
    const controller = new AbortController();
    const execution = service.execute('owner', 'exec_run', {
      workspaceId, command: 'sleep 10; printf leaked > aborted-command.txt', cwd: '.', timeoutMs: 15_000, maxOutputBytes: 65_536
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(execution).rejects.toThrow('request cancelled');
    await new Promise((resolve) => setTimeout(resolve, 2_250));
    expect(await inspectContainer(cancellableRecord.containerName!)).toBeDefined();
    expect(store.byId(workspaceId)?.status).toBe('ACTIVE');
    expect(existsSync(cancellableRecord.workspacePath)).toBe(true);
    expect(JSON.stringify((await service.execute('owner', 'files_list', { workspaceId, path: '.', limit: 100 })).data)).not.toContain('aborted-command.txt');
    await service.execute('owner', 'workspace_close', { workspaceId });
    workspaceId = undefined;
  }, 120_000);

  it('enforces 3-zone storage isolation and single-use approval grants for privileged execution', async () => {
    const opened = await service.execute('owner', 'workspace_open', {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: 'docker-test-privilege-workspace', networkMode: 'none'
    });
    expect(opened.ok).toBe(true);
    workspaceId = (opened.data as { workspaceId: string }).workspaceId;
    const testWsId = workspaceId;
    // 1. Verify 3-zone storage mounts, pre-baked toolchain versions, and user-space writability
    const storageCheck = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'test -w /opt/user-tools && test -w /var/cache/harness && test -w /tmp && gh --version && bun --version && uv --version && pnpm --version && wrangler --version && echo "3-zone-writable"',
      cwd: '.'
    });
    expect(JSON.stringify(storageCheck.data)).toContain('3-zone-writable');
    expect(JSON.stringify(storageCheck.data)).toContain('gh version');
    // 2. Unapproved privileged command must be rejected with PRIVILEGE_APPROVAL_REQUIRED
    const unapproved = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'whoami',
      privileged: true
    });
    expect(unapproved.ok).toBe(false);
    expect(unapproved.error?.code).toBe('PRIVILEGE_APPROVAL_REQUIRED');
    const grantId = unapproved.error?.grantRequest?.grantId;
    expect(grantId).toBeDefined();

    const wsRecord = store.byId(testWsId)!;

    // 3. Operator approves the grant
    expect(store.approvePrivilegeGrant(wsRecord.ownerId, grantId!)).toBe(true);

    // 4. Executing with approved grant token runs in privileged ephemeral container
    const approved = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'whoami',
      privileged: true,
      approvalGrantToken: grantId
    });
    expect(approved.ok).toBe(true);
    expect(JSON.stringify(approved.data)).toContain('root');

    // 5. Reusing the consumed grant token must be forbidden
    await expect(service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'whoami',
      privileged: true,
      approvalGrantToken: grantId
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 6. Modified command with valid token must fail hash check
    const unapproved2 = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'id -u',
      privileged: true
    });
    const grantId2 = unapproved2.error?.grantRequest?.grantId;
    expect(store.approvePrivilegeGrant(wsRecord.ownerId, grantId2!)).toBe(true);
    await expect(service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'id -g',
      privileged: true,
      approvalGrantToken: grantId2
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 7. Modified cwd with valid token must fail
    const unapproved3 = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'id -u',
      cwd: '.',
      privileged: true
    });
    const grantId3 = unapproved3.error?.grantRequest?.grantId;
    expect(store.approvePrivilegeGrant(wsRecord.ownerId, grantId3!)).toBe(true);
    await expect(service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'id -u',
      cwd: 'src',
      privileged: true,
      approvalGrantToken: grantId3
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 8. In owner-bearer mode, privileged exec is forbidden
    const ownerBearerService = new WorkspaceService({ ...runnerConfig, authMode: 'owner-bearer' }, store);
    await expect(ownerBearerService.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'whoami',
      privileged: true
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 9. Root execution creating 0700 directory does not break subsequent quota metering or cleanup
    const unapproved4 = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'mkdir -m 0700 root-0700 && touch root-0700/secret.txt',
      cwd: '.',
      privileged: true
    });
    const grantId4 = unapproved4.error?.grantRequest?.grantId;
    expect(store.approvePrivilegeGrant(wsRecord.ownerId, grantId4!)).toBe(true);
    const rootExec = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'mkdir -m 0700 root-0700 && touch root-0700/secret.txt',
      cwd: '.',
      privileged: true,
      approvalGrantToken: grantId4
    });
    expect(rootExec.ok).toBe(true);

    // Standard exec and status still work
    const nextExec = await service.execute('owner', 'exec_run', {
      workspaceId: testWsId,
      command: 'echo "post-root-ok"',
      cwd: '.'
    });
    expect(JSON.stringify(nextExec.data)).toContain('post-root-ok');

    await service.execute('owner', 'workspace_close', { workspaceId: testWsId });
  }, 120_000);

  it('installs and executes real user-space global packages in bridge network mode', async () => {
    const bridgeOpened = await service.execute('owner', 'workspace_open', {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: 'docker-test-npm-bridge-workspace', networkMode: 'bridge'
    });
    expect(bridgeOpened.ok).toBe(true);
    const bridgeWsId = (bridgeOpened.data as { workspaceId: string }).workspaceId;
    try {
      const installResult = await service.execute('owner', 'exec_run', {
        workspaceId: bridgeWsId,
        command: 'npm install -g cowsay',
        cwd: '.',
        timeoutMs: 120_000
      });
      expect(installResult.ok).toBe(true);

      const execResult = await service.execute('owner', 'exec_run', {
        workspaceId: bridgeWsId,
        command: 'cowsay "Verification Passed"',
        cwd: '.',
        timeoutMs: 120_000
      });
      expect(execResult.ok).toBe(true);
      expect(JSON.stringify(execResult.data)).toContain('Verification Passed');
    } finally {
      await service.execute('owner', 'workspace_close', { workspaceId: bridgeWsId }).catch(() => undefined);
    }
  }, 120_000);
});
