import { describe, expect, it } from 'vitest';
import {
  AgentIdSchema,
  AgentStatusDataSchema,
  AgentProxyOperationSchema,
  ApiConfigSchema,
  RunnerConfigSchema,
  TOOL_SCHEMA_BY_NAME,
  TOOL_SPECS,
  WorkspaceIdSchema
} from '../src/index.js';


const workspaceId = `ws_${'a'.repeat(24)}`;
const agentId = `agent_${'b'.repeat(24)}`;
const runnerConfig = {
  serviceToken: 'runner-token-that-is-longer-than-32-characters',
  jobsRoot: '/tmp/jobs',
  stateDb: '/tmp/state.db',
  executorImage: 'executor',
  allowedGitHosts: ['github.com']
};
const profile = {
  id: 'default',
  displayName: 'Default profile',
  provider: 'test-provider',
  model: 'test-model',
  inputMicrosPerMillionTokens: 1,
  outputMicrosPerMillionTokens: 2,
  maxInputTokens: 100_000,
  maxOutputTokens: 10_000,
  maxCostMicros: 1_000_000,
  maxProxyOperations: ['files_read', 'files_apply_patch']
};
describe('contracts', () => {
  it('rejects path traversal and malformed handles', () => {
    expect(() => TOOL_SCHEMA_BY_NAME.files_read.parse({ workspaceId: 'ws_123', path: '../secret' })).toThrow();
    expect(() => WorkspaceIdSchema.parse('workspace-1')).toThrow();
  });

  it('rejects placeholder secrets', () => {
    expect(() => ApiConfigSchema.parse({ bearerToken: 'change-me-at-least-32-random-characters', runnerToken: 'another-token-that-is-long-enough-1234', runnerUrl: 'http://runner:3001', publicHosts: ['localhost'] })).toThrow();
  });

  it('rejects option-shaped Git arguments and incomplete branch mutations', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    expect(() => TOOL_SCHEMA_BY_NAME.git_checkout.parse({ workspaceId, ref: '--help', create: false })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_fetch.parse({ workspaceId, remote: '--upload-pack=evil' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_branch.parse({ workspaceId, action: 'delete', force: false })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: ':refs/heads/main' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'main:refs/heads/main', forceWithLease: true })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'main', forceWithLease: true, expectedRemoteOid: 'a'.repeat(40) })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, forceWithLease: false, expectedRemoteOid: 'a'.repeat(40) })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_rebase.parse({ workspaceId, action: 'start' })).toThrow();
  });

  it('rejects workspace-root file mutations and validates dependency handles', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    expect(() => TOOL_SCHEMA_BY_NAME.files_delete.parse({ workspaceId, path: '.', recursive: true })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.files_move.parse({ workspaceId, source: '.', destination: 'moved', overwrite: false })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.tasks_run.parse({ workspaceId, command: 'true', idempotencyKey: 'task-test', dependsOn: ['task_invalid'] })).toThrow();
  });

  it('bounds opaque agent handles and every agent operation input', () => {
    expect(() => AgentIdSchema.parse(agentId)).not.toThrow();
    expect(() => AgentIdSchema.parse(`agent_${'x'.repeat(19)}`)).toThrow();
    expect(AgentProxyOperationSchema.options).toEqual([
      'files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_delete',
      'files_move', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references'
    ]);
    expect(() => TOOL_SCHEMA_BY_NAME.agent_spawn.parse({
      workspaceId,
      prompt: 'p',
      idempotencyKey: 'spawn-key',
      profileId: 'default',
      proxyOperations: ['files_read'],
      ttlSeconds: 30,
      maxOutputBytes: 1_024,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostMicros: 0
    })).not.toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_spawn.parse({
      workspaceId,
      prompt: 'x'.repeat(131_073),
      idempotencyKey: 'spawn-key',
      profileId: 'default',
      proxyOperations: ['files_read']
    })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_spawn.parse({
      workspaceId,
      prompt: '😀'.repeat(32_769),
      idempotencyKey: 'spawn-key',
      profileId: 'default',
      proxyOperations: ['files_read']
    })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_spawn.parse({
      workspaceId,
      prompt: 'p',
      idempotencyKey: 'spawn-key',
      profileId: 'default',
      proxyOperations: ['git_push']
    })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_spawn.parse({
      workspaceId,
      prompt: 'p',
      idempotencyKey: 'spawn-key',
      profileId: 'default',
      proxyOperations: ['files_read'],
      ownerId: 'public-identity-is-forbidden'
    })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_status.parse({ workspaceId, agentId })).not.toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_status.parse({ workspaceId, idempotencyKey: 'spawn-key' })).not.toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_status.parse({ workspaceId, agentId, idempotencyKey: 'spawn-key' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_logs.parse({ workspaceId, agentId, cursor: '-1' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_message.parse({
      workspaceId, agentId, idempotencyKey: 'message-key', mode: 'steer', message: ''
    })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.agent_list.parse({ workspaceId, limit: 101 })).toThrow();
  });

  it('publishes exact truthful agent annotations', () => {
    const specs = Object.fromEntries(TOOL_SPECS.filter(({ name }) => name.startsWith('agent_')).map((spec) => [spec.name, spec]));
    expect(Object.keys(specs).sort()).toEqual([
      'agent_cancel', 'agent_list', 'agent_logs', 'agent_message', 'agent_spawn', 'agent_status'
    ]);
    expect(specs.agent_spawn).toMatchObject({ title: 'Spawn coding agent', readOnly: false, destructive: true, idempotent: true, openWorld: true });
    expect(specs.agent_message).toMatchObject({ title: 'Message coding agent', readOnly: false, destructive: true, idempotent: true, openWorld: true });
    expect(specs.agent_cancel).toMatchObject({ title: 'Cancel coding agent', readOnly: false, destructive: true, idempotent: true, openWorld: false });
    for (const name of ['agent_status', 'agent_logs', 'agent_list']) {
      expect(specs[name]).toMatchObject({ readOnly: true, destructive: false, idempotent: true, openWorld: false });
    }
  });

  it('validates bounded agent status result data without public identity', () => {
    const data = {
      agentId,
      workspaceId,
      parentAgentId: null,
      profileId: 'default',
      proxyOperations: ['files_read'],
      status: 'RUNNING',
      generation: 1,
      createdAt: '2026-08-17T00:00:00.000Z',
      startedAt: '2026-08-17T00:00:01.000Z',
      terminalAt: null,
      expiresAt: '2026-08-17T00:30:00.000Z',
      budget: { ttlSeconds: 1_800, maxOutputBytes: 262_144, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostMicros: 1_000_000 },
      usage: { inputTokens: 10, outputTokens: 5, costMicros: 20, outputBytes: 100, eventCount: 2, toolTimeMs: 5, wallTimeMs: 50 },
      terminalReason: null,
      outcomeUnknown: false
    };
    expect(() => AgentStatusDataSchema.parse(data)).not.toThrow();
    expect(() => AgentStatusDataSchema.parse({ ...data, ownerId: 'must-not-be-public' })).toThrow();
    expect(() => AgentStatusDataSchema.parse({ ...data, status: 'UNKNOWN' })).toThrow();
  });

  it('validates bounded compacted agent outcome evidence', () => {
    const data = {
      agentId,
      workspaceId,
      status: 'FAILED',
      generation: 1,
      compactedAt: '2026-08-17T01:00:00.000Z',
      expiresAt: '2026-08-17T02:00:00.000Z',
      compacted: true
    };
    expect(() => AgentStatusDataSchema.parse(data)).not.toThrow();
    expect(() => AgentStatusDataSchema.parse({ ...data, ownerId: 'must-not-be-public' })).toThrow();
    expect(() => AgentStatusDataSchema.parse({ ...data, compacted: false })).toThrow();
  });

  it('validates secret-free fixed-gateway agent configuration', () => {
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        gatewayUrl: 'http://model-gateway:3002',
        profiles: [profile]
      }
    })).not.toThrow();
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        gatewayUrl: 'https://provider.example.com',
        profiles: [profile]
      }
    })).toThrow();
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        gatewayUrl: 'http://model-gateway:3002',
        profiles: [{ ...profile, apiKey: 'must-not-enter-runner-config' }]
      }
    })).toThrow();
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        networkMode: 'bridge',
        gatewayUrl: 'http://model-gateway:3002',
        profiles: [profile]
      }
    })).toThrow();
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        gatewayUrl: 'http://model-gateway:3002'
      }
    })).toThrow();
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        gatewayUrl: 'http://model-gateway:3002',
        profiles: [profile],
        limits: { globalActive: 2, principalActive: 3, workspaceActive: 1, parentActive: 1 }
      }
    })).toThrow();
    expect(() => RunnerConfigSchema.parse({
      ...runnerConfig,
      agents: {
        image: 'cloud-harness-agent:local',
        gatewayUrl: 'http://model-gateway:3002',
        profiles: [{ ...profile, maxOutputTokens: 2_000_001 }]
      }
    })).toThrow();
  });
});
