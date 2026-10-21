import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerResponse } from '@cloud-harness/contracts';
import { LocalWorkerClient } from '../../api/src/local/local-worker-client.js';
import { withHookActivationState } from '../src/hook-activation-state.js';
import type { HookActivationRecord } from '../src/state-store.js';

const NOW = 1_800_000_000_000;
const CURRENT = 'a'.repeat(64);
const STALE = 'b'.repeat(64);

const activation = (overrides: Partial<HookActivationRecord> = {}): HookActivationRecord => ({
  principalId: 'p_owner',
  workspaceId: 'ws_1',
  event: 'pre_commit',
  manifestSha256: CURRENT,
  createdAt: NOW - 1_000,
  expiresAt: NOW + 60_000,
  ...overrides
});

const listing = (manifestSha256: string | null = CURRENT): RunnerResponse => ({
  ok: true,
  message: 'Found 3 hooks',
  truncated: false,
  data: {
    ...(manifestSha256 ? { manifestSha256 } : {}),
    hooks: [
      { name: 'lint', events: ['pre_commit'], failurePolicy: 'block', order: 10 },
      { name: 'notify', events: ['post_commit'], failurePolicy: 'warn', order: 20 },
      { name: 'setup', events: ['on_workspace_open', 'pre_commit'], failurePolicy: 'warn', order: 30 }
    ]
  }
});

const activeByName = (response: RunnerResponse): Record<string, unknown> =>
  Object.fromEntries(((response.data as { hooks: Array<{ name: string; active?: unknown }> }).hooks).map((hook) => [hook.name, hook.active]));

describe('hook activation state', () => {
  it('reports a hook active when an unexpired activation for one of its events pins the current digest', () => {
    const result = withHookActivationState(listing(), [activation()], NOW);
    expect(activeByName(result)).toEqual({ lint: true, notify: false, setup: true });
  });

  it('reports a hook inactive when its activation pins a different manifest digest', () => {
    const result = withHookActivationState(listing(), [activation({ manifestSha256: STALE })], NOW);
    expect(activeByName(result)).toEqual({ lint: false, notify: false, setup: false });
  });

  it('reports a hook inactive when its activation has expired', () => {
    const result = withHookActivationState(listing(), [activation({ expiresAt: NOW })], NOW);
    expect(activeByName(result)).toEqual({ lint: false, notify: false, setup: false });
  });

  it('reports a hook inactive when only an unrelated event is activated', () => {
    const result = withHookActivationState(listing(), [activation({ event: 'post_checkout' })], NOW);
    expect(activeByName(result)).toEqual({ lint: false, notify: false, setup: false });
  });

  it('reports every hook inactive when the listing has no manifest digest', () => {
    const result = withHookActivationState(listing(null), [activation()], NOW);
    expect(activeByName(result)).toEqual({ lint: false, notify: false, setup: false });
  });

  it('keeps every hook and its other fields, the digest and the cursor', () => {
    const source = { ...listing(), cursor: '3' };
    const result = withHookActivationState(source, [activation()], NOW);
    expect(result.cursor).toBe('3');
    expect((result.data as { manifestSha256: string }).manifestSha256).toBe(CURRENT);
    expect((result.data as { hooks: unknown[] }).hooks[0]).toEqual({ name: 'lint', events: ['pre_commit'], failurePolicy: 'block', order: 10, active: true });
    // The worker response is not mutated.
    expect((source.data as { hooks: Array<Record<string, unknown>> }).hooks[0]).not.toHaveProperty('active');
  });

  it('passes failed and malformed responses through unchanged', () => {
    const failed: RunnerResponse = { ok: false, message: 'boom', truncated: false, error: { code: 'INTERNAL', message: 'boom', retryable: false } };
    expect(withHookActivationState(failed, [activation()], NOW)).toBe(failed);
    const malformed: RunnerResponse = { ok: true, message: 'odd', truncated: false, data: { hooks: 'nope' } };
    expect(withHookActivationState(malformed, [activation()], NOW)).toBe(malformed);
  });

  it('matches activations against the digest the worker computes for the manifest', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hooks-active-'));
    try {
      await mkdir(join(tmp, '.cloud-harness'), { recursive: true });
      await writeFile(join(tmp, '.cloud-harness', 'hooks.json'), JSON.stringify({
        version: 1,
        hooks: [
          { name: 'lint', events: ['pre_commit'], argv: ['node', '-e', '0'] },
          { name: 'notify', events: ['post_commit'], argv: ['node', '-e', '0'] }
        ]
      }));
      const response = await new LocalWorkerClient(tmp).call('hooks_list', {});
      const digest = (response.data as { manifestSha256: string }).manifestSha256;
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      const result = withHookActivationState(response, [activation({ manifestSha256: digest, expiresAt: Date.now() + 60_000 })]);
      expect(activeByName(result)).toEqual({ lint: true, notify: false });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
