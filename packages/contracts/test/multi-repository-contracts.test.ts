import { describe, expect, it } from 'vitest';
import { RepositoryIdSchema, RunnerConfigSchema, TOOL_SCHEMA_BY_NAME, TOOL_SPECS } from '../src/index.js';

const open = TOOL_SCHEMA_BY_NAME.workspace_open;
const base = { idempotencyKey: 'open-multi-1' };
const repositories = [
  { url: 'https://github.com/acme/api.git', alias: 'api' },
  { url: 'https://github.com/acme/web', alias: 'web', ref: 'main', access: 'read-only' as const }
];

describe('multi-repository workspace contracts', () => {
  it('keeps the single-repository open shape unchanged', () => {
    const parsed = open.parse({ ...base, repositoryUrl: 'https://github.com/acme/api.git', ref: 'main' });
    expect(parsed.repositoryUrl).toBe('https://github.com/acme/api.git');
    expect(parsed.repositories).toBeUndefined();
  });

  it('accepts a repositories set and defaults access to read-write', () => {
    const parsed = open.parse({ ...base, repositories, primaryRepositoryAlias: 'web' });
    expect(parsed.repositories?.map((entry) => [entry.alias, entry.access])).toEqual([['api', 'read-write'], ['web', 'read-only']]);
  });

  it('requires exactly one of repositoryUrl and repositories', () => {
    expect(() => open.parse(base)).toThrow(/either repositoryUrl or repositories/);
    expect(() => open.parse({ ...base, repositoryUrl: 'https://github.com/acme/api', repositories })).toThrow(/either repositoryUrl or repositories/);
  });

  it('rejects a top-level ref, duplicate aliases, duplicate URLs, and an unknown primary alias', () => {
    expect(() => open.parse({ ...base, repositories, ref: 'main' })).toThrow(/each repositories entry/);
    expect(() => open.parse({ ...base, repositories: [repositories[0], { url: 'https://github.com/acme/other', alias: 'api' }] })).toThrow(/duplicate repository alias/);
    expect(() => open.parse({ ...base, repositories: [repositories[0], { url: 'https://GitHub.com/acme/API/', alias: 'api2' }] })).toThrow(/duplicate repository URL/);
    expect(() => open.parse({ ...base, repositories, primaryRepositoryAlias: 'docs' })).toThrow(/must name one of the repositories/);
    expect(() => open.parse({ ...base, repositoryUrl: 'https://github.com/acme/api', primaryRepositoryAlias: 'api' })).toThrow(/requires repositories/);
  });

  it('rejects aliases that could escape repos/ or collide with repo_ ids', () => {
    for (const alias of ['..', 'a/b', 'repo_x', 'API', '-api', 'api-', '', 'a'.repeat(41)]) {
      expect(() => open.parse({ ...base, repositories: [{ url: 'https://github.com/acme/api', alias }] }), alias).toThrow();
    }
    expect(() => open.parse({ ...base, repositories: [{ url: 'https://github.com/acme/api', alias: 'api', extra: true }] })).toThrow();
  });

  it('bounds the repository set by the schema limit', () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ url: `https://github.com/acme/r${index}`, alias: `r${index}` }));
    expect(() => open.parse({ ...base, repositories: many })).toThrow();
    expect(open.parse({ ...base, repositories: many.slice(0, 20) }).repositories).toHaveLength(20);
  });

  it('accepts a repo_ id or an alias as the selector on repository-aware tools', () => {
    const id = `repo_${'a'.repeat(32)}`;
    expect(RepositoryIdSchema.parse(id)).toBe(id);
    for (const operation of ['git_status', 'git_push', 'files_read', 'exec_run', 'workspace_finalize', 'worktrees_create'] as const) {
      expect(TOOL_SCHEMA_BY_NAME[operation].safeParse({ repositoryId: 'api' }).error?.issues.some((issue) => issue.path[0] === 'repositoryId'), operation).not.toBe(true);
      expect(TOOL_SCHEMA_BY_NAME[operation].safeParse({ repositoryId: '../api' }).error?.issues.some((issue) => issue.path[0] === 'repositoryId'), operation).toBe(true);
    }
    expect(TOOL_SCHEMA_BY_NAME.github_read.parse({ repositoryId: id, action: 'pr_list' })).toMatchObject({ repositoryId: id });
    expect(TOOL_SCHEMA_BY_NAME.github_action.parse({ repositoryId: 'web', action: 'pr_list' })).toMatchObject({ repositoryId: 'web' });
  });

  it('registers the repository listing and status tools as read-only', () => {
    for (const name of ['workspace_repos_list', 'workspace_repo_status']) {
      const spec = TOOL_SPECS.find((entry) => entry.name === name);
      expect(spec, name).toMatchObject({ readOnly: true, destructive: false, idempotent: true });
    }
  });

  it('lets the operator lower the per-workspace repository limit but not exceed the schema bound', () => {
    const runner = {
      serviceToken: 'runner-token-that-is-longer-than-32-characters', jobsRoot: '/jobs', stateDb: '/state/state.db',
      executorImage: 'executor:latest', allowedGitHosts: ['github.com']
    };
    expect(RunnerConfigSchema.parse(runner).maxWorkspaceRepositories).toBe(5);
    expect(RunnerConfigSchema.parse({ ...runner, maxWorkspaceRepositories: '2' }).maxWorkspaceRepositories).toBe(2);
    expect(() => RunnerConfigSchema.parse({ ...runner, maxWorkspaceRepositories: '21' })).toThrow();
  });
});
