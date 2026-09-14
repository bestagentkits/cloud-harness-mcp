import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { MetadataStore } from '../src/metadata-store.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { randomBytes } from 'node:crypto';
import { executeInternalRunnerOperation } from '../src/internal-runner-operations.js';
import { StateStore, type WorkspaceRecord } from '../src/state-store.js';
import { WorkspaceService } from '../src/workspace-service.js';

const temporaryDirectories: string[] = [];
const openMetadataStores: MetadataStore[] = [];
afterEach(() => {
  for (const metadata of openMetadataStores.splice(0)) metadata.database.close();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-internal-operations-'));
  temporaryDirectories.push(directory);
  const jobsRoot = join(directory, 'jobs');
  const workspacePath = join(jobsRoot, `ws_${'a'.repeat(24)}`);
  mkdirSync(join(workspacePath, 'repo'), { recursive: true });
  const config = { jobsRoot, stateDb: join(directory, 'state.db'), networkProfile: 'dependency-access' } as RunnerConfig;
  const store = new StateStore(config.stateDb);
  const principal = { kind: 'external' as const, issuer: 'https://access.example.com', subject: 'owner' };
  const ownerId = store.resolvePrincipal(principal);
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: `ws_${'a'.repeat(24)}`, ownerId, idempotencyKey: 'dashboard-workspace',
    repositoryUrl: 'https://github.com/example/repo.git', repositoryRef: null,
    containerName: null, workspacePath, status: 'ACTIVE', networkProfile: 'network-none',
    createdAt: now, lastActivityAt: now, expiresAt: now + 60_000, generation: 4, error: null
  };
  store.create(record);
  const metadata = new MetadataStore(config.stateDb, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
  openMetadataStores.push(metadata);
  return { principal, record, store, metadata, service: new WorkspaceService(config, store, metadata) };
}

describe('internal runner operations', () => {
  it('returns a safe workspace detail with a generation fence', async () => {
    const { principal, record, service, store } = fixture();
    try {
      const result = await executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_detail', input: { workspaceId: record.id }
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ workspaceId: record.id, generation: 4, repositoryUrl: record.repositoryUrl });
      expect(result.data).not.toHaveProperty('ownerId');
      expect(result.data).not.toHaveProperty('containerName');
      expect(result.data).not.toHaveProperty('workspacePath');
    } finally { store.close(); }
  });

  it('never closes a newer lifecycle with a stale generation', async () => {
    const { principal, record, service, store } = fixture();
    try {
      await expect(executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_close_fenced',
        input: { workspaceId: record.id, expectedGeneration: record.generation - 1 }
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(store.byId(record.id)).toMatchObject({ status: 'ACTIVE', generation: 4 });
    } finally { store.close(); }
  });

  it('closes only after claiming the exact generation', async () => {
    const { principal, record, service, store } = fixture();
    try {
      const result = await executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_close_fenced',
        input: { workspaceId: record.id, expectedGeneration: record.generation }
      });
      expect(result.ok).toBe(true);
      expect(store.byId(record.id)).toMatchObject({ status: 'CLOSED', generation: record.generation + 1 });
    } finally { store.close(); }
  });

  it('reports an expired lifecycle without attempting another close', async () => {
    const { principal, record, service, store } = fixture();
    try {
      store.update(record.id, { status: 'CLOSED', generation: record.generation + 1, expiresAt: Date.now() });
      await expect(executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'workspace_close_fenced',
        input: { workspaceId: record.id, expectedGeneration: record.generation }
      })).rejects.toMatchObject({ code: 'EXPIRED' });
      expect(store.byId(record.id)).toMatchObject({ status: 'CLOSED', generation: record.generation + 1 });
    } finally { store.close(); }
  });

  it('persists an instance network default and resets it to the runner default', async () => {
    const { principal, service, store, metadata } = fixture();
    try {
      const initial = await executeInternalRunnerOperation(service, { version: 2, principal, operation: 'settings_get', input: {} });
      expect(initial.data).toMatchObject({ defaultNetworkProfile: { value: 'dependency-access', source: 'environment' } });

      const updated = await executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'settings_update', input: { defaultNetworkProfile: 'network-none' }
      });
      expect(updated.data).toMatchObject({ defaultNetworkProfile: { value: 'network-none', source: 'setting' } });
      expect(store.getWorkspaceDefaultNetworkProfile()).toBe('network-none');

      const reset = await executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'settings_update', input: { defaultNetworkProfile: null }
      });
      expect(reset.data).toMatchObject({ defaultNetworkProfile: { value: 'dependency-access', source: 'environment' } });
      expect(store.getWorkspaceDefaultNetworkProfile()).toBeUndefined();

      // An instance-wide posture change must leave an operator-visible trail that
      // records the transition without a probe or credential value.
      const audits = metadata.listAudit(store.resolvePrincipal(principal), 10)
        .filter((entry) => entry.action === 'settings.default_network_profile.changed');
      expect(audits).toHaveLength(2);
      // Newest first: the reset, then the value it replaced.
      expect(audits[0]!.details).toMatchObject({ previous: 'network-none', next: 'runner-default' });
      expect(audits[1]!.details).toMatchObject({ previous: 'runner-default', next: 'network-none' });
      expect(audits[1]!.subjectType).toBe('instance');
      expect(JSON.stringify(audits)).not.toContain('firewall');
    } finally { store.close(); }
  });

  it('refuses an exposure-only profile as an instance default', async () => {
    const { principal, service, store } = fixture();
    try {
      await expect(executeInternalRunnerOperation(service, {
        version: 2, principal, operation: 'settings_update', input: { defaultNetworkProfile: 'local-host' }
      })).rejects.toBeTruthy();
      expect(store.getWorkspaceDefaultNetworkProfile()).toBeUndefined();
    } finally { store.close(); }
  });

  it('reports dependency egress readiness without starting a workspace', async () => {
    const { principal, service, store } = fixture();
    try {
      service.networkProfileManager.checkAttestation = async () => ({ ok: false, reason: 'host firewall is not attested' });
      const unavailable = await executeInternalRunnerOperation(service, { version: 2, principal, operation: 'settings_network_check', input: {} });
      expect(unavailable.data).toEqual({ ready: false, reason: 'host firewall is not attested' });

      service.networkProfileManager.checkAttestation = async () => ({ ok: true });
      const ready = await executeInternalRunnerOperation(service, { version: 2, principal, operation: 'settings_network_check', input: {} });
      expect(ready.data).toEqual({ ready: true, reason: null });
      expect(store.list(store.resolvePrincipal(principal))).toHaveLength(1);
    } finally { store.close(); }
  });
});
