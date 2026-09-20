import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeWorkerRequest } from '../../../worker/harness-worker.mjs';

/**
 * The roster is what the suggestion engine ranks against, and every field in it comes from content a
 * repository can ship, so the assertions here are about bounds and about treating that content as data.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
});

function workspaceWith(skills: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-roster-'));
  temporaryDirectories.push(root);
  process.env.CH_WORKSPACE_ROOT = root;
  for (const [name, content] of Object.entries(skills)) {
    const dir = join(root, '.cloud-harness', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), content);
  }
  return root;
}

async function roster(): Promise<{ entries: Array<Record<string, string>>; rosterDigest: string }> {
  const result = await executeWorkerRequest('skills_roster', {});
  expect(result.ok).toBe(true);
  return result.data as { entries: Array<Record<string, string>>; rosterDigest: string };
}

describe('skill roster', () => {
  it('reads the frontmatter description and bounds every field', async () => {
    workspaceWith({
      tdd: `---\nname: tdd\ndescription: ${'d'.repeat(500)}\n---\n\n${'b'.repeat(900)}\n`
    });

    const { entries } = await roster();
    const entry = entries[0]!;

    expect(entry.name).toBe('tdd');
    // A bound truncates; it does not pad, so each field is at most its limit and the long fixtures hit
    // the limit exactly.
    expect(entry.indexDescription).toHaveLength(60);
    expect(entry.descriptionFull).toHaveLength(400);
    expect(entry.bodyExcerpt).toHaveLength(700);
  });

  it('keeps a short description as written instead of padding it to the bound', async () => {
    workspaceWith({ tdd: '---\ndescription: short and complete\n---\n' });

    const { entries } = await roster();
    expect(entries[0]!.indexDescription).toBe('short and complete');
  });

  it('strips control characters so roster text cannot carry terminal escapes', async () => {
    workspaceWith({ tdd: '---\ndescription: clean\u0007here\u001b[31m\n---\nbody\u0000text\n' });

    const { entries } = await roster();

    expect(entries[0]!.indexDescription).toBe('cleanhere[31m');
    expect(entries[0]!.indexDescription).not.toMatch(/[\u0000-\u001F\u007F]/);
  });

  it('falls back to the first prose line and then to the skill name', async () => {
    workspaceWith({
      prose: '# Heading\n\nThis is the first prose line.\n',
      bare: '# Only a heading\n'
    });

    const { entries } = await roster();
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));

    expect(byName.prose!.indexDescription).toBe('This is the first prose line.');
    expect(byName.bare!.indexDescription).toBe('bare');
  });

  it('orders deterministically and keeps the digest stable when only unrelated files change', async () => {
    const root = workspaceWith({
      zeta: '---\ndescription: last alphabetically\n---\n',
      alpha: '---\ndescription: first alphabetically\n---\n'
    });

    const first = await roster();
    expect(first.entries.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);

    // A file the digest does not cover must not invalidate a cached suggestion.
    writeFileSync(join(root, 'unrelated.txt'), 'changed');
    const second = await roster();
    expect(second.rosterDigest).toBe(first.rosterDigest);

    // A change the suggestion does depend on must invalidate it.
    writeFileSync(join(root, '.cloud-harness', 'skills', 'alpha', 'SKILL.md'), '---\ndescription: rewritten\n---\n');
    const third = await roster();
    expect(third.rosterDigest).not.toBe(first.rosterDigest);
  });

  it('returns an empty roster with a digest rather than failing when no skill exists', async () => {
    workspaceWith({});

    const { entries, rosterDigest } = await roster();

    expect(entries).toEqual([]);
    expect(rosterDigest).toHaveLength(64);
  });
});
