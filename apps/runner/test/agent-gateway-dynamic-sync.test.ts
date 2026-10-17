import { describe, expect, it, vi } from 'vitest';
import { DockerAgentGatewayControl, GatewayControlRejection, isDefiniteIssueRefusal } from '../src/agent-gateway-control.js';
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

    // 1. Apply snapshot
    const ack = await control.applySnapshot({
      generation: 1,
      sequence: 1,
      credentials: {
        cred_1: { provider: 'openai', authMode: 'bearer', secret: 'sk-secret-123' }
      },
      profiles: {
        rev_1: { model: 'gpt-5.2' }
      }
    });

    expect(ack.gatewayBootId).toBe('boot_mock_123');
    expect(ack.snapshotDigest).toBe('sha256:digest123');

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
