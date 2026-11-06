import { answer, type ReadHandler } from '../support';
import { activeWorkspace, contextProjection, runtimeProjection } from './workspaces';

// Reads for every cockpit tab (Files, Git, Automation, Deploy, Artifacts, the Runtime task
// graph), shared by the behavioural tab spec and the screenshot baselines.

export const SHA = 'a'.repeat(64);
export const SHA_NEXT = 'b'.repeat(64);
/** A workspace whose header offers every lifecycle action, at a known generation. */
export const cockpitWorkspace = { ...activeWorkspace, version: 7, availableActions: [...activeWorkspace.availableActions, 'workspace_finalize', 'workspace_recover'] };

export const cockpitTabReads = (base: string): Record<string, ReadHandler> => ({
  [base]: answer(200, { data: cockpitWorkspace }),
  [`${base}/context`]: answer(200, contextProjection),
  [`${base}/runtime`]: answer(200, runtimeProjection),
  [`${base}/files`]: (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '.';
    return answer(200, { data: path === 'src'
      ? { path: 'src', entries: [{ name: 'main.ts', type: 'file' }, { name: 'lib', type: 'directory' }] }
      : { path: '.', entries: [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }] } })(route);
  },
  [`${base}/files/content`]: answer(200, { data: { path: 'src/main.ts', content: 'export const answer = 41;\n', sha256: SHA, bytes: 26 } }),
  [`${base}/git/status`]: answer(200, { data: { branch: 'feature/launch', upstream: 'origin/feature/launch', ahead: 1, behind: 0, staged: 1, modified: 1, untracked: 0, entries: [{ code: 'M', path: 'src/main.ts' }] } }),
  [`${base}/git/diff`]: (route) => answer(200, { data: { diff: new URL(route.request().url()).searchParams.get('staged') === 'true' ? '+staged line' : '+unstaged line' } })(route),
  [`${base}/git/log`]: answer(200, { data: { commits: [{ oid: 'abc1234', subject: 'Add launch', author: 'Owner' }] } }),
  [`${base}/worktrees`]: answer(200, { data: { worktrees: [] } }),
  [`${base}/skills`]: answer(200, { data: { skills: [{ name: 'lint', tier: 'library', description: 'Runs the linters.', sha256: SHA }] } }),
  [`${base}/hooks`]: answer(200, { data: { hooks: [{ name: 'format', events: ['pre_commit'], active: true }], manifestSha256: SHA_NEXT } }),
  [`${base}/deployments`]: answer(200, { data: { deployments: [{ name: 'production', cwd: 'deploy', lastResult: 'succeeded', durationMs: 900 }, { name: 'staging', cwd: 'deploy' }] } }),
  [`${base}/artifacts`]: answer(200, { data: { artifacts: [{ artifactId: 'art_tab_01', logicalName: 'bundle.tgz', sha256: SHA, sizeBytes: 2048, expiresAt: '2030-01-01T00:00:00.000Z', generation: 1 }] } }),
  [`${base}/tasks/graph`]: answer(200, { data: {
    nodes: [{ id: 'task_build_01', name: 'npm run build', status: 'succeeded', exitCode: 0 }, { id: 'task_test_01', name: 'npm test', status: 'running' }],
    edges: [{ from: 'task_build_01', to: 'task_test_01' }]
  } })
});
