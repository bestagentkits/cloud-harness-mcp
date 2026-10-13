import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessError } from '@cloud-harness/contracts';
import { discoverSkillDirs, isCommitOid, parseSkillsShReference } from '../src/adapters/skills-sh-adapter.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function tempTree(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-skills-sh-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSkill(root: string, relativeDir: string, body = '# Skill'): void {
  const target = relativeDir ? join(root, relativeDir) : root;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), body, 'utf8');
}

const ALLOWED = ['github.com'];

describe('parseSkillsShReference', () => {
  it('expands an owner/repo shorthand against the first allowed git host', () => {
    expect(parseSkillsShReference('mattpocock/skills', ALLOWED))
      .toEqual({ repoUrl: 'https://github.com/mattpocock/skills.git', slug: 'mattpocock/skills' });
  });

  it('normalizes an HTTPS repository URL and strips the optional .git suffix', () => {
    expect(parseSkillsShReference('https://github.com/obra/superpowers.git', ALLOWED))
      .toEqual({ repoUrl: 'https://github.com/obra/superpowers.git', slug: 'obra/superpowers' });
    expect(parseSkillsShReference('https://github.com/obra/superpowers', ALLOWED).slug).toBe('obra/superpowers');
  });

  it('rejects a host that is not on the provisioning allowlist', () => {
    expect(() => parseSkillsShReference('https://evil.example.com/owner/repo.git', ALLOWED))
      .toThrow(/not in the allowed git host list/i);
  });

  it('rejects repository URLs that embed credentials', () => {
    expect(() => parseSkillsShReference('https://token@github.com/owner/repo.git', ALLOWED))
      .toThrow(/must not embed credentials/i);
  });

  it('rejects null bytes, bare words, and URLs naming more or fewer than one repository', () => {
    for (const reference of ['owner/re\u0000po', 'just-a-name', 'https://github.com/owner', 'https://github.com/owner/repo/extra', 'owner/repo/extra']) {
      expect(() => parseSkillsShReference(reference, ALLOWED)).toThrow(HarnessError);
    }
  });

  it('refuses a shorthand when no git host is configured', () => {
    expect(() => parseSkillsShReference('owner/repo', [])).toThrow(/no git host is configured/i);
  });
});

describe('isCommitOid', () => {
  it('accepts lowercase SHA-1 and SHA-256 object ids only', () => {
    expect(isCommitOid('a'.repeat(40))).toBe(true);
    expect(isCommitOid('0'.repeat(64))).toBe(true);
    expect(isCommitOid('a'.repeat(39))).toBe(false);
    expect(isCommitOid('A'.repeat(40))).toBe(false);
    expect(isCommitOid('main')).toBe(false);
    expect(isCommitOid('HEAD')).toBe(false);
  });
});

describe('discoverSkillDirs', () => {
  it('finds a single skill that sits at the repository root', () => {
    const root = tempTree();
    writeSkill(root, '');
    const discovered = discoverSkillDirs(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.sourceDir).toBe(root);
  });

  it('finds several skills in subdirectories, sorted by name, without descending past a skill', () => {
    const root = tempTree();
    writeSkill(root, 'skills/zeta');
    writeSkill(root, 'skills/alpha');
    // A nested SKILL.md below a skill directory must not be reported as a second skill.
    writeSkill(root, 'skills/alpha/examples/deep');
    const discovered = discoverSkillDirs(root);
    expect(discovered.map((skill) => skill.name)).toEqual(['alpha', 'zeta']);
  });

  it('ignores the git directory and returns nothing when no SKILL.md exists', () => {
    const root = tempTree();
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'SKILL.md'), '# not a skill', 'utf8');
    writeFileSync(join(root, 'README.md'), '# readme', 'utf8');
    expect(discoverSkillDirs(root)).toEqual([]);
  });
});
