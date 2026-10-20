import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import getTags from 'semantic-release/lib/branches/get-tags.js';
import getLastRelease from 'semantic-release/lib/get-last-release.js';
import { afterEach, describe, expect, it } from 'vitest';
import { findTagsMissingChannelNotes, prereleaseLane, repairReleaseChannelNotes } from '../scripts/repair-release-channel-notes.mjs';

const releaseConfig = {
  branches: ['main', { name: 'dev', prerelease: 'beta', channel: 'beta' }],
  tagFormat: 'v${version}'
};
const directories: string[] = [];

function run(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createLane() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-release-notes-'));
  directories.push(root);
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  run(root, 'init', '--quiet', '--bare', '--initial-branch', 'dev', remote);
  run(root, 'init', '--quiet', '--initial-branch', 'dev', clone);
  run(clone, 'config', 'user.name', 'Release test');
  run(clone, 'config', 'user.email', 'release-test@example.invalid');
  run(clone, 'remote', 'add', 'origin', remote);
  writeFileSync(join(clone, '.releaserc.json'), JSON.stringify(releaseConfig));
  const release = (version: string, note?: string) => {
    run(clone, 'commit', '--quiet', '--allow-empty', '-m', `chore(release): ${version}`);
    run(clone, 'tag', `v${version}`);
    if (note) run(clone, 'notes', '--ref', `semantic-release-v${version}`, 'add', '-m', note, `v${version}`);
  };
  run(clone, 'add', '.releaserc.json');
  run(clone, 'commit', '--quiet', '-m', 'test: fixture');
  release('1.0.0');
  release('1.1.0-beta.1', '{"channels":["beta"]}');
  // A rejected note push leaves this tag published without its channel note.
  release('1.1.0-beta.2');
  run(clone, 'commit', '--quiet', '--allow-empty', '-m', 'feat: unreleased change');
  run(clone, 'push', '--quiet', '--tags', 'origin', 'dev', 'refs/notes/*');
  return { clone, remote };
}

// The prerelease lane's last release as semantic-release itself selects it.
async function lastDevRelease(cwd: string) {
  const options = { tagFormat: releaseConfig.tagFormat };
  const [branch] = await getTags({ cwd, env: process.env, options }, [{ name: 'dev', type: 'prerelease', prerelease: 'beta', channel: 'beta' }]);
  return getLastRelease({ branch, options }).version;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release channel note repair', () => {
  it('resolves the prerelease lane only for prerelease branches', () => {
    expect(prereleaseLane(releaseConfig, 'dev')).toEqual({ identifier: 'beta', channel: 'beta' });
    expect(prereleaseLane(releaseConfig, 'main')).toBeUndefined();
    expect(prereleaseLane({ branches: [{ name: 'next', prerelease: true }] }, 'next')).toEqual({ identifier: 'next', channel: 'next' });
  });

  it('restores and pushes the channel note of a published prerelease tag that lost it', async () => {
    const { clone, remote } = createLane();
    expect(await lastDevRelease(clone)).toBe('1.1.0-beta.1');

    expect(findTagsMissingChannelNotes({ cwd: clone, branch: 'dev' }).tags).toEqual(['v1.1.0-beta.2']);
    expect(repairReleaseChannelNotes({ cwd: clone, branch: 'dev', log: () => {} })).toEqual(['v1.1.0-beta.2']);

    expect(run(clone, 'notes', '--ref', 'semantic-release-v1.1.0-beta.2', 'show', 'v1.1.0-beta.2')).toBe('{"channels":["beta"]}');
    expect(run(remote, 'notes', '--ref', 'semantic-release-v1.1.0-beta.2', 'show', 'v1.1.0-beta.2')).toBe('{"channels":["beta"]}');
    expect(repairReleaseChannelNotes({ cwd: clone, branch: 'dev', log: () => {} })).toEqual([]);
    expect(await lastDevRelease(clone)).toBe('1.1.0-beta.2');
  });

  it('ignores unmerged tags, other prerelease identifiers and notes of another channel', () => {
    const { clone } = createLane();
    run(clone, 'notes', '--ref', 'semantic-release-v1.1.0-beta.2', 'add', '-m', '{"channels":["next"]}', 'v1.1.0-beta.2');
    run(clone, 'tag', 'v1.2.0-alpha.1');
    run(clone, 'switch', '--quiet', '--orphan', 'elsewhere');
    run(clone, 'commit', '--quiet', '--allow-empty', '-m', 'chore(release): 1.2.0-beta.1');
    run(clone, 'tag', 'v1.2.0-beta.1');
    run(clone, 'switch', '--quiet', 'dev');

    expect(findTagsMissingChannelNotes({ cwd: clone, branch: 'dev' }).tags).toEqual([]);
    expect(run(clone, 'notes', '--ref', 'semantic-release-v1.1.0-beta.2', 'show', 'v1.1.0-beta.2')).toBe('{"channels":["next"]}');
  });

  it('fetches remote notes before deciding a tag is missing one', () => {
    const { clone } = createLane();
    run(clone, 'notes', '--ref', 'semantic-release-v1.1.0-beta.2', 'add', '-m', '{"channels":["beta"]}', 'v1.1.0-beta.2');
    run(clone, 'push', '--quiet', 'origin', 'refs/notes/semantic-release-v1.1.0-beta.2');
    run(clone, 'update-ref', '-d', 'refs/notes/semantic-release-v1.1.0-beta.2');

    expect(repairReleaseChannelNotes({ cwd: clone, branch: 'dev', push: false, log: () => {} })).toEqual([]);
  });

  it('leaves stable release branches untouched', () => {
    const { clone } = createLane();

    expect(repairReleaseChannelNotes({ cwd: clone, branch: 'main', push: false, log: () => {} })).toEqual([]);
    expect(findTagsMissingChannelNotes({ cwd: clone, branch: 'dev' }).tags).toEqual(['v1.1.0-beta.2']);
  });
});
