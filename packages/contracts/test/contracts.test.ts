import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ApiConfigSchema,
  ContextManifestItemSchema,
  ContextManifestSchema,
  ErrorCodeSchema,
  ExecutorNetworkProfileSchema,
  HarnessError,
  ProvenanceSchema,
  RunnerConfigSchema,
  RunnerRequestSchema,
  TOOL_SCHEMA_BY_NAME,
  TOOL_SPECS,
  ToolResultSchema,
  WorkspaceCapabilityResultSchema,
  WorkspaceIdSchema,
  WorkspaceNetworkExposureSchema
} from '../src/index.js';
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

  it('validates pull request and extended issue schemas in github_action', () => {
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'pr_create',
      title: 'feat: add brokered github operations',
      body: 'PR body',
      head: 'feat/gh-ops',
      base: 'main',
      draft: true,
      labels: ['enhancement']
    })).toMatchObject({
      action: 'pr_create',
      title: 'feat: add brokered github operations',
      draft: true,
      labels: ['enhancement']
    });

    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'pr_update',
      prNumber: 10,
      title: 'Updated title',
      state: 'closed'
    })).toMatchObject({ action: 'pr_update', prNumber: 10, title: 'Updated title', state: 'closed' });

    expect(() => TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'pr_update',
      prNumber: 10
    })).toThrow();

    expect(() => TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'pr_update',
      prNumber: 10,
      state: 'all'
    })).toThrow();

    expect(() => TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'issue_update',
      issueNumber: 10,
      state: 'all'
    })).toThrow();

    const strippedPrList = TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'pr_list',
      title: 'ignored',
      prNumber: 10
    }) as Record<string, unknown>;
    expect(strippedPrList.title).toBeUndefined();
    expect(strippedPrList.prNumber).toBeUndefined();
    expect(strippedPrList.limit).toBe(20);
    expect(strippedPrList.state).toBe('open');
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'pr_comment',
      prNumber: 10,
      body: 'LGTM!',
      idempotencyKey: 'idem_key_123'
    })).toMatchObject({ action: 'pr_comment', prNumber: 10, body: 'LGTM!' });

    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      action: 'issue_create',
      title: 'New bug report',
      body: 'Bug description',
      labels: ['bug', 'p1'],
      assignees: ['octocat']
    })).toMatchObject({
      action: 'issue_create',
      title: 'New bug report',
      labels: ['bug', 'p1'],
      assignees: ['octocat']
    });

    const validWs = `ws_${'a'.repeat(24)}`;
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      workspaceId: validWs,
      action: 'issue_list',
      limit: 5,
      state: 'open'
    })).toMatchObject({ workspaceId: validWs, action: 'issue_list', limit: 5 });

    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({
      workspaceId: validWs,
      action: 'pr_list',
      limit: 5,
      state: 'all'
    })).toMatchObject({ workspaceId: validWs, action: 'pr_list', limit: 5 });
  });

  it('validates workspace lease renew, recovery, context, capabilities, and git identity schemas', () => {
    expect(TOOL_SCHEMA_BY_NAME.workspace_lease_renew.parse({ extensionSeconds: 3600 })).toMatchObject({ extensionSeconds: 3600 });
    expect(TOOL_SCHEMA_BY_NAME.workspace_recover.parse({})).toMatchObject({ mode: 'resume' });
    expect(TOOL_SCHEMA_BY_NAME.workspace_recover.parse({ mode: 'resume' })).toMatchObject({ mode: 'resume' });
    expect(TOOL_SCHEMA_BY_NAME.workspace_recover.parse({ mode: 'patch' })).toMatchObject({ mode: 'patch' });
    expect(TOOL_SCHEMA_BY_NAME.workspace_recover.parse({ mode: 'status' })).toMatchObject({ mode: 'status' });
    expect(TOOL_SCHEMA_BY_NAME.workspace_recover.parse({ mode: 'export', targetBranch: 'backup' })).toMatchObject({ mode: 'export', targetBranch: 'backup' });
    expect(TOOL_SCHEMA_BY_NAME.workspace_context.parse({})).toBeDefined();
    expect(TOOL_SCHEMA_BY_NAME.workspace_capabilities.parse({})).toBeDefined();
    expect(TOOL_SCHEMA_BY_NAME.workspace_capabilities.parse({ workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa' })).toMatchObject({ workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa' });
    expect(TOOL_SCHEMA_BY_NAME.git_identity_status.parse({})).toBeDefined();
    expect(TOOL_SCHEMA_BY_NAME.git_identity_set.parse({ name: 'Dev', email: 'dev@example.com' })).toMatchObject({ name: 'Dev', email: 'dev@example.com' });
  });

  it('validates REPOSITORY_OPERATION_NOT_AUTHORIZED and structured error details', () => {
    const errorResult = ToolResultSchema.parse({
      ok: false,
      message: 'Not authorized to push',
      error: {
        code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED',
        message: 'Git push is not authorized for repository',
        retryable: false,
        operation: 'git_push',
        repository: 'owner/repo',
        requiredCapability: 'repository.push'
      }
    });
    expect(errorResult.error?.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect(errorResult.error?.operation).toBe('git_push');
    expect(errorResult.error?.repository).toBe('owner/repo');
    expect(errorResult.error?.requiredCapability).toBe('repository.push');

    const err = new HarnessError('REPOSITORY_OPERATION_NOT_AUTHORIZED', 'Push forbidden', 403, false, {
      operation: 'git_push',
      repository: 'owner/repo',
      requiredCapability: 'repository.push'
    });
    expect(err.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect(err.operation).toBe('git_push');
    expect(err.repository).toBe('owner/repo');
    expect(err.requiredCapability).toBe('repository.push');
  });

  it('validates capability result schemas', () => {
    const parsed = WorkspaceCapabilityResultSchema.parse({
      workspaceId: 'ws_123',
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      capabilities: {
        repository: {
          read: true,
          push: true,
          issuesRead: false,
          issuesWrite: false,
          pullRequestsRead: false,
          pullRequestsWrite: false
        },
        workspace: {
          shell: true,
          tasks: true,
          sessions: true,
          deployments: true,
          privileged: false,
          networkProfile: 'network-none'
        }
      },
      permissions: {
        contents: { read: true, write: true },
        issues: { read: false, write: false },
        pullRequests: { read: false, write: false }
      },
      operations: {
        gitFetch: true,
        gitPull: true,
        gitPush: true,
        issueList: false,
        issueView: false,
        issueCreate: false,
        issueComment: false,
        issueUpdate: false,
        issuePublish: false,
        labelCreate: false,
        pullRequestList: false,
        pullRequestView: false,
        pullRequestCreate: false,
        execRun: true,
        privilegedExec: false,
        deploymentsRun: true
      }
    });
    expect(parsed.capabilities.repository.push).toBe(true);
    expect(parsed.permissions.contents.write).toBe(true);
    expect(parsed.operations.gitPush).toBe(true);
  });

  it('validates executor network profile schemas and legacy rejection', () => {
    expect(ExecutorNetworkProfileSchema.parse('network-none')).toBe('network-none');
    expect(ExecutorNetworkProfileSchema.parse('dependency-access')).toBe('dependency-access');
    expect(() => ExecutorNetworkProfileSchema.parse('none')).toThrow();
    expect(() => ExecutorNetworkProfileSchema.parse('bridge')).toThrow();

    expect(WorkspaceNetworkExposureSchema.parse('local-host')).toBe('local-host');
    expect(WorkspaceNetworkExposureSchema.parse('network-none')).toBe('network-none');

    expect(ErrorCodeSchema.parse('DEPENDENCY_EGRESS_UNAVAILABLE')).toBe('DEPENDENCY_EGRESS_UNAVAILABLE');

    const validOpen = TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      repositoryUrl: 'https://github.com/owner/repo.git',
      idempotencyKey: 'idempotency-123',
      networkProfile: 'dependency-access'
    });
    expect(validOpen.networkProfile).toBe('dependency-access');

    expect(() => TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      repositoryUrl: 'https://github.com/owner/repo.git',
      idempotencyKey: 'idempotency-123',
      networkMode: 'bridge'
    })).toThrow(/networkMode was replaced by networkProfile/);

    expect(() => TOOL_SCHEMA_BY_NAME.workspace_open.parse({
      repositoryUrl: 'https://github.com/owner/repo.git',
      idempotencyKey: 'idempotency-123',
      networkMode: 'none'
    })).toThrow(/networkMode was replaced by networkProfile/);
  });

  it('validates provenance, context manifest, scoped memories, and hooks schemas', () => {
    const sampleProvenance = {
      source: 'repository',
      trust: 'untrusted-executor',
      mutableBy: 'repository-commit',
      path: 'CLAUDE.md',
      contentSha256: 'a'.repeat(64),
      discoveredAt: new Date().toISOString()
    };
    expect(() => ProvenanceSchema.parse(sampleProvenance)).not.toThrow();

    // Invalid source
    expect(() => ProvenanceSchema.parse({ ...sampleProvenance, source: 'unknown' })).toThrow();

    const sampleManifestItem = {
      id: 'ctx_claude_root',
      kind: 'instruction',
      format: 'claude',
      clients: ['claude', 'all'],
      path: 'CLAUDE.md',
      contentSha256: 'a'.repeat(64),
      byteCount: 1024,
      provenance: sampleProvenance
    };
    expect(() => ContextManifestItemSchema.parse(sampleManifestItem)).not.toThrow();

    const sampleManifest = {
      contractVersion: 1,
      returnedBytes: 1024,
      scannedFiles: 1,
      scannedSourceBytes: 1024,
      truncated: false,
      truncationReasons: [],
      items: [sampleManifestItem],
      warnings: []
    };
    expect(() => ContextManifestSchema.parse(sampleManifest)).not.toThrow();

    // workspace_context enriched input
    expect(TOOL_SCHEMA_BY_NAME.workspace_context.parse({
      clientProfile: 'claude',
      include: ['instructions', 'skills'],
      contentMode: 'excerpt',
      maxBytes: 65536
    })).toMatchObject({
      clientProfile: 'claude',
      contentMode: 'excerpt',
      maxBytes: 65536
    });

    // memories_write with CAS generation
    expect(TOOL_SCHEMA_BY_NAME.memories_write.parse({
      scope: 'owner',
      name: 'architecture-notes',
      content: 'Important context',
      tags: ['arch', 'design'],
      expectedGeneration: 0
    })).toMatchObject({
      scope: 'owner',
      name: 'architecture-notes',
      expectedGeneration: 0
    });

    // memories_search
    expect(TOOL_SCHEMA_BY_NAME.memories_search.parse({
      query: 'architecture',
      scope: 'owner',
      tags: ['arch']
    })).toMatchObject({
      query: 'architecture',
      scope: 'owner'
    });

    // memories_delete
    expect(TOOL_SCHEMA_BY_NAME.memories_delete.parse({
      memoryId: 'mem_123456789012',
      expectedGeneration: 1
    })).toMatchObject({
      memoryId: 'mem_123456789012',
      expectedGeneration: 1
    });

    // hooks_activate
    expect(TOOL_SCHEMA_BY_NAME.hooks_activate.parse({
      manifestSha256: 'b'.repeat(64),
      events: ['pre_commit', 'post_checkout']
    })).toMatchObject({
      manifestSha256: 'b'.repeat(64),
      events: ['pre_commit', 'post_checkout']
    });

    // hooks_deactivate
    expect(TOOL_SCHEMA_BY_NAME.hooks_deactivate.parse({
      events: ['pre_commit']
    })).toMatchObject({
      events: ['pre_commit']
    });

    // skills_run requires expectedSha256
    expect(() => TOOL_SCHEMA_BY_NAME.skills_run.parse({ name: 'demo', script: 'run.sh' })).toThrow();
    expect(TOOL_SCHEMA_BY_NAME.skills_run.parse({ name: 'demo', script: 'run.sh', expectedSha256: 'c'.repeat(64) })).toMatchObject({
      name: 'demo',
      expectedSha256: 'c'.repeat(64)
    });

    // hooks_run requires expectedManifestSha256 or expectedSha256
    expect(() => TOOL_SCHEMA_BY_NAME.hooks_run.parse({ name: 'verify' })).toThrow();
    expect(TOOL_SCHEMA_BY_NAME.hooks_run.parse({ name: 'verify', expectedManifestSha256: 'd'.repeat(64) })).toMatchObject({
      name: 'verify',
      expectedManifestSha256: 'd'.repeat(64)
    });
  });
  it('enforces capability consistency between advertised GitHub operations and exposed github_action tool', () => {
    const githubOps = [
      'issueList',
      'issueView',
      'issueCreate',
      'issueComment',
      'issueUpdate',
      'issuePublish',
      'labelCreate',
      'pullRequestList',
      'pullRequestView',
      'pullRequestCreate'
    ] as const;

    const ghSpec = TOOL_SPECS.find((tool) => tool.name === 'github_action');
    expect(ghSpec).toBeDefined();
    expect(ghSpec?.destructive).toBe(true);
    expect(ghSpec?.openWorld).toBe(true);
    expect(ghSpec?.readOnly).toBe(false);

    // If any GitHub operation is authorized in a capability profile, github_action must exist in TOOL_SPECS
    for (const op of githubOps) {
      const sampleCaps = WorkspaceCapabilityResultSchema.parse({
        workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa',
        repository: 'owner/repo',
        repositoryUrl: 'https://github.com/owner/repo',
        capabilities: {
          repository: {
            read: true,
            push: true,
            issuesRead: op.startsWith('issue'),
            issuesWrite: op.startsWith('issue') && op !== 'issueList' && op !== 'issueView',
            pullRequestsRead: op.startsWith('pullRequest'),
            pullRequestsWrite: op === 'pullRequestCreate'
          },
          workspace: {
            shell: true,
            tasks: true,
            sessions: true,
            deployments: true,
            privileged: false,
            networkProfile: 'network-none'
          }
        },
        permissions: {
          contents: { read: true, write: true },
          issues: { read: op.startsWith('issue'), write: op.startsWith('issue') && op !== 'issueList' && op !== 'issueView' },
          pullRequests: { read: op.startsWith('pullRequest'), write: op === 'pullRequestCreate' }
        },
        operations: {
          gitFetch: true,
          gitPull: true,
          gitPush: true,
          issueList: op === 'issueList',
          issueView: op === 'issueView',
          issueCreate: op === 'issueCreate',
          issueComment: op === 'issueComment',
          issueUpdate: op === 'issueUpdate',
          issuePublish: op === 'issuePublish',
          labelCreate: op === 'labelCreate',
          pullRequestList: op === 'pullRequestList',
          pullRequestView: op === 'pullRequestView',
          pullRequestCreate: op === 'pullRequestCreate',
          execRun: true,
          privilegedExec: false,
          deploymentsRun: true
        }
      });

      if (sampleCaps.operations[op]) {
        expect(TOOL_SPECS.some((t) => t.name === 'github_action')).toBe(true);
      }
    }
  });

  it('ensures all registered TOOL_SPECS emit top-level object schemas with properties for client ingestion', () => {
    for (const spec of TOOL_SPECS) {
      const jsonSchema = typeof spec.inputSchema.toJSONSchema === 'function'
        ? spec.inputSchema.toJSONSchema({ io: 'input' })
        : z.toJSONSchema(spec.inputSchema, { io: 'input' });
      expect(jsonSchema.type, `tool ${spec.name} must have type: object`).toBe('object');
      expect(jsonSchema.properties, `tool ${spec.name} must have top-level properties`).toBeDefined();
      expect(Object.keys(jsonSchema.properties || {}).length, `tool ${spec.name} must have at least one property`).toBeGreaterThan(0);
    }
  });
});
