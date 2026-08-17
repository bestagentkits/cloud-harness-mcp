import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { describe, expect, it } from 'vitest';

const configuration = { preset: 'conventionalcommits', presetConfig: {} };
const context = (message: string) => ({ commits: [{ message }], cwd: process.cwd(), logger: { log: () => undefined } });

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
});
