import { describe, expect, it } from 'vitest';
import {
  InternalRunnerRequestSchema,
  InternalRunnerOperationSchema,
  MetadataRunnerOperationSchema,
  MetadataRunnerRequestSchema,
  RunnerOperationSchema,
  RunnerRequestSchema,
  TOOL_SPECS
} from '../src/index.js';

const principal = {
  kind: 'external' as const,
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'dashboard-owner'
};

describe('internal runner API contract', () => {
  it('keeps dashboard-only operations outside the public MCP contract', () => {
    expect(InternalRunnerOperationSchema.options).toEqual(['workspace_detail', 'workspace_close_fenced']);
    expect(RunnerOperationSchema.options).not.toContain('workspace_detail');
    expect(RunnerOperationSchema.options).not.toContain('workspace_close_fenced');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('workspace_detail');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('workspace_close_fenced');
    expect(() => RunnerRequestSchema.parse({ version: 2, principal, operation: 'workspace_detail', input: { workspaceId: `ws_${'a'.repeat(24)}` } })).toThrow();
  });

  it('requires the v2 principal selector and generation fence', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    expect(InternalRunnerRequestSchema.parse({
      version: 2,
      principal,
      operation: 'workspace_close_fenced',
      input: { workspaceId, expectedGeneration: 3 }
    })).toMatchObject({ version: 2, principal, operation: 'workspace_close_fenced' });
    expect(() => InternalRunnerRequestSchema.parse({
      version: 1,
      ownerId: 'owner',
      operation: 'workspace_close_fenced',
      input: { workspaceId, expectedGeneration: 3 }
    })).toThrow();
    expect(() => InternalRunnerRequestSchema.parse({
      version: 2,
      principal,
      operation: 'workspace_close_fenced',
      input: { workspaceId }
    })).toThrow();
  });

  it('defines strict principal-scoped metadata mutations without publishing them as MCP tools', () => {
    expect(MetadataRunnerOperationSchema.options).toContain('secret_rotate');
    expect(MetadataRunnerOperationSchema.options).toContain('audit_list');
    for (const operation of MetadataRunnerOperationSchema.options) {
      expect(RunnerOperationSchema.options).not.toContain(operation);
      expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain(operation);
    }
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'secret_rotate',
      input: { environmentId: `env_${'a'.repeat(24)}`, name: 'API_TOKEN', value: 'new secret', expectedGeneration: 2 }
    })).toMatchObject({ operation: 'secret_rotate' });
    expect(() => MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'secret_rotate',
      input: { environmentId: `env_${'a'.repeat(24)}`, name: 'API_TOKEN', expectedGeneration: 2 }
    })).toThrow();
    expect(() => MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'project_create',
      input: { name: 'Harness', expectedGeneration: 1 }
    })).toThrow();
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'github_disconnect',
      input: { installationId: 'inst_12345' }
    })).toMatchObject({ operation: 'github_disconnect', input: { installationId: 'inst_12345' } });
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'github_reconcile',
      input: { installationId: 'inst_12345' }
    })).toMatchObject({ operation: 'github_reconcile', input: { installationId: 'inst_12345' } });
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'github_reconcile',
      input: {}
    })).toMatchObject({ operation: 'github_reconcile', input: {} });
  });
});
