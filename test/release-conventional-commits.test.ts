import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';

const configuration = { preset: 'conventionalcommits', presetConfig: {} };
const context = (message: string) => ({ commits: [{ message }], cwd: process.cwd(), logger: { log: () => undefined } });
const releaseNotesContext = (message: string) => ({
  commits: [{ hash: 'a46763318bb3efd99ec0e128f3a029e0709f3850', message }],
  cwd: process.cwd(),
  lastRelease: { gitTag: 'v0.2.0', version: '0.2.0' },
  logger: { log: () => undefined },
  nextRelease: { gitHead: 'a46763318bb3efd99ec0e128f3a029e0709f3850', gitTag: 'v0.3.0', type: 'minor', version: '0.3.0' },
  options: { repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git' }
});

describe('release Conventional Commit rules', () => {
  it.each([
    ['fix: repair release metadata', 'patch'],
    ['perf: reduce workspace startup time', 'patch'],
    ['feat: add release automation', 'minor'],
    ['feat!: remove the legacy release endpoint', 'major'],
    ['fix: change result envelope\n\nBREAKING CHANGE: clients must parse the new envelope', 'major']
  ])('maps %s to a %s release', async (message, expectedReleaseType) => {
    await expect(analyzeCommits(configuration, context(message))).resolves.toBe(expectedReleaseType);
  });

  it('does not release non-semantic commits', async () => {
    await expect(analyzeCommits(configuration, context('chore: refresh local tooling'))).resolves.toBeNull();
  });

  it('includes eligible Conventional Commits in generated release notes', async () => {
    await expect(generateNotes({ preset: 'angular' }, releaseNotesContext('feat: add cloudharness workflow skill')))
      .resolves.toContain('add cloudharness workflow skill');
  });
});
