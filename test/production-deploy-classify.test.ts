import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyProductionDeploy,
  createGitHubApi,
  isReleaseCommitSubject
} from '../scripts/classify-production-deploy.mjs';

const deployWorkflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const releaseConfig = JSON.parse(readFileSync('.releaserc.json', 'utf8')) as { plugins: unknown[] };

function jobSection(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) return '';
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

const MERGE = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

type Run = { id: number; status: string; conclusion: string | null };
type Head = { sha: string; subject: string; parents: string[] };

function fakeApi({
  releaseRuns = [[{ id: 1, status: 'completed', conclusion: 'success' }]],
  head = { sha: MERGE, subject: 'fix: change', parents: [OTHER] },
  ciRuns = []
}: { releaseRuns?: Run[][]; head?: Head | Error; ciRuns?: Run[] }) {
  let releaseCalls = 0;
  return {
    releaseQueries: [] as string[],
    get releaseCalls() {
      return releaseCalls;
    },
    async releaseRuns(sha: string) {
      this.releaseQueries.push(sha);
      const runs = releaseRuns[Math.min(releaseCalls, releaseRuns.length - 1)];
      releaseCalls += 1;
      return runs;
    },
    async mainHead() {
      if (head instanceof Error) throw head;
      return head;
    },
    async ciRuns() {
      return ciRuns;
    }
  };
}

function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    }
  };
}

const releaseHead: Head = { sha: RELEASE, subject: 'chore(release): 1.2.3 [skip ci]', parents: [MERGE] };

function classify(api: ReturnType<typeof fakeApi>, overrides: Record<string, unknown> = {}) {
  return classifyProductionDeploy({
    eventName: 'workflow_run',
    targetSha: MERGE,
    triggerSha: MERGE,
    api,
    ...clock(),
    ...overrides
  });
}

describe('production deploy classification', () => {
  it('always deploys a manual dispatch without querying GitHub', async () => {
    const api = fakeApi({ head: new Error('must not be called') });
    await expect(classify(api, { eventName: 'workflow_dispatch' })).resolves.toEqual({
      shouldDeploy: true,
      reason: 'manual dispatch'
    });
    expect(api.releaseCalls).toBe(0);
  });

  it('deploys a merge commit that is still the head of main after Release finished', async () => {
    const result = await classify(fakeApi({}));
    expect(result.shouldDeploy).toBe(true);
    expect(result.reason).toContain('head of main');
  });

  it('deploys a release commit whose own CI run triggered the deploy', async () => {
    const api = fakeApi({ head: releaseHead });
    const result = await classify(api, { targetSha: RELEASE, triggerSha: RELEASE });
    expect(result).toEqual({ shouldDeploy: true, reason: 'commit is the head of main: chore(release): 1.2.3 [skip ci]' });
    expect(api.releaseQueries).toEqual([RELEASE]);
  });

  it('skips a merge commit superseded by its release commit while that commit has a live CI run', async () => {
    for (const run of [
      { id: 7, status: 'queued', conclusion: null },
      { id: 7, status: 'in_progress', conclusion: null },
      { id: 7, status: 'completed', conclusion: 'success' }
    ]) {
      const result = await classify(fakeApi({ head: releaseHead, ciRuns: [run] }));
      expect(result).toEqual({
        shouldDeploy: false,
        reason: `superseded by release commit ${RELEASE}; CI run 7 deploys it`
      });
    }
  });

  it('deploys the merge commit when the release commit has no CI run that can deploy it', async () => {
    for (const ciRuns of [[], [{ id: 8, status: 'completed', conclusion: 'failure' }], [{ id: 9, status: 'completed', conclusion: 'cancelled' }]]) {
      const result = await classify(fakeApi({ head: releaseHead, ciRuns }));
      expect(result.shouldDeploy).toBe(true);
      expect(result.reason).toContain('has no CI run');
    }
  });

  it('does not skip for a release commit built on another parent or a non-release head', async () => {
    const foreignRelease = { ...releaseHead, parents: [OTHER] };
    const ordinaryHead = { sha: OTHER, subject: 'feat: newer merge', parents: [MERGE] };
    for (const head of [foreignRelease, ordinaryHead]) {
      const result = await classify(fakeApi({ head, ciRuns: [{ id: 1, status: 'queued', conclusion: null }] }));
      expect(result.shouldDeploy).toBe(true);
      expect(result.reason).toContain('deploying this commit as before');
    }
  });

  it('waits for the Release run before reading the head of main', async () => {
    const api = fakeApi({
      head: releaseHead,
      ciRuns: [{ id: 3, status: 'queued', conclusion: null }],
      releaseRuns: [
        [],
        [{ id: 1, status: 'in_progress', conclusion: null }],
        [{ id: 1, status: 'in_progress', conclusion: null }, { id: 2, status: 'completed', conclusion: 'skipped' }],
        [{ id: 1, status: 'completed', conclusion: 'success' }, { id: 2, status: 'completed', conclusion: 'skipped' }]
      ]
    });
    const result = await classify(api);
    expect(api.releaseCalls).toBe(4);
    expect(result.shouldDeploy).toBe(false);
  });

  it('deploys when Release is still running at the deadline', async () => {
    const api = fakeApi({ head: releaseHead, releaseRuns: [[{ id: 1, status: 'in_progress', conclusion: null }]] });
    const result = await classify(api, { releaseWaitMs: 30_000, pollMs: 10_000 });
    expect(result).toEqual({ shouldDeploy: true, reason: 'Release is still running after the wait; deploying' });
    expect(api.releaseCalls).toBe(4);
  });

  it('stops waiting for a Release run that never appears', async () => {
    const api = fakeApi({ releaseRuns: [[]] });
    const result = await classify(api, { releaseAppearMs: 20_000, pollMs: 10_000 });
    expect(result.shouldDeploy).toBe(true);
    expect(api.releaseCalls).toBe(3);
  });

  it('fails open when GitHub cannot be read', async () => {
    const result = await classify(fakeApi({ head: new Error('GET /commits/main returned 502') }));
    expect(result).toEqual({
      shouldDeploy: true,
      reason: 'classification unavailable (GET /commits/main returned 502); deploying'
    });
  });

  it('recognises release subjects with and without the legacy literal newline suffix', () => {
    expect(isReleaseCommitSubject('chore(release): 0.63.3 [skip ci]')).toBe(true);
    expect(isReleaseCommitSubject('chore(release): 0.63.3 [skip ci]\\n\\n## [0.63.3](https://example.invalid)')).toBe(true);
    expect(isReleaseCommitSubject('chore: refresh release tooling')).toBe(false);
    expect(isReleaseCommitSubject('fix(release): repair metadata')).toBe(false);
  });

  it('queries the GitHub REST endpoints with the workflow token', async () => {
    const requests: Array<{ url: string; authorization: string }> = [];
    const responses: Record<string, unknown> = {
      '/actions/workflows/release.yml/runs': { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'skipped', extra: true }] },
      '/commits/main': { sha: RELEASE, commit: { message: 'chore(release): 1.2.3 [skip ci]\n\nnotes' }, parents: [{ sha: MERGE }] },
      '/actions/workflows/ci.yml/runs': { workflow_runs: [{ id: 2, status: 'queued', conclusion: null }] }
    };
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, authorization: init.headers.authorization });
      const path = new URL(url).pathname.replace('/repos/owner/repo', '');
      return new Response(JSON.stringify(responses[path]), { status: 200 });
    };
    const api = createGitHubApi({ token: 'token-value', repository: 'owner/repo', fetchImpl: fetchImpl as typeof fetch });

    await expect(api.releaseRuns(MERGE)).resolves.toEqual([{ id: 1, status: 'completed', conclusion: 'skipped' }]);
    await expect(api.mainHead()).resolves.toEqual({ sha: RELEASE, subject: 'chore(release): 1.2.3 [skip ci]', parents: [MERGE] });
    await expect(api.ciRuns(RELEASE)).resolves.toEqual([{ id: 2, status: 'queued', conclusion: null }]);
    expect(requests.map((request) => request.url)).toEqual([
      `https://api.github.com/repos/owner/repo/actions/workflows/release.yml/runs?event=workflow_run&head_sha=${MERGE}&per_page=100`,
      'https://api.github.com/repos/owner/repo/commits/main',
      `https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&head_sha=${RELEASE}&per_page=100`
    ]);
    expect(requests.every((request) => request.authorization === 'Bearer token-value')).toBe(true);
  });

  it('turns a non-2xx GitHub response into a fail-open classification', async () => {
    const api = createGitHubApi({
      token: 'token-value',
      repository: 'owner/repo',
      fetchImpl: (async () => new Response('{}', { status: 403 })) as typeof fetch
    });
    const result = await classify(api as ReturnType<typeof fakeApi>);
    expect(result.shouldDeploy).toBe(true);
    expect(result.reason).toContain('returned 403');
  });
});

describe('production deploy workflow', () => {
  const classifyJob = jobSection(deployWorkflow, 'classify');
  const deployJob = jobSection(deployWorkflow, 'deploy');

  it('runs the classification script with the deploy target and the trigger commit', () => {
    expect(classifyJob).toContain('timeout-minutes: 15');
    expect(classifyJob).toContain('persist-credentials: false');
    expect(classifyJob).toContain('run: node scripts/classify-production-deploy.mjs');
    expect(classifyJob).toContain(
      "TARGET_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.commit || github.sha }}"
    );
    expect(classifyJob).toContain('TRIGGER_SHA: ${{ github.sha }}');
    expect(classifyJob).toContain('should_deploy: ${{ steps.classify.outputs.should_deploy }}');
  });

  it('never skips a deploy because the commit is a release commit', () => {
    expect(deployWorkflow).not.toContain('[skip ci]');
    expect(deployWorkflow).not.toMatch(/release_subject_pattern/);
  });

  it('keeps the CI-success and main-branch workflow_run guard', () => {
    expect(deployJob).toContain('needs: classify');
    expect(deployJob).toContain("needs.classify.outputs.should_deploy == 'true'");
    expect(deployJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(deployJob).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deployJob).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deployJob).toContain(
      "RELEASE_SHA: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.commit || github.sha }}"
    );
  });

  it('keeps the manual-dispatch CI verification, SSH material, and deploy command', () => {
    expect(deployJob).toContain("- name: Verify manual release passed CI\n        if: github.event_name == 'workflow_dispatch'");
    expect(deployJob).toContain('.head_sha == \\"$RELEASE_SHA\\"');
    expect(deployJob).toContain('environment: production');
    expect(deployJob).toContain('- name: Install ephemeral SSH material');
    expect(deployJob).toContain('- name: Deploy exact tested commit');
    expect(deployJob).toContain("sudo -n /usr/local/sbin/cloud-harness-deploy '$RELEASE_SHA'");
  });
});

describe('release commit CI request', () => {
  const step = releaseWorkflow.slice(releaseWorkflow.indexOf('- name: Request CI for the release commit'));

  it('requests CI only after semantic-release, only on main, and with Actions write access', () => {
    expect(releaseWorkflow).toMatch(/permissions:\n {2}actions: write\n {2}contents: write\n/);
    expect(releaseWorkflow.indexOf('npm exec semantic-release')).toBeLessThan(releaseWorkflow.indexOf('Request CI for the release commit'));
    expect(step).toContain("if: github.event.workflow_run.head_branch == 'main'");
    expect(step).toContain('gh workflow run ci.yml --ref main --repo "$GITHUB_REPOSITORY"');
  });

  it('dispatches only when a release commit was pushed and is still the head of main', () => {
    const noRelease = step.indexOf('if [[ "$release_commit" == "$RELEASE_SHA" ]]');
    const moved = step.indexOf('if [[ "$main_sha" != "$release_commit" ]]');
    const dispatch = step.indexOf('gh workflow run ci.yml');
    expect(noRelease).toBeGreaterThan(-1);
    expect(moved).toBeGreaterThan(noRelease);
    expect(dispatch).toBeGreaterThan(moved);
  });

  it('prefers the release PAT, falls back to the workflow token, and fails loudly otherwise', () => {
    expect(step).toContain('for token in "$RELEASE_TOKEN" "$WORKFLOW_TOKEN"; do');
    expect(step).toContain('RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}');
    expect(step).toContain('WORKFLOW_TOKEN: ${{ github.token }}');
    expect(step).toMatch(/::error::Could not request CI[^\n]*\n\s+exit 1/);
  });

  it('writes a release commit whose subject line is exactly the version subject', () => {
    const git = releaseConfig.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/git') as [
      string,
      { message: string }
    ];
    expect(git[1].message.split('\n')[0]).toBe('chore(release): ${nextRelease.version} [skip ci]');
    expect(git[1].message).toContain('\n\n${nextRelease.notes}');
  });
});

describe('release commit CI request script', () => {
  const step = releaseWorkflow.slice(releaseWorkflow.indexOf('- name: Request CI for the release commit'));
  const script = step
    .slice(step.indexOf('run: |\n') + 'run: |\n'.length)
    .split('\n')
    .filter((line) => line.startsWith('          ') || line === '')
    .map((line) => line.slice(10))
    .join('\n');
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture({ releaseCommit, mainMoved = false, failingTokens = [] as string[] }) {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-release-dispatch-'));
    directories.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: join(root, 'work'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', join(root, 'origin.git')]);
    execFileSync('git', ['clone', '--quiet', join(root, 'origin.git'), join(root, 'work')], { stdio: 'ignore' });
    git('config', 'user.email', 'release-test@example.invalid');
    git('config', 'user.name', 'Release Test');
    git('commit', '--quiet', '--allow-empty', '-m', 'fix: merged change');
    const merge = git('rev-parse', 'HEAD');
    if (releaseCommit) git('commit', '--quiet', '--allow-empty', '-m', 'chore(release): 1.2.3 [skip ci]');
    git('push', '--quiet', 'origin', 'HEAD:main');
    if (mainMoved) {
      const head = git('rev-parse', 'HEAD');
      git('commit', '--quiet', '--allow-empty', '-m', 'feat: newer merge');
      git('push', '--quiet', 'origin', 'HEAD:main');
      git('reset', '--quiet', '--hard', head);
    }
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'gh.log');
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\necho "$GH_TOKEN $*" >> '${log}'\ncase " ${failingTokens.join(' ')} " in *" $GH_TOKEN "*) exit 1 ;; esac\n`
    );
    chmodSync(join(bin, 'gh'), 0o755);
    return { root, merge, log, bin };
  }

  function run(env: ReturnType<typeof fixture>, tokens: { release: string; workflow: string }) {
    const result = spawnSync('bash', ['-c', script], {
      cwd: join(env.root, 'work'),
      encoding: 'utf8',
      env: {
        PATH: `${env.bin}:${process.env.PATH}`,
        RELEASE_SHA: env.merge,
        RELEASE_TOKEN: tokens.release,
        WORKFLOW_TOKEN: tokens.workflow,
        GITHUB_REPOSITORY: 'owner/repo'
      }
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(env.log, 'utf8').trim().split('\n');
    } catch {
      calls = [];
    }
    return { status: result.status, stdout: result.stdout, calls };
  }

  it('does nothing when semantic-release created no version commit', () => {
    const result = run(fixture({ releaseCommit: false }), { release: 'pat', workflow: 'wf' });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain('No version commit was created');
  });

  it('does nothing when main already moved past the release commit', () => {
    const result = run(fixture({ releaseCommit: true, mainMoved: true }), { release: 'pat', workflow: 'wf' });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain('main moved to');
  });

  it('dispatches CI on main with the release PAT', () => {
    const result = run(fixture({ releaseCommit: true }), { release: 'pat', workflow: 'wf' });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['pat workflow run ci.yml --ref main --repo owner/repo']);
  });

  it('falls back to the workflow token when the PAT is missing or refused', () => {
    expect(run(fixture({ releaseCommit: true }), { release: '', workflow: 'wf' }).calls).toEqual([
      'wf workflow run ci.yml --ref main --repo owner/repo'
    ]);
    const refused = run(fixture({ releaseCommit: true, failingTokens: ['pat'] }), { release: 'pat', workflow: 'wf' });
    expect(refused.status).toBe(0);
    expect(refused.calls).toEqual(['pat workflow run ci.yml --ref main --repo owner/repo', 'wf workflow run ci.yml --ref main --repo owner/repo']);
  });

  it('fails the job when no token can dispatch CI', () => {
    const result = run(fixture({ releaseCommit: true, failingTokens: ['pat', 'wf'] }), { release: 'pat', workflow: 'wf' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Could not request CI for release commit');
  });
});
