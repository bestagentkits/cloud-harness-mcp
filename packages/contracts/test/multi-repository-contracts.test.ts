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

  const workspaceId = `ws_${'a'.repeat(32)}`;

  it('registers repository add and remove as idempotent writes with a required key', () => {
    expect(TOOL_SPECS.find((entry) => entry.name === 'workspace_repo_add')).toMatchObject({ readOnly: false, destructive: false, idempotent: true, openWorld: true });
    expect(TOOL_SPECS.find((entry) => entry.name === 'workspace_repo_remove')).toMatchObject({ readOnly: false, destructive: true, idempotent: true });

    const add = TOOL_SCHEMA_BY_NAME.workspace_repo_add;
    const entry = { workspaceId, url: 'https://github.com/acme/docs.git', alias: 'docs', idempotencyKey: 'add-docs-1' };
    expect(add.parse(entry)).toMatchObject({ alias: 'docs', access: 'read-write' });
    expect(add.parse({ ...entry, ref: 'main', access: 'read-only' })).toMatchObject({ ref: 'main', access: 'read-only' });
    expect(() => add.parse({ ...entry, idempotencyKey: undefined })).toThrow();
    expect(() => add.parse({ ...entry, alias: 'repo_docs' })).toThrow();
    expect(() => add.parse({ ...entry, primary: true })).toThrow();

    const remove = TOOL_SCHEMA_BY_NAME.workspace_repo_remove;
    expect(remove.parse({ workspaceId, repositoryId: 'docs', idempotencyKey: 'rm-docs-1' })).toMatchObject({ repositoryId: 'docs' });
    expect(() => remove.parse({ workspaceId, idempotencyKey: 'rm-docs-1' })).toThrow();
    expect(() => remove.parse({ workspaceId, repositoryId: '../docs', idempotencyKey: 'rm-docs-1' })).toThrow();
  });

  it('accepts scope "all" on the search tools, exclusive of repositoryId, and keeps the default shape', () => {
    const searches = [
      ['grep_search', { pattern: 'x' }],
      ['symbols_search', { query: 'x' }],
      ['symbols_references', { symbol: 'x' }]
    ] as const;
    for (const [name, input] of searches) {
      const schema = TOOL_SCHEMA_BY_NAME[name];
      expect(schema.parse({ ...input, scope: 'all', cursor: `repo_${'a'.repeat(32)}` }), name).toMatchObject({ scope: 'all' });
      expect(() => schema.parse({ ...input, scope: 'all', repositoryId: 'api' }), name).toThrow(/mutually exclusive/);
      expect(() => schema.parse({ ...input, scope: 'workspace' }), name).toThrow();
      const plain = schema.parse(input);
      expect(plain, name).not.toHaveProperty('scope');
      expect(schema.parse({ ...input, repositoryId: 'api' }), name).toMatchObject({ repositoryId: 'api' });
    }
  });

  it('accepts a repository selector on artifact snapshot and restore', () => {
    expect(TOOL_SCHEMA_BY_NAME.artifacts_snapshot.parse({ workspaceId, repositoryId: 'web', path: 'a.md', logicalName: 'a.md' }))
      .toMatchObject({ repositoryId: 'web' });
    expect(TOOL_SCHEMA_BY_NAME.artifacts_restore.parse({ artifactId: `art_${'b'.repeat(24)}`, workspaceId, repositoryId: 'web', path: 'a.md' }))
      .toMatchObject({ repositoryId: 'web' });
    expect(() => TOOL_SCHEMA_BY_NAME.artifacts_snapshot.parse({ workspaceId, repositoryId: '../web', path: 'a.md', logicalName: 'a.md' })).toThrow();
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
