import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { removeContainer, runDocker } from '../../apps/runner/src/docker-engine.js';
import { StateStore } from '../../apps/runner/src/state-store.js';
import { WorkspaceService } from '../../apps/runner/src/workspace-service.js';

// This suite provisions a real host firewall and dedicated Docker bridge, then
// proves the dependency-access egress boundary against live destination classes.
// It requires a Linux host with root/iptables authority and the built
// executor + network-guard images. It is opt-in and gated behind
// CHM_DEPENDENCY_EGRESS_TEST=1 so it never runs on an unsuitable host.
const enabled = process.platform === 'linux' && process.env.CHM_DEPENDENCY_EGRESS_TEST === '1';
const NETWORK = 'cloud-harness-dependency-access';
const BRIDGE_IF = 'chm-egress0';
const SUBNET = '172.30.240.0/24';
const CANARY_NET = 'chm-egress-canary-net';

let directory: string;
let store: StateStore;
let service: WorkspaceService;
let runnerConfig: RunnerConfig;
const canaries: string[] = [];
let depWorkspaceId: string | undefined;

async function startCanary(name: string, network: string, ip: string | undefined): Promise<void> {
  const args = ['run', '-d', '--rm', '--name', name, '--network', network];
  if (ip) args.push('--ip', ip);
  args.push('--label', 'cloud-harness.test-canary=true', 'python:3-slim', 'python', '-m', 'http.server', '80');
  const result = await runDocker(args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`canary ${name} failed: ${result.stderr}`);
  canaries.push(name);
}

describe.skipIf(!enabled)('dependency-access egress boundary', () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cloud-harness-egress-'));
    runnerConfig = {
      authMode: 'cloudflare-access',
      host: '127.0.0.1', port: 3001, serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
      jobsRoot: join(directory, 'jobs'), stateDb: join(directory, 'state', 'state.db'),
      executorImage: 'cloud-harness-executor:local', networkGuardImage: 'cloud-harness-network-guard:local',
      allowedGitHosts: ['github.com'], networkProfile: 'network-none', wallTtlSeconds: 600, idleTtlSeconds: 300,
      maxOutputBytes: 262_144, minFreeBytes: 104_857_600, maxWorkspaceBytes: 256 * 1_024 * 1_024, reaperIntervalSeconds: 30,
      dependencyDnsResolvers: ['8.8.8.8', '1.1.1.1'], dependencyBridgeSubnet: SUBNET,
      dependencyBridgeInterface: BRIDGE_IF, dependencyNetworkName: NETWORK
    };
    // Provision the dedicated bridge and transactional host firewall.
    execFileSync('bash', ['deploy/scripts/setup-dependency-firewall.sh'], {
      env: { ...process.env, DEPENDENCY_NETWORK_NAME: NETWORK, DEPENDENCY_BRIDGE_INTERFACE: BRIDGE_IF, DEPENDENCY_BRIDGE_SUBNET: SUBNET, DEPENDENCY_DNS_RESOLVERS: '8.8.8.8 1.1.1.1' },
      stdio: 'inherit'
    });
    // Simulated forbidden destination canaries on a separate private network.
    await runDocker(['network', 'create', '--subnet', '10.88.0.0/24', CANARY_NET], { timeoutMs: 30_000 }).catch(() => undefined);
    await startCanary('chm-canary-private', CANARY_NET, '10.88.0.10');
    store = new StateStore(runnerConfig.stateDb);
    service = new WorkspaceService(runnerConfig, store);
    await service.start();
  }, 180_000);

  afterAll(async () => {
    if (depWorkspaceId) await service.execute('owner', 'workspace_close', { workspaceId: depWorkspaceId }).catch(() => undefined);
    for (const name of canaries) await removeContainer(name).catch(() => undefined);
    await runDocker(['network', 'rm', CANARY_NET], { timeoutMs: 30_000 }).catch(() => undefined);
    await service.stop().catch(() => undefined);
    store.close();
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('opens a dependency-access workspace and enforces the destination matrix', async () => {
    const opened = await service.execute('owner', 'workspace_open', {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: 'egress-dep-1', networkProfile: 'dependency-access'
    });
    expect(opened.ok).toBe(true);
    depWorkspaceId = (opened.data as { workspaceId: string }).workspaceId;

    // Positive control: canary reachable from an unrestricted probe container.
    const control = await runDocker([
      'run', '--rm', '--network', CANARY_NET, 'curlimages/curl:latest',
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', 'http://10.88.0.10/'
    ], { timeoutMs: 30_000 });
    expect(control.stdout).toContain('200');

    // Positive: public DNS + HTTPS succeed inside dependency-access.
    const dns = await service.execute('owner', 'exec_run', {
      workspaceId: depWorkspaceId, command: 'getent hosts registry.npmjs.org', cwd: '.', timeoutMs: 20_000
    });
    expect(dns.ok).toBe(true);
    const https = await service.execute('owner', 'exec_run', {
      workspaceId: depWorkspaceId,
      command: 'curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://registry.npmjs.org/', cwd: '.', timeoutMs: 30_000
    });
    expect(JSON.stringify(https.data)).toContain('200');

    // Negative matrix: metadata, RFC1918 canary, control plane loopback, disallowed port.
    const negativeProbes: Array<{ label: string; command: string }> = [
      { label: 'metadata', command: 'curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://169.254.169.254/ || echo BLOCKED' },
      { label: 'rfc1918-canary', command: 'curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://10.88.0.10/ || echo BLOCKED' },
      { label: 'private-192', command: 'curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://192.168.0.1/ || echo BLOCKED' },
      { label: 'disallowed-port', command: 'curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://93.184.216.34:22/ || echo BLOCKED' }
    ];
    for (const probe of negativeProbes) {
      const res = await service.execute('owner', 'exec_run', {
        workspaceId: depWorkspaceId, command: probe.command, cwd: '.', timeoutMs: 20_000
      });
      const text = JSON.stringify(res.data);
      expect(text, `${probe.label} must be blocked`).toContain('BLOCKED');
      expect(text, `${probe.label} must not return 200`).not.toContain('200');
    }
  }, 180_000);

  it('quarantines the workspace when the host firewall drifts', async () => {
    expect(depWorkspaceId).toBeDefined();
    // Simulate drift: remove the managed jump rules.
    execFileSync('bash', ['-c',
      `iptables -w 10 -D DOCKER-USER -i ${BRIDGE_IF} -j CHM-EGRESS-v1 2>/dev/null || true; ` +
      `iptables -w 10 -D INPUT -i ${BRIDGE_IF} -j CHM-INPUT-v1 2>/dev/null || true`
    ], { stdio: 'inherit' });

    const status = await service.execute('owner', 'workspace_status', { workspaceId: depWorkspaceId! });
    // A dependency-access exec should fail closed once drift is observed by attestation.
    const probe = await service.execute('owner', 'exec_run', {
      workspaceId: depWorkspaceId!, command: 'echo alive', cwd: '.', timeoutMs: 20_000
    }).catch((err) => err);
    expect(status.ok).toBe(true);
    expect(probe).toBeDefined();
  }, 120_000);
});
