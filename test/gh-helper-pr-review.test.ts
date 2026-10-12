import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve(import.meta.dirname, '../worker/gh-helper.sh');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/**
 * Runs the real helper with a `gh` stand-in that records its argv, so the exact GitHub commands the
 * review lifecycle issues are asserted without a network, a token, or Docker.
 */
function run(args: string[], stub = '') {
  const directory = mkdtempSync(join(tmpdir(), 'gh-helper-'));
  directories.push(directory);
  const log = join(directory, 'calls.log');
  writeFileSync(join(directory, 'gh'), `#!/bin/bash\nprintf '%s\\0' "$@" >> "${log}"\nprintf '\\n--\\n' >> "${log}"\n${stub}\n`);
  chmodSync(join(directory, 'gh'), 0o755);
  const result = spawnSync('bash', [helper, ...args], {
    input: 'dummy_token\n',
    encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH ?? ''}`, GH_REPO: 'acme/widgets', HOME: directory }
  });
  let calls: string[][] = [];
  try {
    calls = readFileSync(log, 'utf8').split('\n--\n').filter(Boolean).map((chunk) => chunk.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1));
  } catch { /* the helper rejected the input before calling gh */ }
  return { ...result, calls };
}

describe('gh-helper pull request review lifecycle', () => {
  it.each(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])('submits a native %s review through the reviews endpoint', (event) => {
    const result = run(['pr_review', '12', event, event === 'APPROVE' ? '' : 'please fix']);
    expect(result.status).toBe(0);
    const call = result.calls[0]!;
    expect(call.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/12/reviews']);
    expect(call).toContain(`event=${event}`);
    expect(call.some((part) => part.startsWith('body='))).toBe(event !== 'APPROVE');
    expect(result.stdout + result.stderr).not.toContain('dummy_token');
  });

  it('rejects an unknown review event and a non-numeric pull request number', () => {
    expect(run(['pr_review', '12', 'DISMISS']).stderr).toContain('Review event must be');
    expect(run(['pr_review', '12;rm', 'APPROVE']).stderr).toContain('Pull request number must be a positive integer');
  });

  it('posts an inline range comment against the PR head when no commit is given', () => {
    const result = run(['pr_review_comment', '12', 'nit', 'src/a.ts', '20', '18', 'RIGHT', 'LEFT', ''], 'case "$*" in *"pulls/12 "*|*"pulls/12") echo deadbeef;; esac');
    expect(result.status).toBe(0);
    expect(result.calls[0]).toEqual(['api', 'repos/{owner}/{repo}/pulls/12', '--jq', '.head.sha']);
    const post = result.calls[1]!;
    expect(post).toEqual(expect.arrayContaining(['body=nit', 'commit_id=deadbeef', 'path=src/a.ts', 'line=20', 'side=RIGHT', 'start_line=18', 'start_side=LEFT']));
    expect(post.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/12/comments']);
  });

  it('uses the supplied commit and omits the range for a single-line comment', () => {
    const result = run(['pr_review_comment', '12', 'nit', 'a.ts', '5', '', 'RIGHT', '', 'abc123']);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain('commit_id=abc123');
    expect(result.calls[0]!.some((part) => part.startsWith('start_line='))).toBe(false);
  });

  it('lists review threads and replies, resolves, and unresolves them over GraphQL', () => {
    const list = run(['pr_review_threads', '12', '25']);
    expect(list.calls[0]).toEqual(expect.arrayContaining(['graphql', 'owner=acme', 'repo=widgets', 'number=12', 'limit=25']));
    const reply = run(['pr_review_reply', 'PRRT_abc123', 'done']);
    expect(reply.calls[0]).toEqual(expect.arrayContaining(['graphql', 'thread=PRRT_abc123', 'body=done']));
    expect(reply.calls[0]!.join(' ')).toContain('addPullRequestReviewThreadReply');
    const resolve = run(['pr_review_thread_resolve', 'PRRT_abc123']);
    expect(resolve.calls[0]!.join(' ')).toContain('resolveReviewThread(');
    const unresolve = run(['pr_review_thread_unresolve', 'PRRT_abc123']);
    expect(unresolve.calls[0]!.join(' ')).toContain('unresolveReviewThread(');
  });

  it('requests and removes users and teams through the requested_reviewers endpoint', () => {
    const request = run(['pr_reviewers_request', '12', 'octocat,hubot', 'core']);
    expect(request.calls[0]).toEqual(expect.arrayContaining(['-X', 'POST', 'repos/{owner}/{repo}/pulls/12/requested_reviewers', 'reviewers[]=octocat', 'reviewers[]=hubot', 'team_reviewers[]=core']));
    const remove = run(['pr_reviewers_remove', '12', '', 'core']);
    expect(remove.calls[0]).toEqual(expect.arrayContaining(['-X', 'DELETE', 'team_reviewers[]=core']));
    expect(run(['pr_reviewers_request', '12', '', '']).stderr).toContain('At least one reviewer');
  });

  it('moves a pull request between draft and ready', () => {
    expect(run(['pr_ready', '12']).calls[0]).toEqual(['pr', 'ready', '12']);
    expect(run(['pr_convert_to_draft', '12']).calls[0]).toEqual(['pr', 'ready', '12', '--undo']);
  });

  it.each(['merge', 'squash', 'rebase'])('merges with --%s and forwards the message and head guard', (method) => {
    const result = run(['pr_merge', '12', method, 'feat: t', 'body', 'cafebabe']);
    expect(result.status).toBe(0);
    expect(result.calls[0]).toEqual(['pr', 'merge', '12', `--${method}`, '--subject', 'feat: t', '--body', 'body', '--match-head-commit', 'cafebabe']);
    expect(run(['pr_merge', '12', 'ff']).stderr).toContain('Merge method must be');
  });

  it('enables and disables auto-merge', () => {
    expect(run(['pr_auto_merge_enable', '12', 'squash']).calls[0]).toEqual(['pr', 'merge', '12', '--squash', '--auto']);
    expect(run(['pr_auto_merge_disable', '12']).calls[0]).toEqual(['pr', 'merge', '12', '--disable-auto']);
  });

  it('reports a failed merge on stderr so the broker can classify it', () => {
    const result = run(['pr_merge', '12', 'squash'], 'case "$1 $2" in "pr merge") echo "X Pull request #12 is not mergeable: the base branch policy prohibits the merge." >&2; exit 1;; esac');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('base branch policy prohibits the merge');
  });
});
