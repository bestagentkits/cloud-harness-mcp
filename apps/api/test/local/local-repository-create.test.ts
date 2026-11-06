import { mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubRepositoryCreateCapabilitySchema } from '@cloud-harness/contracts';
import { LocalWorkspaceBackend } from '../../src/local/local-workspace-backend.js';
import type { CliOptions } from '../../src/cli-options.js';

describe('Local mode github_repository_create', () => {
  let tempRoot: string;
  let backend: LocalWorkspaceBackend;

  beforeEach(async () => {
    tempRoot = join(tmpdir(), `ch-local-repo-create-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempRoot, { recursive: true });
    const canonicalRoot = await realpath(tempRoot);
    const options: CliOptions = { transport: 'stdio', workspace: canonicalRoot, gitNetwork: true, gitPush: true, env: [], help: false, version: false };
    backend = new LocalWorkspaceBackend(canonicalRoot, options);
  });

  afterEach(async () => {
    await backend.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('refuses repository creation with a structured unsupported error', async () => {
    const result = await backend.call('github_repository_create', { owner: 'acme', name: 'x', visibility: 'private', idempotencyKey: 'local-create-1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED', retryable: false, operation: 'github_repository_create' } });
  });

  it('reports repository creation as unavailable in workspace_capabilities', async () => {
    const result = await backend.call('workspace_capabilities', {});
    const capability = GitHubRepositoryCreateCapabilitySchema.parse((result.data as { githubRepositoryCreate: unknown }).githubRepositoryCreate);
    expect(capability).toMatchObject({ available: false, organizations: [], personalAccounts: false });
  });
});
