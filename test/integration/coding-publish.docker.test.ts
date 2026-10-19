import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { CodingActionBroker } from '../../apps/runner/src/agent-governance/action-broker.js';
import {
  CODING_GIT_ARGS, CODING_GIT_ENV, createCodingGitPort, parseTransferInspection, type CodingGitRunner
} from '../../apps/runner/src/agent-governance/coding-git.js';
import {
  CODING_COMMIT_AUTHOR, codingBranch, codingCommitMessage, CodingWorkflowEngine, type CodingPublishPort
} from '../../apps/runner/src/automation-coding.js';
import { CODING_GLOBAL_POLICY, CODING_PROJECT, CODING_REPOSITORY, createPolicyService, insertCodingWorkflow } from '../../apps/runner/test/support/coding-policy.js';
import { dockerPrerequisiteIssue, requireDockerPrerequisites } from '../agent-docker-test-support.js';

/**
 * The coding publish path against Git tricks a repository can play on its own checkout, with the real
 * executor image: replace refs re-enabled by core.useReplaceRefs, a work tree moved by core.worktree with
 * relative diff listings, and grafts. Each one makes a plain read of the checkout report a harmless
 * commit while the push would send something else. The runner's hardened checkout reads see through
 * them, and the decision that counts, made by the transfer helper's `inspect` on the staged clone the
 * push sends from, refuses the push: nothing reaches the remote and the run fails with the reason.
 */
const image = process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local';
const prerequisiteIssue = dockerPrerequisiteIssue([image]);
requireDockerPrerequisites(prerequisiteIssue);

const OWNER = 'owner';
const owner: RunnerPrincipalSelector = { kind: 'owner', ownerId: OWNER };
const WORKFLOW = `wfl_${'d'.repeat(32)}`;
const BRANCH = codingBranch(7, WORKFLOW);
const EVIL = '.github/workflows/evil.yml';

let volume: string;

function docker(args: string[], input = ''): { status: number; stdout: string; stderr: string } {
  const ran = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 16 * 1_048_576 });
  return { status: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
}

/** A shell script in the executor image as the executor user: what repository code can do to its checkout. */
function asExecutor(script: string): string {
  const ran = docker([
    'run', '--rm', '--pull', 'never', '--network', 'none', '--user', '10001:10001', '--volume', `${volume}:/job:rw`,
    '--env', 'HOME=/tmp/home', '--env', 'GIT_AUTHOR_NAME=Agent', '--env', 'GIT_AUTHOR_EMAIL=agent@example.invalid',
    '--env', 'GIT_COMMITTER_NAME=Agent', '--env', 'GIT_COMMITTER_EMAIL=agent@example.invalid',
    '--entrypoint', '/bin/bash', image, '-c', `set -euo pipefail; mkdir -p /tmp/home; ${script}`
  ]);
  if (ran.status !== 0) throw new Error(`executor script failed: ${ran.stderr}`);
  return ran.stdout.trim();
}

/** The transfer helper as the workspace service runs it, with the job volume in place of the workspace directory. */
function helper(mode: string, repository: string, transfer: string, argument = '', expected = '') {
  return docker([
    'run', '-i', '--rm', '--pull', 'never', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
    '--env', 'HOME=/tmp/cloud-harness-home', '--env', 'GIT_CONFIG_NOSYSTEM=1', '--env', 'GIT_TERMINAL_PROMPT=0',
    '--volume', `${volume}:/job:rw`, '--entrypoint', '/opt/harness/git-transfer-helper.sh',
    image, mode, remoteOf(repository), repository, transfer, argument, expected, ''
  ], '\n');
}

const remoteOf = (repository: string) => `/job/remotes/${repository.split('/')[2]}.git`;

/** The workspace service's checkout inspection (`runCodingGit`), against a checkout in the job volume. */
const inspectIn = (repository: string): CodingGitRunner => async (_owner, _workspace, args) => {
  const ran = docker([
    'run', '--rm', '--pull', 'never', '--network', 'none', '--user', '10001:10001', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...CODING_GIT_ENV.flatMap((entry) => ['--env', entry]),
    '--volume', `${volume}:/job:ro`, '--workdir', repository, '--entrypoint', '/usr/bin/git', image, ...CODING_GIT_ARGS, ...args
  ]);
  return { exitCode: ran.status, stdout: ran.stdout, truncated: false };
};

/**
 * A checkout with a base commit pushed to its own remote, the repository's `plant` script, then the
 * runner's commit as `git_commit` makes it (in the checkout, with the checkout's own configuration).
 */
function checkout(name: string, plant: string): { repository: string; base: string; sha: string } {
  const repository = `/job/${name}/repo`;
  const remote = remoteOf(repository);
  const [base, sha] = asExecutor([
    `mkdir -p /job/remotes ${repository}`,
    `git init -q --bare -b main ${remote}`,
    `cd ${repository} && git init -q -b main . && mkdir -p src && echo 'export const a = 1;' > src/a.mjs`,
    'git add -A && git commit -qm base',
    `git push -q ${remote} main`,
    'BASE=$(git rev-parse HEAD)',
    plant,
    `git checkout -qb ${BRANCH}`,
    'git -c core.hooksPath=/dev/null add --all',
    // The worker commits as the runner's identity with the runner's message; the executor's own identity
    // variables are dropped so they cannot override it.
    `echo ${Buffer.from(codingCommitMessage(7, 'Fix issues', WORKFLOW)).toString('base64')} | base64 -d > /tmp/message`,
    'env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL git -c core.hooksPath=/dev/null'
      + ` -c user.name="${CODING_COMMIT_AUTHOR.name}" -c user.email=${CODING_COMMIT_AUTHOR.email} commit -q --no-gpg-sign -F /tmp/message`,
    'echo "$BASE $(git rev-parse HEAD)"'
  ].join('\n')).split(' ');
  return { repository, base: base!, sha: sha! };
}

/** The engine's push step for a commit the checkout already holds, published through the real helper. */
async function publishFrom(target: { repository: string; base: string; sha: string }) {
  const database = new DatabaseSync(':memory:');
  try {
    const policies = createPolicyService(database, (selector) => (selector.kind === 'owner' ? selector.ownerId : 'external'), owner);
    policies.saveGlobal(CODING_GLOBAL_POLICY);
    const broker = new CodingActionBroker({ database, enabled: () => true, policies: policies.service, workspaces: { generation: () => 1, repositoryCount: () => 1 } });
    const admitted = await broker.admit(OWNER, CODING_PROJECT, { version: 1, actionClass: 'read', repository: CODING_REPOSITORY }, 0);
    insertCodingWorkflow(database, {
      id: WORKFLOW, ownerId: OWNER, codingPhase: 'PUSH', baseOid: target.base,
      policyRevisionJson: JSON.stringify({ globalRevisionId: admitted.policy.globalRevisionId, projectRevisionId: admitted.policy.projectRevisionId })
    });
    database.prepare('UPDATE automation_workflows SET branch = ?, commit_sha = ? WHERE id = ?').run(BRANCH, target.sha, WORKFLOW);
    const sent: string[] = [];
    const publish: CodingPublishPort = async (_owner, input, verifier) => {
      const transfer = `/job/transfers/t-${randomBytes(6).toString('hex')}`;
      try {
        const staged = helper('stage-push', target.repository, transfer, 'isolated');
        expect(staged.status, staged.stderr).toBe(0);
        // The helper's answers carry no graft deprecation hint, whatever the checkout holds.
        expect(staged.stderr).not.toMatch(/graft/iu);
        const inspected = helper('inspect', target.repository, transfer, verifier.sha, verifier.base);
        if (inspected.status !== 0) {
          verifier.stagingFailed?.();
          return { ok: false, error: { code: 'UNAVAILABLE', retryable: true } };
        }
        if (await verifier.verify(parseTransferInspection(inspected.stdout, false)) !== null) return { ok: false, error: { code: 'FORBIDDEN', retryable: false } };
        const pushed = helper('push', target.repository, transfer, String(input.refspec), 'absent');
        if (pushed.status !== 0) return { ok: false, error: { code: 'CONFLICT', retryable: false } };
        sent.push(String(input.refspec));
        return { ok: true, data: { output: pushed.stdout } };
      } finally {
        asExecutor(`rm -rf ${transfer}`);
      }
    };
    const outcome = { state: 'RUNNING', code: null as string | null };
    const engine = new CodingWorkflowEngine(broker, {
      call: async (_owner, operation, input) => {
        if (operation === 'github_read' && input.action === 'ref_get') {
          const oid = asExecutor(`git --git-dir=${remoteOf(target.repository)} rev-parse --verify --quiet refs/heads/${BRANCH} || true`);
          return { ok: true, data: { output: JSON.stringify(oid ? { exists: true, oid } : { exists: false }) } };
        }
        return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', retryable: false } };
      },
      update: (id, fields) => {
        const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
        database.prepare(`UPDATE automation_workflows SET ${assignments} WHERE id = ?`).run(...Object.values(fields), id);
        return outcome.state === 'RUNNING';
      },
      fail: (_id, code) => { outcome.state = 'FAILED'; outcome.code = code; },
      complete: () => { outcome.state = 'COMPLETED'; },
      now: () => Date.now(),
      publish
    });
    const row = () => database.prepare('SELECT * FROM automation_workflows WHERE id = ?').get(WORKFLOW) as Parameters<CodingWorkflowEngine['advance']>[0];
    await engine.advance(row());
    const push = broker.actions.receipts(OWNER, WORKFLOW).receipts.find((receipt) => receipt.step === 'push');
    const remoteBranches = asExecutor(`git --git-dir=${remoteOf(target.repository)} for-each-ref --format='%(refname)' refs/heads`).split('\n').filter(Boolean);
    return { outcome, phase: row().coding_phase, push, sent, remoteBranches };
  } finally {
    database.close();
  }
}

beforeAll(() => {
  if (prerequisiteIssue) return;
  volume = `cloud-harness-coding-publish-${randomBytes(8).toString('hex')}`;
  expect(docker(['volume', 'create', volume]).status).toBe(0);
  expect(docker(['run', '--rm', '--pull', 'never', '--user', '0:0', '--volume', `${volume}:/job:rw`, '--entrypoint', '/bin/sh', image, '-c', 'chown 10001:10001 /job']).status).toBe(0);
  asExecutor('mkdir -p /job/transfers /job/remotes');
});

afterAll(() => {
  if (volume?.startsWith('cloud-harness-coding-publish-')) docker(['volume', 'rm', '--force', volume]);
});

describe.skipIf(prerequisiteIssue !== undefined)('coding publish against a repository that rewrites its own Git view', { timeout: 300_000 }, () => {
  it('publishes an honest commit, so the refusals below are not vacuous', async () => {
    const target = checkout('honest', "echo 'export const a = 2;' > src/a.mjs");
    const published = await publishFrom(target);
    expect(published.phase).toBe('PR');
    expect(published.sent).toEqual([`${target.sha}:refs/heads/${BRANCH}`]);
    expect(published.remoteBranches).toEqual([`refs/heads/${BRANCH}`, 'refs/heads/main']);
  });

  it('refuses a workflow file hidden by a replace ref that core.useReplaceRefs re-enables', async () => {
    const target = checkout('replace', [
      "echo 'export const a = 2;' > src/a.mjs",
      `mkdir -p .github/workflows && echo 'on: push' > ${EVIL}`,
      // A decoy of the base tree that already holds the workflow file stands in for the real one.
      'export GIT_INDEX_FILE=/tmp/decoy-index',
      'git read-tree "$BASE"',
      `git update-index --add --cacheinfo "100644,$(git hash-object -w ${EVIL}),${EVIL}"`,
      'DECOY=$(git write-tree); unset GIT_INDEX_FILE',
      'git replace "$(git rev-parse "$BASE^{tree}")" "$DECOY"',
      'git config core.useReplaceRefs true'
    ].join('\n'));
    // What a read with only --no-replace-objects saw: the workflow file is not part of the change.
    const plain = asExecutor(`cd ${target.repository} && git --no-replace-objects diff --name-only ${target.base} ${target.sha}`);
    expect(plain.split('\n')).toEqual(['src/a.mjs']);

    const read = await createCodingGitPort(inspectIn(target.repository)).commit(OWNER, 'ws', target.sha, target.base, AbortSignal.timeout(60_000));
    expect(read).toMatchObject({ ok: true, data: { parents: [target.base], paths: [EVIL, 'src/a.mjs'] } });

    const published = await publishFrom(target);
    expect(published.outcome).toEqual({ state: 'FAILED', code: 'ACTION_DENIED:PATH_OUT_OF_SCOPE' });
    expect(published.push).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'ACTION_DENIED:PATH_OUT_OF_SCOPE' } });
    expect(published.sent).toEqual([]);
    expect(published.remoteBranches).toEqual(['refs/heads/main']);
  });

  it('refuses a change hidden by core.worktree and diff.relative', async () => {
    const target = checkout('worktree', [
      "echo 'export const a = 2;' > src/a.mjs",
      `mkdir -p /job/worktree/.github/workflows && echo 'on: push' > /job/worktree/${EVIL}`,
      'git config core.worktree /job/worktree',
      'git config diff.relative true'
    ].join('\n'));
    // What a plain read from the checkout saw: only paths below it, with the prefix stripped.
    const plain = asExecutor(`cd ${target.repository} && git --no-replace-objects diff --name-only ${target.base} ${target.sha}`);
    expect(plain.split('\n')).not.toContain(EVIL);

    const read = await createCodingGitPort(inspectIn(target.repository)).commit(OWNER, 'ws', target.sha, target.base, AbortSignal.timeout(60_000));
    // The real change: the workflow file outside the checkout, and the source file moved under it.
    expect(read.ok && read.data.paths).toEqual(expect.arrayContaining([EVIL, 'src/a.mjs']));

    const published = await publishFrom(target);
    expect(published.outcome).toEqual({ state: 'FAILED', code: 'ACTION_DENIED:PATH_OUT_OF_SCOPE' });
    expect(published.sent).toEqual([]);
    expect(published.remoteBranches).toEqual(['refs/heads/main']);
  });

  it('refuses history hidden behind a graft that claims the base as the parent', async () => {
    const target = checkout('graft', [
      // A commit that adds the workflow file, and the change on top of it that removes it again.
      `mkdir -p .github/workflows && echo 'on: push' > ${EVIL} && git add -A && git commit -qm 'chore: ci'`,
      'MID=$(git rev-parse HEAD)',
      `git rm -q ${EVIL}`,
      "echo 'export const a = 2;' > src/a.mjs"
    ].join('\n'));
    asExecutor(`cd ${target.repository} && echo "${target.sha} ${target.base}" > .git/info/grafts && git config advice.graftFileDeprecated false`);
    const middle = asExecutor(`cd ${target.repository} && git --no-replace-objects cat-file commit ${target.sha} | sed -n 's/^parent //p'`);
    // What a plain read saw: one parent, the base, and only the source change.
    expect(asExecutor(`cd ${target.repository} && git --no-replace-objects rev-list --parents -n 1 ${target.sha}`)).toBe(`${target.sha} ${target.base}`);

    const read = await createCodingGitPort(inspectIn(target.repository)).commit(OWNER, 'ws', target.sha, target.base, AbortSignal.timeout(60_000));
    expect(read).toMatchObject({ ok: true, data: { parents: [middle] } });

    const published = await publishFrom(target);
    expect(published.outcome).toEqual({ state: 'FAILED', code: 'COMMIT_UNVERIFIED' });
    expect(published.push).toMatchObject({ state: 'REJECTED', outcome: { errorCode: 'COMMIT_UNVERIFIED' } });
    expect(published.sent).toEqual([]);
    expect(published.remoteBranches).toEqual(['refs/heads/main']);
  });
});
