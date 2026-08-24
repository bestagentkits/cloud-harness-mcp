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

  it('enables the API-key gateway only with a separate complete Access audience', () => {
    const access = {
      ...commonApiConfig, authMode: 'cloudflare-access' as const,
      accessIssuer: 'https://team.cloudflareaccess.com', accessAudience: 'main-audience',
      accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs'
    };
    const gateway = {
      apiKeyAuthEnabled: true, apiKeyGatewayAccessAudience: 'gateway-audience',
      apiKeyGatewayServiceSubject: 'cf-service:d29ya2Vy', apiKeyGatewayPublicUrl: 'https://api.example/mcp'
    };
    expect(ApiConfigSchema.parse({ ...access, ...gateway }).apiKeyAuthEnabled).toBe(true);
    expect(() => ApiConfigSchema.parse({ ...access, ...gateway, apiKeyGatewayAccessAudience: 'main-audience' })).toThrow();
    expect(() => ApiConfigSchema.parse({ ...access, apiKeyAuthEnabled: true })).toThrow();
    expect(() => ApiConfigSchema.parse({ ...commonApiConfig, bearerToken: 'owner-token-that-is-long-enough-123456', ...gateway })).toThrow();
    expect(() => ApiConfigSchema.parse({ ...access, apiKeyGatewayPublicUrl: 'https://api.example/mcp' })).toThrow();
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
  it('accepts shorthand branch refspecs and rejects non-branch destinations', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    expect(TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'main:main' })).toMatchObject({ refspec: 'main:main' });
    expect(TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'HEAD:main' })).toMatchObject({ refspec: 'HEAD:main' });
    expect(TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'feat/abc:feat/abc' })).toMatchObject({ refspec: 'feat/abc:feat/abc' });
    expect(TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'main:main', forceWithLease: true, expectedRemoteOid: 'a'.repeat(40) })).toMatchObject({ refspec: 'main:main' });
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'main:refs/tags/v1.0' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: 'main:refs/notes/review' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.git_push.parse({ workspaceId, refspec: ':main' })).toThrow();
  });


  it('rejects workspace-root file mutations and validates dependency handles', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    expect(() => TOOL_SCHEMA_BY_NAME.files_delete.parse({ workspaceId, path: '.', recursive: true })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.files_move.parse({ workspaceId, source: '.', destination: 'moved', overwrite: false })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.tasks_run.parse({ workspaceId, command: 'true', idempotencyKey: 'task-test', dependsOn: ['task_invalid'] })).toThrow();
  });

  it('validates files_write_batch schemas and boundaries', () => {
    const validBatch = {
      files: [
        { path: 'plans/plan.md', content: '# Plan', expectedSha256: 'a'.repeat(64) },
        { path: 'src/main.ts', content: 'console.log("hello");' }
      ],
      createParents: true,
      atomic: true
    };
    expect(TOOL_SCHEMA_BY_NAME.files_write_batch.parse(validBatch)).toMatchObject({ createParents: true, atomic: true });
    expect(() => TOOL_SCHEMA_BY_NAME.files_write_batch.parse({ files: [] })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.files_write_batch.parse({ files: [{ path: '../outside.txt', content: 'hack' }] })).toThrow();
  });

  it('validates workspace_finalize schemas and options', () => {
    const validFinalize = {
      commitMessage: 'feat(ux): improve developer experience',
      push: true,
      all: true
    };
    expect(TOOL_SCHEMA_BY_NAME.workspace_finalize.parse(validFinalize)).toMatchObject({ push: true, all: true });
    expect(() => TOOL_SCHEMA_BY_NAME.workspace_finalize.parse({ commitMessage: '' })).toThrow();
    expect(() => TOOL_SCHEMA_BY_NAME.workspace_finalize.parse({ commitMessage: 'msg', authorEmail: 'invalid-email' })).toThrow();
  });

  it('validates operation status, cancel, and wait schemas', () => {
    const validOpId = `op_${'a'.repeat(24)}`;
    expect(TOOL_SCHEMA_BY_NAME.operation_status.parse({ operationId: validOpId })).toMatchObject({ operationId: validOpId });
    expect(TOOL_SCHEMA_BY_NAME.operation_cancel.parse({ operationId: validOpId })).toMatchObject({ operationId: validOpId });
    expect(TOOL_SCHEMA_BY_NAME.operation_wait.parse({ operationId: validOpId, timeoutMs: 5000 })).toMatchObject({ timeoutMs: 5000 });
    expect(() => TOOL_SCHEMA_BY_NAME.operation_status.parse({ operationId: '' })).toThrow();
  });

  it('validates extended github_action schemas for comments and labels', () => {
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'issue_comment',
      issueNumber: 42,
      body: 'Comment body here'
    })).toMatchObject({ action: 'issue_comment', issueNumber: 42 });

    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'label_create',
      name: 'ready to ship stable',
      color: '0E8A16',
      description: 'Ready for stable'
    })).toMatchObject({ action: 'label_create', name: 'ready to ship stable' });

    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'issue_labels_add',
      issueNumber: 42,
      labels: ['bug', 'p0']
    })).toMatchObject({ action: 'issue_labels_add', labels: ['bug', 'p0'] });

    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'issue_update',
      issueNumber: 42,
      state: 'closed',
      stateReason: 'completed'
    })).toMatchObject({ action: 'issue_update', state: 'closed' });
  });

  it('validates workspace lease renew, recovery, context, and git identity schemas', () => {
    expect(TOOL_SCHEMA_BY_NAME.workspace_lease_renew.parse({ extensionSeconds: 3600 })).toMatchObject({ extensionSeconds: 3600 });
    expect(TOOL_SCHEMA_BY_NAME.workspace_recover.parse({ mode: 'patch' })).toMatchObject({ mode: 'patch' });
    expect(TOOL_SCHEMA_BY_NAME.workspace_context.parse({})).toBeDefined();
    expect(TOOL_SCHEMA_BY_NAME.git_identity_status.parse({})).toBeDefined();
    expect(TOOL_SCHEMA_BY_NAME.git_identity_set.parse({ name: 'Dev', email: 'dev@example.com' })).toMatchObject({ name: 'Dev', email: 'dev@example.com' });
  });
});
