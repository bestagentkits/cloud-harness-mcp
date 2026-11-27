import { describe, expect, it } from 'vitest';
import { ErrorCodeSchema, GitHubRepositoryCreateInputSchema, TOOL_SCHEMA_BY_NAME, TOOL_SPECS } from '../src/index.js';

const valid = { owner: 'acme-labs', name: 'service.api_v2', visibility: 'public', idempotencyKey: 'create-service-1' } as const;

describe('github_repository_create contract', () => {
  it('is registered as a workspace-free, approval-worthy, non-idempotent open-world tool', () => {
    const spec = TOOL_SPECS.find((tool) => tool.name === 'github_repository_create');
    expect(spec).toMatchObject({ readOnly: false, destructive: true, idempotent: false, openWorld: true });
    expect(spec?.description).toMatch(/Administration: write/);
    expect(TOOL_SCHEMA_BY_NAME.github_repository_create.safeParse({ ...valid, workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa' }).success).toBe(false);
  });

  it('requires visibility and an idempotency key with no defaults', () => {
    expect(GitHubRepositoryCreateInputSchema.parse(valid)).toEqual(valid);
    for (const field of ['visibility', 'idempotencyKey'] as const) {
      const input: Record<string, unknown> = { ...valid };
      delete input[field];
      expect(GitHubRepositoryCreateInputSchema.safeParse(input).success, field).toBe(false);
    }
    expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, visibility: 'internal' }).success).toBe(false);
  });

  it('applies GitHub naming rules to owner and name instead of rewriting them', () => {
    for (const owner of ['-acme', 'acme-', 'ac--me', 'a'.repeat(40), 'acme/labs', '']) {
      expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, owner }).success, owner).toBe(false);
    }
    for (const name of ['.', '..', 'repo.git', 'has space', 'émoji', 'a/b', 'x'.repeat(101), '']) {
      expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, name }).success, name).toBe(false);
    }
    for (const name of ['a', '.github', 'my-repo_1.0']) {
      expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, name }).success, name).toBe(true);
    }
  });

  it('bounds optional settings and refuses templates on an explicitly empty repository', () => {
    expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, autoInit: true, gitignoreTemplate: 'Node', licenseTemplate: 'apache-2.0', description: 'Service' }).success).toBe(true);
    expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, autoInit: false, licenseTemplate: 'mit' }).success).toBe(false);
    expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, description: 'line\nbreak' }).success).toBe(false);
    expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, description: 'x'.repeat(351) }).success).toBe(false);
    expect(GitHubRepositoryCreateInputSchema.safeParse({ ...valid, defaultBranch: 'main' }).success).toBe(false);
  });

  it('exposes a distinct already-exists error code', () => {
    expect(ErrorCodeSchema.options).toContain('GITHUB_REPOSITORY_EXISTS');
  });
});

describe('github_repositories_list contract', () => {
  it('is a workspace-free, read-only, idempotent open-world tool with bounded paging', () => {
    const spec = TOOL_SPECS.find((tool) => tool.name === 'github_repositories_list');
    expect(spec).toMatchObject({ readOnly: true, destructive: false, idempotent: true, openWorld: true });
    const schema = TOOL_SCHEMA_BY_NAME.github_repositories_list;
    expect(schema.parse({})).toEqual({ refresh: false, limit: 200 });
    expect(schema.safeParse({ workspaceId: 'ws_aaaaaaaaaaaaaaaaaaaa' }).success).toBe(false);
    expect(schema.safeParse({ limit: 501 }).success).toBe(false);
    expect(schema.safeParse({ cursor: '-1' }).success).toBe(false);
    expect(schema.safeParse({ owner: 'acme/labs' }).success).toBe(false);
    expect(schema.safeParse({ owner: 'developer_company' }).success).toBe(true);
    expect(schema.safeParse({ owner: '_company' }).success).toBe(false);
    expect(schema.safeParse({ owner: 'alice', query: 'api', cursor: '200', limit: 50 }).success).toBe(true);
  });
});
