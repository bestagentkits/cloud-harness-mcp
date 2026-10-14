import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve(import.meta.dirname, '../worker/gh-helper.sh');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const HEAD_SHA = 'a'.repeat(40);

/**
 * A stateful `gh api` stand-in: statuses and dispatched runs are kept in files beside it, so a write
 * made by one helper invocation is visible to the next one the way the GitHub REST API would show it.
 * It records argv, applies `--jq` like `gh` does (strings printed raw), and answers 404 for refs it does not know.
 */
const STUB = String.raw`#!/bin/bash
dir=$(dirname "$0")
printf '%s\0' "$@" >> "$dir/calls.log"; printf '\n--\n' >> "$dir/calls.log"
method=GET; path=; filter=; fields='{}'; body=
shift
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift 2 ;;
    -f) key=$(printf '%s' "$2" | cut -d= -f1); value=$(printf '%s' "$2" | cut -d= -f2-)
        fields=$(jq -c --arg k "$key" --arg v "$value" '.[$k] = $v' <<<"$fields"); shift 2 ;;
    --jq) filter=$2; shift 2 ;;
    --input) body=$(cat); shift 2 ;;
    --paginate|--slurp) shift ;;
    *) path=$1; shift ;;
  esac
done
respond() { if [ -n "$filter" ]; then jq -rc "$filter"; else cat; fi; }
case "$method $path" in
  "POST repos/{owner}/{repo}/statuses/"*)
    count=$(cat "$dir/statuses.jsonl" 2>/dev/null | wc -l)
    jq -c --arg sha "$(basename "$path")" --argjson id "$((count + 1))" '{ id: $id, sha: $sha, state, context,
      description: (.description // null), target_url: (.target_url // null), creator: { login: "harness[bot]" },
      created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z" }' <<<"$fields" \
      | tee -a "$dir/statuses.jsonl" | respond ;;
  "GET repos/{owner}/{repo}/commits/"*/status)
    sha=$(basename "$(dirname "$path")")
    (cat "$dir/statuses.jsonl" 2>/dev/null || true) | jq -sc --arg sha "$sha" '[.[] | select(.sha == $sha)] | reverse
      | unique_by(.context) as $s
      | { sha: $sha, total_count: ($s | length), statuses: $s,
          state: (if any($s[]; .state == "failure" or .state == "error") then "failure"
                  elif ($s | length) == 0 or any($s[]; .state == "pending") then "pending" else "success" end) }' | respond ;;
  "GET repos/{owner}/{repo}/commits/heads/main")
    printf '{"sha":"%s"}' "$STUB_HEAD_SHA" | respond ;;
  "GET repos/{owner}/{repo}/commits/"*)
    echo 'gh: No commit found for SHA (HTTP 422)' >&2; exit 1 ;;
  "POST repos/{owner}/{repo}/actions/workflows/"*/dispatches)
    printf '%s' "$body" > "$dir/dispatch.json"
    workflow=$(basename "$(dirname "$path")")
    jq -c --arg wf "$workflow" --arg sha "$STUB_HEAD_SHA" '{ id: 9001, name: "CI", workflow_id: 7, path: (".github/workflows/" + $wf),
      event: "workflow_dispatch", status: "queued", conclusion: null, head_sha: $sha, head_branch: .ref,
      run_number: 12, run_attempt: 1, created_at: "2026-10-14T00:00:01Z", updated_at: "2026-10-14T00:00:01Z",
      html_url: "https://github.com/acme/widgets/actions/runs/9001" }' <<<"$body" >> "$dir/runs.jsonl" ;;
  "GET repos/{owner}/{repo}/actions/workflows/"*/runs|"GET repos/{owner}/{repo}/actions/runs")
    (cat "$dir/runs.jsonl" 2>/dev/null || true) | jq -sc --argjson q "$fields" '[.[]
      | select(($q.head_sha // .head_sha) == .head_sha and ($q.event // .event) == .event and ($q.branch // .head_branch) == .head_branch)]
      | { total_count: length, workflow_runs: . }' | respond ;;
  "GET repos/{owner}/{repo}/actions/runs/"*/jobs)
    printf '%s' '{"total_count":2,"jobs":[{"id":1,"name":"lint","status":"completed","conclusion":"success","steps":[{"name":"npm run lint","conclusion":"success"}]},{"id":2,"name":"test","status":"completed","conclusion":"failure","steps":[{"name":"checkout","conclusion":"success"},{"name":"npm test","conclusion":"failure"}]}]}' | respond ;;
  "POST repos/{owner}/{repo}/actions/runs/"*/rerun-failed-jobs) printf '' ;;
  "GET repos/{owner}/{repo}/actions/runs/"*)
    printf '{"id":%s,"name":"CI","workflow_id":7,"path":".github/workflows/ci.yml","event":"push","status":"queued","conclusion":null,"head_sha":"%s","head_branch":"main","run_number":12,"run_attempt":2,"html_url":"https://github.com/acme/widgets/actions/runs/%s"}' \
      "$(basename "$path")" "$STUB_HEAD_SHA" "$(basename "$path")" | respond ;;
  "GET repos/{owner}/{repo}/git/ref/heads/merge-lock")
    printf '{"ref":"refs/heads/merge-lock","object":{"sha":"%s","type":"commit"}}' "$STUB_HEAD_SHA" | respond ;;
  "GET repos/{owner}/{repo}/git/ref/"*)
    echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  "GET repos/{owner}/{repo}/pulls/12/reviews?per_page=100")
    printf '%s' '[[{"id":1,"user":{"login":"ana"},"state":"CHANGES_REQUESTED","submitted_at":"t1","commit_id":"c1","html_url":"u1"},{"id":2,"user":{"login":"bo"},"state":"APPROVED","submitted_at":"t2","commit_id":"c1","html_url":"u2"}],[{"id":3,"user":{"login":"ana"},"state":"COMMENTED","submitted_at":"t3","commit_id":"c2","html_url":"u3"},{"id":4,"user":{"login":"cy"},"state":"COMMENTED","submitted_at":"t4","commit_id":"c2","html_url":"u4"},{"id":5,"user":{"login":"bo"},"state":"PENDING","submitted_at":null,"commit_id":"c2","html_url":"u5"}]]' ;;
  *) echo "unexpected gh call: $method $path" >&2; exit 64 ;;
esac
`;

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'gh-helper-train-'));
  directories.push(directory);
  writeFileSync(join(directory, 'gh'), STUB);
  chmodSync(join(directory, 'gh'), 0o755);
  const run = (args: string[]) => {
    const result = spawnSync('bash', [helper, ...args], {
      input: 'dummy_token\n',
      encoding: 'utf8',
      env: { PATH: `${directory}:${process.env.PATH ?? ''}`, GH_REPO: 'acme/widgets', HOME: directory, STUB_HEAD_SHA: HEAD_SHA }
    });
    expect(result.stdout + result.stderr).not.toContain('dummy_token');
    return { ...result, json: () => JSON.parse(result.stdout) as Record<string, unknown> };
  };
  const calls = () => {
    try {
      return readFileSync(join(directory, 'calls.log'), 'utf8').split('\n--\n').filter(Boolean)
        .map((chunk) => chunk.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1));
    } catch { return []; }
  };
  return { directory, run, calls };
}

describe('gh-helper merge-train actions', () => {
  it('round-trips a commit status: create then read the combined status for the SHA', () => {
    const { run, calls } = workspace();
    expect(run(['commit_status_get', HEAD_SHA]).json()).toMatchObject({ sha: HEAD_SHA, state: 'pending', totalCount: 0, statuses: [] });

    const created = run(['commit_status_create', HEAD_SHA, 'pending', 'merge-train', 'Queued at position 2', 'https://ci.example.test/train/1']);
    expect(created.status).toBe(0);
    expect(created.json()).toMatchObject({ sha: HEAD_SHA, state: 'pending', context: 'merge-train', description: 'Queued at position 2', targetUrl: 'https://ci.example.test/train/1', creator: 'harness[bot]' });
    const post = calls().find((call) => call.includes('POST'))!;
    expect(post).toEqual(expect.arrayContaining([`repos/{owner}/{repo}/statuses/${HEAD_SHA}`, 'state=pending', 'context=merge-train', 'target_url=https://ci.example.test/train/1']));

    expect(run(['commit_status_create', HEAD_SHA, 'success', 'merge-train', '', '']).status).toBe(0);
    const combined = run(['commit_status_get', HEAD_SHA]).json();
    expect(combined).toMatchObject({ sha: HEAD_SHA, state: 'success', totalCount: 1 });
    expect(combined.statuses).toEqual([expect.objectContaining({ context: 'merge-train', state: 'success', description: null })]);
  });

  it('refuses a malformed status write before calling GitHub', () => {
    const { run, calls } = workspace();
    expect(run(['commit_status_create', 'main', 'success', 'ctx']).stderr).toContain('full lowercase commit ID');
    expect(run(['commit_status_create', HEAD_SHA, 'neutral', 'ctx']).stderr).toContain('error, failure, pending, or success');
    expect(run(['commit_status_create', HEAD_SHA, 'success', '']).stderr).toContain('context required');
    expect(run(['commit_status_get', '../../orgs']).stderr).toContain('Revision must be');
    expect(calls()).toEqual([]);
  });

  it('dispatches a workflow and finds its run by the returned head SHA', () => {
    const { run, directory } = workspace();
    const dispatched = run(['workflow_dispatch', 'ci.yml', 'refs/heads/main', '{"train":"7","dryRun":"false"}']);
    expect(dispatched.status).toBe(0);
    const result = dispatched.json();
    expect(result).toMatchObject({ dispatched: true, workflow: 'ci.yml', ref: 'refs/heads/main', headSha: HEAD_SHA,
      runLookup: { action: 'workflow_runs_list', workflow: 'ci.yml', headSha: HEAD_SHA, event: 'workflow_dispatch' } });
    expect(JSON.parse(readFileSync(join(directory, 'dispatch.json'), 'utf8'))).toEqual({ ref: 'refs/heads/main', inputs: { train: '7', dryRun: 'false' } });

    const lookup = result.runLookup as { workflow: string; headSha: string; event: string };
    const runs = run(['workflow_runs_list', '20', lookup.workflow, lookup.headSha, '', lookup.event, '']).json();
    expect(runs).toMatchObject({ totalCount: 1, runs: [{ id: 9001, headSha: HEAD_SHA, event: 'workflow_dispatch', status: 'queued' }] });
    expect(run(['workflow_runs_list', '20', 'ci.yml', 'b'.repeat(40), '', '', '']).json()).toMatchObject({ totalCount: 0, runs: [] });
  });

  it('does not dispatch when the ref cannot be resolved or the workflow name is unsafe', () => {
    const { run, calls } = workspace();
    const unresolved = run(['workflow_dispatch', 'ci.yml', 'refs/heads/missing', '']);
    expect(unresolved.status).not.toBe(0);
    expect(unresolved.stderr).toContain('could not be resolved');
    expect(calls().some((call) => call.join(' ').includes('dispatches'))).toBe(false);
    expect(run(['workflow_dispatch', '../secrets', 'main', '']).stderr).toContain('Workflow must be');
    expect(run(['workflow_runs_list', '20', 'ci.yml;x']).stderr).toContain('Workflow must be');
  });

  it('views a run with its jobs and failed steps, and re-runs only the failed jobs', () => {
    const { run, calls } = workspace();
    const view = run(['workflow_run_view', '9001', '50']).json();
    expect(view).toMatchObject({ id: 9001, headSha: HEAD_SHA, jobsTotal: 2 });
    expect(view.jobs).toEqual([
      expect.objectContaining({ name: 'lint', conclusion: 'success', failedSteps: [] }),
      expect.objectContaining({ name: 'test', conclusion: 'failure', failedSteps: ['npm test'] })
    ]);
    expect(calls()[1]).toEqual(expect.arrayContaining(['repos/{owner}/{repo}/actions/runs/9001/jobs', 'filter=latest', 'per_page=50']));

    const rerun = run(['workflow_run_rerun_failed', '9001']);
    expect(rerun.json()).toEqual({ id: 9001, status: 'queued', conclusion: null, runAttempt: 2, url: 'https://github.com/acme/widgets/actions/runs/9001' });
    expect(calls().some((call) => call.includes('repos/{owner}/{repo}/actions/runs/9001/rerun-failed-jobs') && call.includes('POST'))).toBe(true);
    expect(run(['workflow_run_rerun_failed', '9001/../1']).stderr).toContain('positive integer');
  });

  it('lists the latest check runs for a SHA, optionally filtered by name', () => {
    const { run, calls } = workspace();
    run(['check_runs_list', HEAD_SHA, '30', 'build']);
    expect(calls()[0]).toEqual(expect.arrayContaining([`repos/{owner}/{repo}/commits/${HEAD_SHA}/check-runs`, 'per_page=30', 'filter=latest', 'check_name=build']));
  });

  it('reads a ref and reports an absent one without failing', () => {
    const { run } = workspace();
    expect(run(['ref_get', 'refs/heads/merge-lock']).json()).toEqual({ ref: 'refs/heads/merge-lock', oid: HEAD_SHA, objectType: 'commit', exists: true });
    const absent = run(['ref_get', 'refs/heads/other-lock']);
    expect(absent.status).toBe(0);
    expect(absent.json()).toEqual({ ref: 'refs/heads/other-lock', exists: false });
    expect(run(['ref_get', 'main']).stderr).toContain('fully qualified');
    expect(run(['ref_get', 'refs/heads/../../x']).stderr).toContain('Revision must be');
  });

  it('summarizes review state per reviewer across pages, ignoring comments and pending reviews', () => {
    const { run } = workspace();
    const reviews = run(['pr_reviews', '12']).json();
    expect(reviews).toMatchObject({
      totalCount: 5,
      latestByReviewer: { ana: 'CHANGES_REQUESTED', bo: 'APPROVED', cy: 'COMMENTED' },
      changesRequestedBy: ['ana'],
      approvedBy: ['bo']
    });
  });
});
