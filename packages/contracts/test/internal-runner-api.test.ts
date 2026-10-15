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
    expect(InternalRunnerOperationSchema.options).toEqual([
      'workspace_detail', 'workspace_close_fenced', 'toolkits_list', 'toolkits_preview',
      'settings_get', 'settings_update', 'settings_network_check',
      'oauth_settings_get', 'oauth_settings_update',
      'terminal_open', 'terminal_read', 'terminal_input', 'terminal_resize', 'terminal_close', 'terminal_list'
    ]);
    for (const operation of InternalRunnerOperationSchema.options.filter((name) => name.startsWith('terminal_'))) {
      expect(RunnerOperationSchema.options).not.toContain(operation);
      expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain(operation);
    }
    expect(RunnerOperationSchema.options).not.toContain('workspace_detail');
    expect(RunnerOperationSchema.options).not.toContain('workspace_close_fenced');
    expect(RunnerOperationSchema.options).not.toContain('toolkits_list');
    expect(RunnerOperationSchema.options).not.toContain('toolkits_preview');
    expect(RunnerOperationSchema.options).not.toContain('settings_get');
    expect(RunnerOperationSchema.options).not.toContain('settings_update');
    expect(RunnerOperationSchema.options).not.toContain('settings_network_check');
    expect(RunnerOperationSchema.options).not.toContain('oauth_settings_get');
    expect(RunnerOperationSchema.options).not.toContain('oauth_settings_update');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('workspace_detail');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('workspace_close_fenced');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('toolkits_list');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('toolkits_preview');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('settings_get');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('settings_update');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('settings_network_check');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('oauth_settings_get');
    expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain('oauth_settings_update');
    expect(() => RunnerRequestSchema.parse({ version: 2, principal, operation: 'workspace_detail', input: { workspaceId: `ws_${'a'.repeat(24)}` } })).toThrow();
  });

  it('accepts an instance network default, including an explicit reset, and refuses an exposure-only profile', () => {
    expect(InternalRunnerRequestSchema.parse({
      version: 2, principal, operation: 'settings_update', input: { defaultNetworkProfile: 'network-none' }
    })).toMatchObject({ operation: 'settings_update', input: { defaultNetworkProfile: 'network-none' } });
    expect(InternalRunnerRequestSchema.parse({
      version: 2, principal, operation: 'settings_update', input: { defaultNetworkProfile: null }
    })).toMatchObject({ operation: 'settings_update', input: { defaultNetworkProfile: null } });
    expect(() => InternalRunnerRequestSchema.parse({
      version: 2, principal, operation: 'settings_update', input: { defaultNetworkProfile: 'local-host' }
    })).toThrow();
    expect(() => InternalRunnerRequestSchema.parse({
      version: 2, principal, operation: 'settings_get', input: { defaultNetworkProfile: 'network-none' }
    })).toThrow();
  });

  it('accepts a revisioned, field-scoped workspace lifecycle change and refuses unsafe or empty ones', () => {
    const update = (workspaceLifecycle: Record<string, unknown>) => InternalRunnerRequestSchema.safeParse({
      version: 2, principal, operation: 'settings_update', input: { workspaceLifecycle }
    });
    expect(update({ expectedRevision: 0, idleTtlSeconds: 600, maxActiveWorkspacesPerOwner: null }).success).toBe(true);
    expect(update({ expectedRevision: 2, recoverableGraceSeconds: 0, acknowledgeImmediateClose: true }).success).toBe(true);
    expect(update({ expectedRevision: 2, recoverableGraceSeconds: 0 }).success).toBe(false);
    expect(update({ expectedRevision: 0 }).success).toBe(false);
    expect(update({ idleTtlSeconds: 600 }).success).toBe(false);
    expect(update({ expectedRevision: 0, idleTtlSeconds: 59 }).success).toBe(false);
    expect(update({ expectedRevision: 0, idleTtlSeconds: 600.5 }).success).toBe(false);
    expect(update({ expectedRevision: 0, maxActiveWorkspacesPerOwner: 65 }).success).toBe(false);
    expect(update({ expectedRevision: 0, wallTtlSeconds: 86_401 }).success).toBe(false);
    expect(update({ expectedRevision: 0, idleTtlSeconds: 600, unknown: 1 }).success).toBe(false);
    expect(InternalRunnerRequestSchema.safeParse({ version: 2, principal, operation: 'settings_update', input: {} }).success).toBe(false);
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
    // `skill_suggest` is deliberately both. It is a metadata operation because it reads
    // principal-scoped state and writes an audit row, and it is a public tool because a caller submits a
    // prompt rather than administering the instance. Every other metadata operation stays internal.
    const deliberatelyPublic = new Set(['skill_suggest']);
    for (const operation of MetadataRunnerOperationSchema.options) {
      if (deliberatelyPublic.has(operation)) continue;
      expect(RunnerOperationSchema.options).not.toContain(operation);
      expect(TOOL_SPECS.map((tool) => tool.name)).not.toContain(operation);
    }
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'secret_rotate',
      input: { environmentId: `env_${'a'.repeat(24)}`, name: 'API_TOKEN', value: 'new secret', expectedGeneration: 2 }
    })).toMatchObject({ operation: 'secret_rotate' });
    // A record whose name became reserved must stay deletable, or the operator cannot remediate
    // the fail-closed state the reservation creates. Deleting cannot inject a value.
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'secret_delete',
      input: { environmentId: `env_${'a'.repeat(24)}`, name: 'BUILTIN_SKILLS_ROOT', expectedGeneration: 1 }
    })).toMatchObject({ operation: 'secret_delete' });
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'global_secret_delete',
      input: { name: 'BUILTIN_SKILLS_ROOT', expectedGeneration: 1 }
    })).toMatchObject({ operation: 'global_secret_delete' });
    // Shape is still enforced on the delete path.
    expect(() => MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'secret_delete',
      input: { environmentId: `env_${'a'.repeat(24)}`, name: 'INVALID-DASH', expectedGeneration: 1 }
    })).toThrow();
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
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'artifact_read',
      input: { artifactId: `art_${'a'.repeat(32)}`, offset: 0, limit: 1024 }
    })).toMatchObject({ operation: 'artifact_read', input: { artifactId: `art_${'a'.repeat(32)}` } });
    expect(MetadataRunnerRequestSchema.parse({
      version: 2, principal, operation: 'artifact_restore',
      input: { artifactId: `art_${'a'.repeat(32)}`, workspaceId: `ws_${'a'.repeat(24)}`, path: 'out.txt', overwrite: true }
    })).toMatchObject({ operation: 'artifact_restore', input: { path: 'out.txt', overwrite: true } });
  });

  it('defines the 5 public artifact MCP tools with expected annotations and schemas', () => {
    const artifactToolNames = ['artifacts_snapshot', 'artifacts_list', 'artifacts_read', 'artifacts_restore', 'artifacts_delete'] as const;
    for (const name of artifactToolNames) {
      expect(RunnerOperationSchema.options).toContain(name);
      const spec = TOOL_SPECS.find((t) => t.name === name);
      expect(spec).toBeDefined();
    }
    const listSpec = TOOL_SPECS.find((t) => t.name === 'artifacts_list')!;
    expect(listSpec.readOnly).toBe(true);
    expect(listSpec.destructive).toBe(false);
    expect(listSpec.idempotent).toBe(true);

    const readSpec = TOOL_SPECS.find((t) => t.name === 'artifacts_read')!;
    expect(readSpec.readOnly).toBe(true);
    expect(readSpec.destructive).toBe(false);
    expect(readSpec.idempotent).toBe(true);

    const restoreSpec = TOOL_SPECS.find((t) => t.name === 'artifacts_restore')!;
    expect(restoreSpec.readOnly).toBe(false);
    expect(restoreSpec.destructive).toBe(true);

    const deleteSpec = TOOL_SPECS.find((t) => t.name === 'artifacts_delete')!;
    expect(deleteSpec.readOnly).toBe(false);
    expect(deleteSpec.destructive).toBe(true);
  });

  it('accepts a long provider-granted scope string when saving an OAuth grant', () => {
    const scope = Array.from({ length: 200 }, (_, index) => `scope-${index}`).join(' ');
    const parsed = MetadataRunnerRequestSchema.parse({
      version: 2,
      operation: 'mcp_oauth_grant_save',
      principal,
      input: {
        serverId: 'mcps_abcdefghijklmnopqrstuvwx', expectedGeneration: 0, issuer: 'https://as.example.com',
        registrationMode: 'dcr', grantedScopes: scope, requestedScopes: 'read', expiresAt: 1_800_000_000_000, blob: '{}'
      }
    });
    expect(parsed.operation).toBe('mcp_oauth_grant_save');
  });
});
