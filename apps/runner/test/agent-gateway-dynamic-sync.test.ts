import { describe, expect, it, vi } from 'vitest';
import { DockerAgentGatewayControl, GatewayControlRejection, gatewaySnapshotDigest, isDefiniteIssueRefusal, type GatewaySnapshot } from '../src/agent-gateway-control.js';
import * as dockerEngine from '../src/docker-engine.js';

describe('Runner AgentGatewayControl Dynamic Sync', () => {
  it('sends framed snapshot payload via stdin to gateway container and receives ack', async () => {
    const runDockerSpy = vi.spyOn(dockerEngine, 'runDocker').mockImplementation(async (_args, options) => {
      if (options?.stdin?.includes('apply_snapshot')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            ack: {
              type: 'ack',
              sequence: 1,
              generation: 1,
              gatewayBootId: 'boot_mock_123',
              snapshotDigest: 'sha256:digest123',
              activeProfileCount: 2,
              activeCredentialCount: 1
            }
          }),
          stderr: ''
        };
      }
      if (options?.stdin?.includes('digest')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            digest: {
              gatewayBootId: 'boot_mock_123',
              snapshotDigest: 'sha256:digest123',
              activeProfileCount: 2,
              activeCredentialCount: 1,
              activeLeaseCount: 0
            }
          }),
          stderr: ''
        };
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    });

    const control = new DockerAgentGatewayControl('mock-gateway-container');

    // 1. Push a snapshot
    const ack = await control.syncSnapshot(() => ({
      generation: 1,
      sequence: 1,
      credentials: {
        cred_1: { provider: 'openai', authMode: 'bearer', secret: 'sk-secret-123' }
      },
      profiles: {
        rev_1: { model: 'gpt-5.2' }
      }
    }), { onlyIfMismatch: false });

    expect(ack.gatewayBootId).toBe('boot_mock_123');
    expect(ack.gatewayDigest).toBe('sha256:digest123');

    // 2. Query digest
    const digest = await control.queryDigest();
    expect(digest.gatewayBootId).toBe('boot_mock_123');
    expect(digest.activeProfileCount).toBe(2);

    runDockerSpy.mockRestore();
  });

  describe('lease issue and revoke', () => {
    const leaseId = 'lease_aaaaaaaaaaaaaaaaaaaaaaaa';
    const issueInput = {
      leaseId, agentId: `agent_${'a'.repeat(24)}`, profileId: 'default', ttlMs: 30_000,
      maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000
    };
    const settlement = {
      leaseId, reason: 'revoked', settledAt: 1_700_000_000_000, initialInputTokens: 10_000, initialOutputTokens: 2_000,
      initialCostMicros: 1_000_000, costMicros: 1_200, overrunCostMicros: 0, promptTokens: 900, cacheReadTokens: 400,
      cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 20, requests: 2, requestsWithoutUsage: 0
    };

    function respond(body: Record<string, unknown>) {
      return vi.spyOn(dockerEngine, 'runDocker').mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(body), stderr: '' });
    }

    it('reads the issuing gateway boot id, and tolerates an older gateway that omits it', async () => {
      const control = new DockerAgentGatewayControl('mock-gateway-container');
      const lease = 'L'.repeat(64);
      const spy = respond({ ok: true, lease, gatewayBootId: 'boot-1' });
      await expect(control.issue(issueInput)).resolves.toEqual({ ...issueInput, lease, gatewayBootId: 'boot-1' });
      spy.mockRestore();
      const older = respond({ ok: true, lease });
      await expect(control.issue(issueInput)).resolves.toEqual({ ...issueInput, lease });
      older.mockRestore();
    });

    it('marks only an explicit gateway refusal as a definite rejection', async () => {
      const control = new DockerAgentGatewayControl('mock-gateway-container');
      const refused = respond({ ok: false, error: 'unknown profile' });
      const refusal = await control.issue(issueInput).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(GatewayControlRejection);
      expect(refusal).toMatchObject({ code: 'UNAVAILABLE', message: 'model gateway rejected control request: unknown profile' });
      refused.mockRestore();
      const ambiguous: Array<{ exitCode: number; stdout: string }> = [
        { exitCode: 1, stdout: '' },
        { exitCode: 0, stdout: 'not json' },
        { exitCode: 0, stdout: '{}' },
        { exitCode: 0, stdout: 'null' }
      ];
      for (const answer of ambiguous) {
        const spy = vi.spyOn(dockerEngine, 'runDocker').mockResolvedValue({ ...answer, stderr: '' });
        const error = await control.issue(issueInput).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'UNAVAILABLE' });
        expect(error).not.toBeInstanceOf(GatewayControlRejection);
        spy.mockRestore();
      }
    });

    it('returns the frozen settlement and boot id from a revoke', async () => {
      const spy = respond({ ok: true, revoked: true, gatewayBootId: 'boot-1', settlement });
      await expect(new DockerAgentGatewayControl('mock-gateway-container').revokeAndDrain(leaseId))
        .resolves.toEqual({ revoked: true, gatewayBootId: 'boot-1', settlement });
      spy.mockRestore();
    });

    it('tolerates an older gateway that answers a revoke without the additive fields', async () => {
      const spy = respond({ ok: true });
      await expect(new DockerAgentGatewayControl('mock-gateway-container').revokeAndDrain(leaseId)).resolves.toEqual({ revoked: false });
      spy.mockRestore();
    });

    it('strips unknown settlement fields so a newer gateway still settles', async () => {
      const spy = respond({ ok: true, revoked: true, gatewayBootId: 'boot-1', settlement: { ...settlement, refundMicros: 5 } });
      await expect(new DockerAgentGatewayControl('mock-gateway-container').revokeAndDrain(leaseId))
        .resolves.toEqual({ revoked: true, gatewayBootId: 'boot-1', settlement });
      spy.mockRestore();
    });

    it.each([
      ['a negative counter', { settlement: { ...settlement, costMicros: -1 } }],
      ['a fractional counter', { settlement: { ...settlement, costMicros: 1.5 } }],
      ['an implausibly large cost', { settlement: { ...settlement, costMicros: 10_000_000_000_001 } }],
      ['an implausibly large overrun', { settlement: { ...settlement, overrunCostMicros: 10_000_000_000_001 } }],
      ['a missing counter', { settlement: { ...settlement, requestsWithoutUsage: undefined } }],
      ['another lease', { settlement: { ...settlement, leaseId: 'lease_bbbbbbbbbbbbbbbbbbbbbbbb' } }],
      ['an unreadable boot id', { settlement, gatewayBootId: 7 }],
      ['a settlement that is not an object', { settlement: 'settled' }]
    ])('marks a settlement with %s invalid instead of failing the revoke', async (_label, answer) => {
      const spy = respond({ ok: true, revoked: true, gatewayBootId: 'boot-1', ...answer });
      const revocation = await new DockerAgentGatewayControl('mock-gateway-container').revokeAndDrain(leaseId);
      expect(revocation).toMatchObject({ revoked: true, settlementInvalid: true });
      expect(revocation).not.toHaveProperty('settlement');
      spy.mockRestore();
    });

    it('treats a refusal of an already registered lease id as ambiguous, because that lease exists', async () => {
      const control = new DockerAgentGatewayControl('mock-gateway-container');
      const spy = respond({ ok: false, error: 'leaseId already registered' });
      const error = await control.issue(issueInput).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GatewayControlRejection);
      expect(isDefiniteIssueRefusal(error)).toBe(false);
      spy.mockRestore();
      const refused = respond({ ok: false, error: 'unknown profile' });
      expect(isDefiniteIssueRefusal(await control.issue(issueInput).catch((caught: unknown) => caught))).toBe(true);
      refused.mockRestore();
      expect(isDefiniteIssueRefusal(new Error('model gateway control request failed'))).toBe(false);
    });
  });
});

describe('gateway snapshot push state', () => {
  const ack = JSON.stringify({ ok: true, ack: { gatewayBootId: 'boot_1', snapshotDigest: 'sha256:a' } });
  const snapshot = { credentials: {}, profiles: {} };
  const push = (control: DockerAgentGatewayControl) => control.syncSnapshot(() => snapshot, { onlyIfMismatch: false });

  it('keeps the last successful push time, reports a later failure, and clears it on the next success', async () => {
    let clock = 1_000;
    let fail = false;
    const spy = vi.spyOn(dockerEngine, 'runDocker').mockImplementation(async () =>
      fail ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: ack, stderr: '' });
    const control = new DockerAgentGatewayControl('gateway', () => clock);
    expect(control.snapshotPushState()).toEqual({ lastSuccessAt: null, lastError: null });

    await push(control);
    expect(control.snapshotPushState()).toEqual({ lastSuccessAt: 1_000, lastError: null });

    clock = 2_000; fail = true;
    await expect(push(control)).rejects.toThrow('model gateway control request failed');
    expect(control.snapshotPushState()).toEqual({ lastSuccessAt: 1_000, lastError: 'model gateway control request failed' });

    clock = 3_000; fail = false;
    await push(control);
    expect(control.snapshotPushState()).toEqual({ lastSuccessAt: 3_000, lastError: null });
    spy.mockRestore();
  });

  it('serializes pushes, builds each snapshot after the previous push landed, and keeps going after a failure', async () => {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    let calls = 0;
    const spy = vi.spyOn(dockerEngine, 'runDocker').mockImplementation(async () => {
      calls += 1;
      const call = calls;
      order.push(`push ${call} started`);
      if (call === 1) await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`push ${call} settled`);
      return call === 1 ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: ack, stderr: '' };
    });
    const control = new DockerAgentGatewayControl('gateway', () => 7_000);
    let state = 'old';
    const first = control.syncSnapshot(() => { order.push(`build ${state}`); return snapshot; }, { onlyIfMismatch: false });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = control.syncSnapshot(() => { order.push(`build ${state}`); return snapshot; }, { onlyIfMismatch: false });
    // The second sync has not built its snapshot yet, so a change made now is the one it pushes.
    state = 'new';
    releases[0]!();
    await expect(first).rejects.toThrow('model gateway control request failed');
    await expect(second).resolves.toMatchObject({ pushed: true, gatewayDigest: 'sha256:a' });
    expect(order).toEqual(['build old', 'push 1 started', 'push 1 settled', 'build new', 'push 2 started', 'push 2 settled']);
    expect(control.snapshotPushState()).toEqual({ lastSuccessAt: 7_000, lastError: null });
    spy.mockRestore();
  });

  describe('coalescing', () => {
    const current = { credentials: {}, profiles: { rev_current: { model: 'current' } } };
    const stale = { credentials: {}, profiles: { rev_stale: { model: 'stale' } } };

    /** A gateway whose first control request waits for release, recording every operation. */
    function gateway() {
      const operations: string[] = [];
      const releases: Array<() => void> = [];
      let held = false;
      let applied = 'sha256:none';
      const spy = vi.spyOn(dockerEngine, 'runDocker').mockImplementation(async (_args, options) => {
        const command = JSON.parse(options?.stdin ?? '{}') as { operation: string };
        operations.push(command.operation);
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        if (command.operation === 'digest') {
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, digest: { gatewayBootId: 'boot_1', snapshotDigest: applied, activeProfileCount: 0, activeCredentialCount: 0, activeLeaseCount: 0 } }), stderr: '' };
        }
        applied = gatewaySnapshotDigest(command as unknown as GatewaySnapshot);
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, ack: { gatewayBootId: 'boot_1', snapshotDigest: applied } }), stderr: '' };
      });
      return { spy, operations, releases };
    }

    it('joins a queued section that has not started, so callers share one section built from the latest state', async () => {
      const { spy, operations, releases } = gateway();
      const control = new DockerAgentGatewayControl('gateway', () => 1);
      const builds: string[] = [];
      const inFlight = control.syncSnapshot(() => { builds.push('in flight'); return stale; }, { onlyIfMismatch: false });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      const queried: string[] = [];
      const first = control.syncSnapshot(() => { builds.push('first joiner'); return stale; }, { onlyIfMismatch: true, onQueried: () => queried.push('first') });
      const second = control.syncSnapshot(() => { builds.push('second joiner'); return current; }, { onlyIfMismatch: true, onQueried: () => queried.push('second') });
      const third = control.syncSnapshot(() => { builds.push('third joiner'); return current; }, { onlyIfMismatch: true });
      releases[0]!();
      await inFlight;
      const results = await Promise.all([first, second, third]);
      // One pending section ran once, with the latest builder, and every joined caller got its result.
      expect(builds).toEqual(['in flight', 'third joiner']);
      expect(operations).toEqual(['apply_snapshot', 'digest', 'apply_snapshot']);
      expect(queried).toEqual(['first', 'second']);
      const expectedDigest = gatewaySnapshotDigest(current);
      for (const result of results) {
        expect(result).toEqual({ gatewayBootId: 'boot_1', gatewayDigest: expectedDigest, expectedDigest, pushed: true });
      }
      // Once that section started, a new sync queues a fresh section instead of joining it.
      await expect(control.syncSnapshot(() => current, { onlyIfMismatch: true })).resolves.toMatchObject({ pushed: false });
      expect(operations).toEqual(['apply_snapshot', 'digest', 'apply_snapshot', 'digest']);
      spy.mockRestore();
    });

    it('upgrades a pending mismatch-only section to a forced push when a forced sync joins it', async () => {
      const { spy, operations, releases } = gateway();
      const control = new DockerAgentGatewayControl('gateway', () => 1);
      const inFlight = control.syncSnapshot(() => current, { onlyIfMismatch: false });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      // The gateway will already hold this snapshot, so the check alone would push nothing.
      const check = control.syncSnapshot(() => current, { onlyIfMismatch: true });
      const forced = control.syncSnapshot(() => current, { onlyIfMismatch: false });
      releases[0]!();
      await inFlight;
      const [checked, pushed] = await Promise.all([check, forced]);
      expect(operations).toEqual(['apply_snapshot', 'apply_snapshot']);
      expect(checked).toMatchObject({ pushed: true });
      expect(pushed).toEqual(checked);
      spy.mockRestore();
    });

    it('rejects every joined caller when the shared section fails, and the next section still runs', async () => {
      const { spy, releases } = gateway();
      const control = new DockerAgentGatewayControl('gateway', () => 1);
      const inFlight = control.syncSnapshot(() => current, { onlyIfMismatch: false });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      const failing = () => { throw new Error('snapshot build failed'); };
      const first = control.syncSnapshot(failing, { onlyIfMismatch: false });
      const second = control.syncSnapshot(failing, { onlyIfMismatch: false });
      releases[0]!();
      await inFlight;
      await expect(first).rejects.toThrow('snapshot build failed');
      await expect(second).rejects.toThrow('snapshot build failed');
      await expect(control.syncSnapshot(() => current, { onlyIfMismatch: true })).resolves.toMatchObject({ pushed: false });
      spy.mockRestore();
    });
  });
});
