import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkspaceBackend } from '../../src/local/local-workspace-backend.js';
import type { CliOptions } from '../../src/cli-options.js';

describe('Local Workspace Capabilities', () => {
  let tempRoot: string;
  let canonicalRoot: string;
  let backend: LocalWorkspaceBackend;

  beforeEach(async () => {
    tempRoot = join(tmpdir(), `ch-local-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempRoot, { recursive: true });
    canonicalRoot = await realpath(tempRoot);
  });

  afterEach(async () => {
    if (backend) await backend.close();
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reports read-only and disabled network/push by default', async () => {
    const options: CliOptions = {
      transport: 'stdio',
      workspace: canonicalRoot,
      gitNetwork: false,
      gitPush: false,
      env: [],
      help: false,
      version: false
    };
    backend = new LocalWorkspaceBackend(canonicalRoot, options);

    const res = await backend.call('workspace_capabilities', {});
    expect(res.ok).toBe(true);
    const data = res.data as {
      capabilities: { repository: Record<string, boolean>; workspace: Record<string, unknown> };
      permissions: { contents: { read: boolean; write: boolean } };
      operations: Record<string, boolean>;
    };

    expect(data.capabilities.repository.read).toBe(true);
    expect(data.capabilities.repository.push).toBe(false);
    expect(data.capabilities.repository.issuesRead).toBe(false);
    expect(data.capabilities.repository.pullRequestsRead).toBe(false);

    expect(data.permissions.contents.read).toBe(true);
    expect(data.permissions.contents.write).toBe(true); // local files can be edited

    expect(data.operations.gitFetch).toBe(false);
    expect(data.operations.gitPush).toBe(false);
    expect(data.operations.execRun).toBe(true);
  });

  it('reflects --git-push and --git-network flags in capabilities and operations', async () => {
    const options: CliOptions = {
      transport: 'stdio',
      workspace: canonicalRoot,
      gitNetwork: true,
      gitPush: true,
      env: [],
      help: false,
      version: false
    };
    backend = new LocalWorkspaceBackend(canonicalRoot, options);

    const res = await backend.call('workspace_capabilities', { workspaceId: backend.workspaceId });
    expect(res.ok).toBe(true);
    const data = res.data as {
      capabilities: { repository: Record<string, boolean>; workspace: Record<string, unknown> };
      operations: Record<string, boolean>;
    };

    expect(data.capabilities.repository.push).toBe(true);
    expect(data.capabilities.workspace.networkMode).toBe('host');
    expect(data.operations.gitFetch).toBe(true);
    expect(data.operations.gitPull).toBe(true);
    expect(data.operations.gitPush).toBe(true);
  });

  it('returns structured authorization error when git_push is attempted without --git-push', async () => {
    const options: CliOptions = {
      transport: 'stdio',
      workspace: canonicalRoot,
      gitNetwork: false,
      gitPush: false,
      env: [],
      help: false,
      version: false
    };
    backend = new LocalWorkspaceBackend(canonicalRoot, options);

    const res = await backend.call('git_push', { workspaceId: backend.workspaceId });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect(res.error?.operation).toBe('git_push');
    expect(res.error?.requiredCapability).toBe('repository.push');
  });

  it('returns structured authorization error when github_action is attempted in local mode', async () => {
    const options: CliOptions = {
      transport: 'stdio',
      workspace: canonicalRoot,
      gitNetwork: false,
      gitPush: false,
      env: [],
      help: false,
      version: false
    };
    backend = new LocalWorkspaceBackend(canonicalRoot, options);

    const resPr = await backend.call('github_action', { workspaceId: backend.workspaceId, action: 'pr_create', title: 'test', head: 'feat' });
    expect(resPr.ok).toBe(false);
    expect(resPr.error?.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect(resPr.error?.operation).toBe('github_action');
    expect(resPr.error?.requiredCapability).toBe('repository.pullRequestsWrite');

    const resIssue = await backend.call('github_action', { workspaceId: backend.workspaceId, action: 'issue_create', title: 'test' });
    expect(resIssue.ok).toBe(false);
    expect(resIssue.error?.code).toBe('REPOSITORY_OPERATION_NOT_AUTHORIZED');
    expect(resIssue.error?.operation).toBe('github_action');
    expect(resIssue.error?.requiredCapability).toBe('repository.issuesWrite');
  });

  it('returns workspace_context with capabilities and permissions', async () => {
    const options: CliOptions = {
      transport: 'stdio',
      workspace: canonicalRoot,
      gitNetwork: false,
      gitPush: false,
      env: [],
      help: false,
      version: false
    };
    backend = new LocalWorkspaceBackend(canonicalRoot, options);

    const res = await backend.call('workspace_context', { workspaceId: backend.workspaceId });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.capabilities).toBeDefined();
    expect(data.permissions).toBeDefined();
    expect(data.operations).toBeDefined();
    expect(data.branch).toBe('HEAD');
  });

  it('reports secrets_list as unsupported in local stdio mode', async () => {
    const res = await backend.call('secrets_list', {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
    expect(res.message).toContain('secrets_list is unsupported in local stdio mode');
  });
});
