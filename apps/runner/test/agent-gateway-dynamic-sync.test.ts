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
});
