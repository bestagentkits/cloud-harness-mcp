import { describe, expect, it } from 'vitest';
import { importJobPolling } from './skill-import-progress';
import {
  archiveContentType, archiveProblem, archiveSummary, cancelGeneration, filterSkills, forkBody, groupBulkRequests, importBody, importGuidance,
  importSchema, instructionsProblem, libraryCount, type Skill, skillSetItems, SKILL_ARCHIVE_MAX_BYTES
} from './skill-model';

const id = (n: number) => `sk_${String(n).padStart(20, '0')}`;
const SKILLS: Skill[] = [
  { id: id(1), slug: 'beta', displayName: 'Beta', provider: 'custom', state: 'enabled', tags: ['ops', 'deploy'], generation: 2, currentRevisionId: `skrev_${'a'.repeat(20)}` },
  { id: id(2), slug: 'alpha', displayName: 'Alpha', provider: 'skills-sh', state: 'disabled', tags: ['docs'], generation: 1 },
  { id: id(3), slug: 'gamma', displayName: 'Gamma', provider: 'git', state: 'archived', generation: 2 }
];

describe('library filters', () => {
  it('filters by text, provider, state and tag, and sorts by name by default', () => {
    expect(filterSkills(SKILLS, {}).map((skill) => skill.slug)).toEqual(['alpha', 'beta', 'gamma']);
    expect(filterSkills(SKILLS, { q: 'SKILLS-SH' }).map((skill) => skill.slug)).toEqual(['alpha']);
    expect(filterSkills(SKILLS, { provider: 'git' }).map((skill) => skill.slug)).toEqual(['gamma']);
    expect(filterSkills(SKILLS, { state: 'enabled' }).map((skill) => skill.slug)).toEqual(['beta']);
    expect(filterSkills(SKILLS, { tag: 'dep' }).map((skill) => skill.slug)).toEqual(['beta']);
    expect(filterSkills(SKILLS, { sort: 'state' }).map((skill) => skill.state)).toEqual(['archived', 'disabled', 'enabled']);
  });

  it('states the count so a filter is distinguishable from an empty library', () => {
    expect(libraryCount(0, 0)).toBe('No skills yet');
    expect(libraryCount(1, 1)).toBe('1 skill');
    expect(libraryCount(3, 0)).toBe('0 of 3 skills');
  });
});

describe('bulk', () => {
  it('sends one request per generation and never a zero fence', () => {
    expect(groupBulkRequests(SKILLS, [id(1), id(2), id(3), 'sk_unknown'])).toEqual([
      { expectedGeneration: 2, skillIds: [id(1), id(3)] },
      { expectedGeneration: 1, skillIds: [id(2), 'sk_unknown'] }
    ]);
  });
});

describe('editor rules', () => {
  it('rejects empty, null-byte and unclosed-frontmatter instructions', () => {
    expect(instructionsProblem('  ')).toMatch(/empty/);
    expect(instructionsProblem('a\0b')).toMatch(/null/);
    expect(instructionsProblem('---\nname: x\n')).toMatch(/never closes/);
    expect(instructionsProblem('---\nname: x\n---\nBody')).toBeNull();
  });

  it('forks with a derived slug clipped to the schema bound', () => {
    expect(forkBody({ id: id(1), slug: 'beta', displayName: 'Beta' })).toEqual({ slug: 'beta-fork', displayName: 'Beta fork', expectedGeneration: 0 });
    expect(forkBody({ id: id(1), slug: 'x'.repeat(120) }).slug).toHaveLength(120);
  });
});

describe('imports', () => {
  it('mirrors the classic source and ref rules', () => {
    expect(importSchema.safeParse({ sourceKind: 'skills-sh', sourceRef: 'owner/repo', ref: '' }).success).toBe(true);
    expect(importSchema.safeParse({ sourceKind: 'git', sourceRef: 'not a repo', ref: '' }).success).toBe(false);
    expect(importSchema.safeParse({ sourceKind: 'skillx', sourceRef: 'any-reference', ref: '' }).success).toBe(true);
    expect(importSchema.safeParse({ sourceKind: 'skills-sh', sourceRef: 'o/r', ref: 'main' }).success).toBe(false);
    expect(importBody({ sourceKind: 'git', sourceRef: 'o/r', ref: '' })).toEqual({ sourceKind: 'git', sourceRef: 'o/r', expectedGeneration: 0 });
  });

  it('reads the cancel fence from the job, falling back to the schema minimum', () => {
    expect(cancelGeneration({ id: 'skjob_x', state: 'running', generation: 4 })).toBe(4);
    expect(cancelGeneration({ id: 'skjob_x', state: 'running' })).toBe(1);
  });

  it('names a cache miss with its remedy', () => {
    expect(importGuidance({ id: 'j', state: 'failed', errorCode: 'CACHE_MISS' })).toMatch(/not mirrored/);
    expect(importGuidance({ id: 'j', state: 'running', progress: { percent: 40 } })).toBe('Import running (40%).');
  });

  it('polls until a terminal state, a failed read, or the read budget', () => {
    const at = (state: string, dataUpdateCount = 1, status = 'success') => importJobPolling({ state: { data: { data: { id: 'j', state } }, dataUpdateCount, status } });
    expect(at('queued')).toBe(1_500);
    expect(at('running')).toBe(1_500);
    for (const state of ['succeeded', 'failed', 'cancelled']) expect(at(state)).toBe(false);
    expect(at('running', 40)).toBe(false);
    expect(at('running', 2, 'error')).toBe(false);
  });
});

describe('archives', () => {
  it('checks the file before any byte is sent', () => {
    expect(archiveProblem(undefined)).toMatch(/Choose/);
    expect(archiveProblem({ name: 'skills.tar', size: 10 })).toMatch(/\.zip/);
    expect(archiveProblem({ name: 'skills.zip', size: SKILL_ARCHIVE_MAX_BYTES + 1 })).toMatch(/8 MiB/);
    expect(archiveProblem({ name: 'skills.ZIP', size: 10 })).toBeNull();
    expect(archiveContentType('')).toBe('application/zip');
    expect(archiveContentType('application/x-zip-compressed')).toBe('application/x-zip-compressed');
    expect(archiveSummary([{ slug: 'a', ok: true }, { slug: 'b', ok: false }])).toBe('Imported 1 of 2. The rest are listed below.');
  });
});

describe('skill sets', () => {
  it('pins each member to its current revision and refuses a member without one', () => {
    expect(skillSetItems(SKILLS, [])).toEqual({ ok: false, message: 'Select at least one skill.' });
    expect(skillSetItems(SKILLS, [id(2)])).toEqual({ ok: false, message: 'Every member needs a skill that has a revision.' });
    expect(skillSetItems(SKILLS, [id(1)])).toEqual({ ok: true, items: [{ skillSourceId: id(1), revisionId: `skrev_${'a'.repeat(20)}`, name: 'beta' }] });
  });
});
