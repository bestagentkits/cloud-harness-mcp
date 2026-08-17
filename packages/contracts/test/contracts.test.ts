import { describe, expect, it } from 'vitest';
import { ApiConfigSchema, RunnerConfigSchema, RunnerRequestSchema, TOOL_SCHEMA_BY_NAME, WorkspaceIdSchema } from '../src/index.js';

const commonApiConfig = {
  runnerToken: 'another-token-that-is-long-enough-1234',
  runnerUrl: 'http://runner:3001',
  publicHosts: ['localhost']
};

describe('contracts', () => {
  it('rejects path traversal and malformed handles', () => {
    expect(() => TOOL_SCHEMA_BY_NAME.files_read.parse({ workspaceId: 'ws_123', path: '../secret' })).toThrow();
    expect(() => WorkspaceIdSchema.parse('workspace-1')).toThrow();
  });

  it('rejects placeholder secrets', () => {
    expect(() => ApiConfigSchema.parse({ ...commonApiConfig, bearerToken: 'change-me-at-least-32-random-characters' })).toThrow();
  });

  it('defaults to owner bearer mode and rejects mixed or partial Access configuration', () => {
    const owner = ApiConfigSchema.parse({ ...commonApiConfig, bearerToken: 'owner-token-that-is-long-enough-123456' });
    expect(owner.authMode ?? 'owner-bearer').toBe('owner-bearer');
    expect(() => ApiConfigSchema.parse({
      ...commonApiConfig,
      authMode: 'owner-bearer',
      bearerToken: 'owner-token-that-is-long-enough-123456',
      accessIssuer: 'https://team.cloudflareaccess.com'
    })).toThrow();
    expect(() => ApiConfigSchema.parse({ ...commonApiConfig, authMode: 'cloudflare-access', accessIssuer: 'https://team.cloudflareaccess.com' })).toThrow();
  });

  it('accepts a complete Access configuration and requires HTTPS provider URLs', () => {
    const access = {
      ...commonApiConfig,
      authMode: 'cloudflare-access' as const,
      accessIssuer: 'https://team.cloudflareaccess.com',
      accessAudience: 'application-audience',
      accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs'
    };
    expect(ApiConfigSchema.parse(access).authMode).toBe('cloudflare-access');
    expect(() => ApiConfigSchema.parse({ ...access, accessIssuer: 'http://team.cloudflareaccess.com' })).toThrow();
    expect(() => ApiConfigSchema.parse({ ...access, bearerToken: 'owner-token-that-is-long-enough-123456' })).toThrow();
  });

  it('accepts only explicit owner or verified external runner principal selectors', () => {
    const base = { version: 2, operation: 'workspace_list', input: {} } as const;
    expect(RunnerRequestSchema.parse({ ...base, principal: { kind: 'owner', ownerId: 'owner' } }).principal.kind).toBe('owner');
    expect(RunnerRequestSchema.parse({ ...base, principal: { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject: 'subject' } }).principal.kind).toBe('external');
    expect(() => RunnerRequestSchema.parse({ ...base, principal: { kind: 'external', principalId: 'principal_caller_chosen' } })).toThrow();
  });

  it('retains the legacy owner-only runner request during expand-contract rollout', () => {
    const legacy = RunnerRequestSchema.parse({ version: 1, ownerId: 'owner', operation: 'workspace_list', input: {} });
    expect(legacy).toMatchObject({ version: 1, ownerId: 'owner' });
    expect(() => RunnerRequestSchema.parse({ version: 1, ownerId: 'owner', principal: { kind: 'owner', ownerId: 'other' }, operation: 'workspace_list', input: {} })).toThrow();
  });

  it('validates an optional exact legacy owner mapping in trusted runner config', () => {
    const runner = {
      serviceToken: 'runner-token-that-is-longer-than-32-characters', jobsRoot: '/jobs', stateDb: '/state/state.db',
      executorImage: 'executor:latest', allowedGitHosts: ['github.com']
    };
    const mapping = { legacyOwnerId: 'owner', issuer: 'https://team.cloudflareaccess.com', subject: 'owner-subject' };
    expect(RunnerConfigSchema.parse({ ...runner, authMode: 'cloudflare-access', legacyPrincipalMapping: mapping }).legacyPrincipalMapping).toEqual(mapping);
    expect(() => RunnerConfigSchema.parse({ ...runner, legacyPrincipalMapping: mapping })).toThrow();
    expect(() => RunnerConfigSchema.parse({ ...runner, authMode: 'cloudflare-access', legacyPrincipalMapping: { ...mapping, issuer: 'http://team.cloudflareaccess.com' } })).toThrow();
  });

  it('accepts only complete, unique Access principal relinks', () => {
    const runner = {
      serviceToken: 'runner-token-that-is-longer-than-32-characters', jobsRoot: '/jobs', stateDb: '/state/state.db',
      executorImage: 'executor:latest', allowedGitHosts: ['github.com'], authMode: 'cloudflare-access' as const
    };
    const mapping = {
      oldIssuer: 'https://old.cloudflareaccess.com', oldSubject: 'old-subject',
      newIssuer: 'https://new.cloudflareaccess.com', newSubject: 'new-subject'
    };
    expect(RunnerConfigSchema.parse({ ...runner, principalRelinks: [mapping] }).principalRelinks).toEqual([mapping]);
    expect(() => RunnerConfigSchema.parse({ ...runner, principalRelinks: [{ ...mapping, newSubject: undefined }] })).toThrow();
    expect(() => RunnerConfigSchema.parse({ ...runner, principalRelinks: [mapping, mapping] })).toThrow();
    expect(() => RunnerConfigSchema.parse({ ...runner, principalRelinks: [{
      ...mapping, newIssuer: mapping.oldIssuer, newSubject: mapping.oldSubject
    }] })).toThrow();
    expect(() => RunnerConfigSchema.parse({ ...runner, authMode: 'owner-bearer', principalRelinks: [mapping] })).toThrow();
  });

  it('uses a fixed GitHub installation only in owner mode and an App slug in Access mode', () => {
    const runner = {
      serviceToken: 'runner-token-that-is-longer-than-32-characters', jobsRoot: '/jobs', stateDb: '/state/state.db',
      executorImage: 'executor:latest', allowedGitHosts: ['github.com']
    };
    const app = { appId: 1, privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----' };
    expect(() => RunnerConfigSchema.parse({ ...runner, githubApp: app })).toThrow();
    expect(RunnerConfigSchema.parse({ ...runner, githubApp: { ...app, installationId: 2 } }).githubApp?.installationId).toBe(2);
    expect(() => RunnerConfigSchema.parse({ ...runner, authMode: 'cloudflare-access', githubApp: app })).toThrow();
    expect(RunnerConfigSchema.parse({ ...runner, authMode: 'cloudflare-access', githubApp: { ...app, appSlug: 'cloud-harness' } }).githubApp?.appSlug).toBe('cloud-harness');
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
});
