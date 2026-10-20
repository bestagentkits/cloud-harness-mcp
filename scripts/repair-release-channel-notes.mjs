import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// semantic-release records a release's channel in a per-tag git note
// (refs/notes/semantic-release-<tag>). It pushes the tag before the note, so a
// rejected note push leaves a published prerelease tag that the prerelease
// branch ignores when it looks for its last release. Every later run then
// computes the same version and fails on `git tag`.
//
// .releaserc.json runs this as the exec plugin's verifyConditions step, so the
// branch's own checkout carries the repair: Release is a workflow_run workflow,
// which always runs the default branch's copy of release.yml. semantic-release
// has already chosen the last release by then, so a run that restores a note
// stops before `prepare` commits anything, and the next run resumes at the next
// version.
const NOTE_REF_PREFIX = 'semantic-release';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readReleaseConfig(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.releaserc.json'), 'utf8'));
}

export function prereleaseLane(config, branch) {
  const entry = config.branches
    .map((candidate) => (typeof candidate === 'string' ? { name: candidate } : candidate))
    .find((candidate) => candidate.name === branch);
  if (!entry?.prerelease) return undefined;
  const identifier = entry.prerelease === true ? entry.name : entry.prerelease;
  return { identifier, channel: entry.channel ?? entry.name };
}

export function findTagsMissingChannelNotes({ cwd, branch, config = readReleaseConfig(cwd) }) {
  const lane = prereleaseLane(config, branch);
  if (!lane) return { lane, tags: [] };
  const [prefix, suffix] = (config.tagFormat ?? 'v${version}').split('${version}');
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}\\d+\\.\\d+\\.\\d+-${escapeRegExp(lane.identifier)}\\.\\d+${escapeRegExp(suffix ?? '')}$`
  );
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const tags = git('tag', '--merged', 'HEAD', '--list')
    .split('\n')
    .filter((tag) => pattern.test(tag))
    .filter((tag) => {
      try {
        execFileSync('git', ['notes', '--ref', `${NOTE_REF_PREFIX}-${tag}`, 'show', tag], { cwd, stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    });
  return { lane, tags };
}

export function repairReleaseChannelNotes({ cwd = process.cwd(), branch, remote = 'origin', dryRun = false, log = console.log }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const config = readReleaseConfig(cwd);
  if (!prereleaseLane(config, branch)) return [];
  git('fetch', '--quiet', remote, `+refs/notes/${NOTE_REF_PREFIX}*:refs/notes/${NOTE_REF_PREFIX}*`);
  const { lane, tags } = findTagsMissingChannelNotes({ cwd, branch, config });
  for (const tag of tags) {
    if (dryRun) {
      log(`${tag} has no ${lane.channel} channel note; a release run restores it.`);
      continue;
    }
    const ref = `${NOTE_REF_PREFIX}-${tag}`;
    git('notes', '--ref', ref, 'add', '-f', '-m', JSON.stringify({ channels: [lane.channel] }), tag);
    try {
      git('push', '--quiet', remote, `refs/notes/${ref}`);
    } catch (error) {
      throw new Error(`Could not push refs/notes/${ref}; the release token must be allowed to push refs/notes/*.`, { cause: error });
    }
    log(`Restored the ${lane.channel} channel note for ${tag}.`);
  }
  return tags;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [branch, dryRun] = process.argv.slice(2);
  if (!branch) throw new Error('Usage: repair-release-channel-notes.mjs <release-branch> [dry-run]');
  const restored = repairReleaseChannelNotes({ branch, dryRun: dryRun === 'true' });
  if (restored.length > 0 && dryRun !== 'true') {
    console.error('This run chose its last release without the restored notes, so it stops before committing. The next release run resumes at the next version.');
    process.exitCode = 1;
  }
}
