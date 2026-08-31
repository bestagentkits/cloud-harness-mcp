import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkerClient } from '../../api/src/local/local-worker-client.js';
import { StateStore } from '../src/state-store.js';

describe('declarative hooks and sandbox execution', () => {
  it('parses declarative JSON hooks and filters by event', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hooks-json-'));
    try {
      await mkdir(join(tmp, '.cloud-harness'), { recursive: true });
      const config = {
        version: 1,
        hooks: [
          {
            name: 'lint',
            events: ['pre_commit'],
            argv: ['node', '-e', 'console.log("linting")'],
            failurePolicy: 'block',
            order: 10
          },
          {
            name: 'notify',
            events: ['post_commit'],
            argv: ['node', '-e', 'console.log("notified")'],
            failurePolicy: 'warn',
            order: 20
          }
        ]
      };
      await writeFile(join(tmp, '.cloud-harness', 'hooks.json'), JSON.stringify(config, null, 2));

      const client = new LocalWorkerClient(tmp);

      // List all
      const listAll = await client.call('hooks_list', {});
      expect(listAll.ok).toBe(true);
      const allHooks = (listAll.data as any).hooks;
      expect(allHooks.length).toBe(2);

      // Filter by pre_commit
      const listPre = await client.call('hooks_list', { event: 'pre_commit' });
      expect(listPre.ok).toBe(true);
      const preHooks = (listPre.data as any).hooks;
      expect(preHooks.length).toBe(1);
      expect(preHooks[0].name).toBe('lint');
      expect(preHooks[0].failurePolicy).toBe('block');
      expect(preHooks[0].provenance.source).toBe('repository');

      // Run hook with matching manifest digest
      const manifestSha = (listAll.data as any).manifestSha256;
      const runRes = await client.call('hooks_run', {
        name: 'lint',
        expectedManifestSha256: manifestSha
      });
      expect(runRes.ok).toBe(true);
      expect((runRes.data as any).exitCode).toBe(0);
      expect((runRes.data as any).output).toContain('linting');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects hook execution when manifest digest does not match (TOCTOU protection)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hooks-digest-'));
    try {
      await mkdir(join(tmp, '.cloud-harness'), { recursive: true });
      const config = {
        version: 1,
        hooks: [
          {
            name: 'test',
            events: ['pre_commit'],
            argv: ['node', '-e', 'console.log("clean")']
          }
        ]
      };
      await writeFile(join(tmp, '.cloud-harness', 'hooks.json'), JSON.stringify(config, null, 2));

      const client = new LocalWorkerClient(tmp);
      const listRes = await client.call('hooks_list', {});
      const initialSha = (listRes.data as any).manifestSha256;

      // Tamper with hooks.json
      config.hooks[0].argv = ['node', '-e', 'console.log("tampered")'];
      await writeFile(join(tmp, '.cloud-harness', 'hooks.json'), JSON.stringify(config, null, 2));

      // Attempt to run with old digest -> MUST fail with CONFLICT
      const runRes = await client.call('hooks_run', {
        name: 'test',
        expectedManifestSha256: initialSha
      });
      expect(runRes.ok).toBe(false);
      expect(runRes.error?.code).toBe('CONFLICT');
      expect(runRes.error?.message).toContain('mismatch');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('supports legacy string-map format as manual hooks for backward compatibility', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hooks-legacy-'));
    try {
      await mkdir(join(tmp, '.cloud-harness'), { recursive: true });
      const config = {
        build: 'echo "building"',
        format: 'echo "formatting"'
      };
      await writeFile(join(tmp, '.cloud-harness', 'hooks.json'), JSON.stringify(config, null, 2));

      const client = new LocalWorkerClient(tmp);
      const listRes = await client.call('hooks_list', {});
      expect(listRes.ok).toBe(true);
      const hooks = (listRes.data as any).hooks;
      expect(hooks.length).toBe(2);
      expect(hooks.some((h: any) => h.name === 'build')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('manages hook activations in StateStore', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hooks-act-'));
    const store = new StateStore(join(tmp, 'state.db'));
    try {
      store.database.prepare(`
        INSERT OR IGNORE INTO principals (id, issuer, subject, email, name, created_at, updated_at)
        VALUES ('p_user1', 'https://auth.example.com', 'user1', 'u1@example.com', 'User 1', 1000, 1000)
      `).run();
      store.database.prepare(`
        INSERT OR IGNORE INTO workspaces
        (id, owner_id, idempotency_key, repository_url, workspace_path, status, network_profile, created_at, last_activity_at, expires_at, generation)
        VALUES ('ws_1', 'p_user1', 'idem_1', 'https://github.com/example/repo', '/tmp/ws1', 'ACTIVE', 'network-none', 1000, 1000, 9999999999, 1)
      `).run();
      const act = store.activateHook({
        principalId: 'p_user1',
        workspaceId: 'ws_1',
        event: 'pre_commit',
        manifestSha256: 'a'.repeat(64)
      });
      expect(act.event).toBe('pre_commit');
      expect(act.manifestSha256).toBe('a'.repeat(64));

      const activeList = store.getActiveHookActivations('p_user1', 'ws_1');
      expect(activeList.length).toBe(1);
      expect(activeList[0].manifestSha256).toBe('a'.repeat(64));

      // Deactivate
      store.deactivateHook({ principalId: 'p_user1', workspaceId: 'ws_1', event: 'pre_commit' });
      expect(store.getActiveHookActivations('p_user1', 'ws_1').length).toBe(0);

    } finally {
      try { store.close(); } catch { /* ignore */ }
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns ok: false when hook process exits with nonzero status', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hooks-fail-'));
    try {
      await mkdir(join(tmp, '.cloud-harness'), { recursive: true });
      const config = {
        version: 1,
        hooks: [
          {
            name: 'failing-check',
            events: ['pre_commit'],
            argv: ['node', '-e', 'console.error("syntax error"); process.exit(2)'],
            failurePolicy: 'block'
          }
        ]
      };
      await writeFile(join(tmp, '.cloud-harness', 'hooks.json'), JSON.stringify(config, null, 2));

      const client = new LocalWorkerClient(tmp);
      const listRes = await client.call('hooks_list', {});
      const manifestSha = (listRes.data as any).manifestSha256;

      const runRes = await client.call('hooks_run', {
        name: 'failing-check',
        expectedManifestSha256: manifestSha
      });
      expect(runRes.ok).toBe(false);
      expect(runRes.error?.code).toBe('EXECUTION_FAILED');
      expect(runRes.error?.message).toContain('Hook exited with 2');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
