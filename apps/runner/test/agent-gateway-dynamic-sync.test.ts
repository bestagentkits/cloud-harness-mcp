import { describe, expect, it, vi } from 'vitest';
import { DockerAgentGatewayControl } from '../src/agent-gateway-control.js';
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

    it.each([
      ['a negative counter', { ...settlement, costMicros: -1 }],
      ['an unknown field', { ...settlement, refundMicros: 5 }],
      ['a missing counter', { ...settlement, requestsWithoutUsage: undefined }],
      ['another lease', { ...settlement, leaseId: 'lease_bbbbbbbbbbbbbbbbbbbbbbbb' }]
    ])('refuses a settlement with %s', async (_label, invalid) => {
      const spy = respond({ ok: true, revoked: true, gatewayBootId: 'boot-1', settlement: invalid });
      await expect(new DockerAgentGatewayControl('mock-gateway-container').revokeAndDrain(leaseId))
        .rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'model gateway returned an invalid lease settlement' });
      spy.mockRestore();
    });
  });
});
