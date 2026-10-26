import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyGitHubFailure } from '../apps/runner/src/github-error-classifier.js';

const helper = resolve(import.meta.dirname, '../worker/gh-helper.sh');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const REFUSAL = 'GraphQL: Resource not accessible by integration (repository.issue)';

/** A `gh` stand-in whose label edits are refused the way GitHub refuses a pull request node to an issues-only token. */
const STUB = String.raw`#!/bin/bash
case "$1 $2" in
  "label create") exit 0 ;;
  "issue edit") echo "$STUB_REFUSAL" >&2; exit 1 ;;
  "issue view") echo 'pending' ;;
  *) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
`;

function run(args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'gh-helper-publish-'));
  directories.push(directory);
  writeFileSync(join(directory, 'gh'), STUB);
  chmodSync(join(directory, 'gh'), 0o755);
  return spawnSync('bash', [helper, 'issue_publish', ...args], {
    input: 'dummy_token\n',
    encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH ?? ''}`, GH_REPO: 'acme/widgets', HOME: directory, STUB_REFUSAL: REFUSAL }
  });
}

// gh-helper.sh and its stub binaries are POSIX shell scripts that run only inside the Linux executor container.
describe.skipIf(process.platform === 'win32')('gh-helper issue_publish label steps', () => {
  it('keeps the gh refusal when adding labels fails so the classifier maps its real code', () => {
    const result = run(['1379', '', 'triage', '', 'true']);

    expect(result.status).toBe(1);
    const failure = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(failure).toMatchObject({ step: 'add_labels', issueNumber: 1379 });
    expect(failure.error).toContain(REFUSAL);
    expect(classifyGitHubFailure(result.stderr, result.stdout, 'issue_publish')).toMatchObject({
      code: 'GITHUB_PERMISSION_MISSING',
      step: 'add_labels'
    });
  });

  it('keeps the gh refusal when removing a label fails', () => {
    const result = run(['1379', '', '', 'pending', 'true']);

    expect(result.status).toBe(1);
    const failure = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(failure).toMatchObject({ step: 'remove_labels', failedLabel: 'pending' });
    expect(failure.error).toContain(REFUSAL);
    expect(result.stdout + result.stderr).not.toContain('dummy_token');
  });
});
