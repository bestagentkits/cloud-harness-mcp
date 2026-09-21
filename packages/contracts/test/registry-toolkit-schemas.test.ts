import { describe, expect, it } from 'vitest';
import {
  SkillOverrideMapSchema,
  SkillSetSelectionSchema,
  TOOL_SCHEMA_BY_NAME,
  ToolkitSelectionSchema
} from '../src/index.js';

const workspaceOpen = TOOL_SCHEMA_BY_NAME.workspace_open;

const SET_ID = `skset_${'a'.repeat(24)}`;
const REVISION_ID = `skrev_${'b'.repeat(24)}`;

const setId = (index: number) => `skset_${String(index).padStart(3, '0')}${'a'.repeat(21)}`;
const revisionId = (index: number) => `skrev_${String(index).padStart(3, '0')}${'b'.repeat(21)}`;

const openParams = (overrides: Record<string, unknown> = {}) => ({
  repositoryUrl: 'https://github.com/example/repository.git',
  idempotencyKey: 'phase-one-contract-key',
  ...overrides
});

describe('ToolkitSelectionSchema registry arm', () => {
  it('accepts a skills-sh toolkit referenced by owner/repo shorthand', () => {
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'registry',
      provider: 'skills-sh',
      instanceId: 'skills-sh-core',
      reference: 'mattpocock/skills'
    });
    expect(parsed.kind).toBe('registry');
    if (parsed.kind === 'registry') {
      expect(parsed.provider).toBe('skills-sh');
      expect(parsed.reference).toBe('mattpocock/skills');
      expect(parsed.scope).toBe('owner');
      expect(parsed.activation).toBe('skills-only');
    }
  });

  it('accepts a skills-sh toolkit referenced by HTTPS URL with a pinned commit', () => {
    const commit = 'c'.repeat(40);
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'registry',
      provider: 'skills-sh',
      instanceId: 'skills-sh-pinned',
      reference: 'https://github.com/obra/superpowers.git',
      ref: commit,
      subdirectory: 'skills/tdd'
    });
    expect(parsed.kind).toBe('registry');
    if (parsed.kind === 'registry') {
      expect(parsed.ref).toBe(commit);
      expect(parsed.subdirectory).toBe('skills/tdd');
    }
  });

  it('accepts a skillx toolkit referenced by slug', () => {
    const parsed = ToolkitSelectionSchema.parse({
      kind: 'registry',
      provider: 'skillx',
      instanceId: 'skillx-search',
      reference: 'flowglad-resolve-checks'
    });
    expect(parsed.kind).toBe('registry');
    if (parsed.kind === 'registry') {
      expect(parsed.provider).toBe('skillx');
    }
  });

  it('rejects an unknown registry provider', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'registry',
      provider: 'marketplace',
      instanceId: 'unknown',
      reference: 'owner/repo'
    })).toThrow();
  });

  it('rejects an empty, oversized, or NUL-bearing reference', () => {
    for (const reference of ['', 'a'.repeat(301), 'owner/re\u0000po']) {
      expect(() => ToolkitSelectionSchema.parse({
        kind: 'registry',
        provider: 'skills-sh',
        instanceId: 'bad-reference',
        reference
      })).toThrow();
    }
  });

  it('requires an instanceId so two registry toolkits cannot collide', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'registry',
      provider: 'skills-sh',
      reference: 'owner/repo'
    })).toThrow();
  });

  it('rejects unknown extra properties, matching the other arms', () => {
    expect(() => ToolkitSelectionSchema.parse({
      kind: 'registry',
      provider: 'skills-sh',
      instanceId: 'strict-check',
      reference: 'owner/repo',
      provenance: 'trusted'
    })).toThrow();
  });
});

describe('SkillSetSelectionSchema', () => {
  it('accepts a set reference with a positive expected generation', () => {
    const parsed = SkillSetSelectionSchema.parse({ skillSetId: SET_ID, expectedGeneration: 3 });
    expect(parsed.skillSetId).toBe(SET_ID);
    expect(parsed.expectedGeneration).toBe(3);
  });

  it('rejects a malformed set identifier and a non-positive generation', () => {
    expect(() => SkillSetSelectionSchema.parse({ skillSetId: 'set-1', expectedGeneration: 1 })).toThrow();
    expect(() => SkillSetSelectionSchema.parse({ skillSetId: SET_ID, expectedGeneration: 0 })).toThrow();
    expect(() => SkillSetSelectionSchema.parse({ skillSetId: SET_ID, expectedGeneration: 1.5 })).toThrow();
  });

  it('rejects unknown extra properties', () => {
    expect(() => SkillSetSelectionSchema.parse({
      skillSetId: SET_ID, expectedGeneration: 1, name: 'extra'
    })).toThrow();
  });
});

describe('SkillOverrideMapSchema', () => {
  it('accepts a name to revision mapping and rejects malformed names or revisions', () => {
    expect(SkillOverrideMapSchema.parse({ tdd: REVISION_ID })).toEqual({ tdd: REVISION_ID });
    expect(() => SkillOverrideMapSchema.parse({ 'bad name': REVISION_ID })).toThrow();
    expect(() => SkillOverrideMapSchema.parse({ tdd: 'revision-1' })).toThrow();
  });
});

describe('workspace_open skill set and override parameters', () => {
  it('defaults both fields when they are omitted', () => {
    const parsed = workspaceOpen.parse(openParams());
    expect(parsed.skillSets).toEqual([]);
    expect(parsed.skillOverrides).toEqual({});
  });

  it('accepts 16 skill sets and 128 overrides at the documented bounds', () => {
    const skillSets = Array.from({ length: 16 }, (_, index) => ({
      skillSetId: setId(index),
      expectedGeneration: index + 1
    }));
    const skillOverrides = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`skill-${index}`, revisionId(index)])
    );
    const parsed = workspaceOpen.parse(openParams({ skillSets, skillOverrides }));
    expect(parsed.skillSets).toHaveLength(16);
    expect(Object.keys(parsed.skillOverrides)).toHaveLength(128);
  });

  it('rejects 17 skill sets and 129 overrides', () => {
    const tooManySets = Array.from({ length: 17 }, (_, index) => ({
      skillSetId: setId(index),
      expectedGeneration: 1
    }));
    expect(() => workspaceOpen.parse(openParams({ skillSets: tooManySets }))).toThrow();

    const tooManyOverrides = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`skill-${index}`, revisionId(index)])
    );
    expect(() => workspaceOpen.parse(openParams({ skillOverrides: tooManyOverrides }))).toThrow();
  });

  it('rejects a duplicate skillSetId in one launch request', () => {
    expect(() => workspaceOpen.parse(openParams({
      skillSets: [
        { skillSetId: SET_ID, expectedGeneration: 1 },
        { skillSetId: SET_ID, expectedGeneration: 2 }
      ]
    }))).toThrow(/duplicate skill set/i);
  });

  it('rejects a malformed skill set entry rather than silently dropping it', () => {
    expect(() => workspaceOpen.parse(openParams({
      skillSets: [{ skillSetId: SET_ID }]
    }))).toThrow();
  });
});
