import { describe, expect, it } from 'vitest';
import {
  assertSkillSetGenerations,
  repositorySubRank,
  resolveWorkspaceSkills,
  SkillSetGenerationError,
  type SkillCandidate
} from '../src/skill-resolver.js';

const candidate = (overrides: Partial<SkillCandidate> & Pick<SkillCandidate, 'name' | 'tier'>): SkillCandidate => ({
  sourceId: `sk_${overrides.name}`,
  revisionId: `skrev_${overrides.name}_${overrides.tier}`,
  contentSha256: 'a'.repeat(64),
  ...overrides
});

describe('repositorySubRank', () => {
  it('ranks .agents above .codex above .claude and tolerates Windows separators', () => {
    expect(repositorySubRank('.agents/skills/tdd')).toBe(3);
    expect(repositorySubRank('.codex/skills/tdd')).toBe(2);
    expect(repositorySubRank('.claude/skills/tdd')).toBe(1);
    expect(repositorySubRank('.claude\\skills\\tdd')).toBe(1);
    expect(repositorySubRank('vendor/skills')).toBe(0);
    expect(repositorySubRank(undefined)).toBe(0);
  });
});

describe('resolveWorkspaceSkills precedence', () => {
  it('resolves the highest tier for a name present in several tiers', () => {
    const result = resolveWorkspaceSkills({
      candidates: [
        candidate({ name: 'tdd', tier: 'repository', rootPath: '.agents/skills/tdd' }),
        candidate({ name: 'tdd', tier: 'workspace' }),
        candidate({ name: 'tdd', tier: 'owner' }),
        candidate({ name: 'tdd', tier: 'built-in' })
      ]
    });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.tier).toBe('built-in');
  });

  it('keeps the shipped repository sub-rank ahead of the conflict engine', () => {
    const result = resolveWorkspaceSkills({
      candidates: [
        candidate({ name: 'tdd', tier: 'repository', rootPath: '.claude/skills/tdd', contentSha256: 'c'.repeat(64) }),
        candidate({ name: 'tdd', tier: 'repository', rootPath: '.agents/skills/tdd', contentSha256: 'a'.repeat(64) })
      ]
    });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.contentSha256).toBe('a'.repeat(64));
  });

  it('treats identical bytes at the same rank as one skill rather than a conflict', () => {
    const result = resolveWorkspaceSkills({
      candidates: [
        candidate({ name: 'tdd', tier: 'repository', rootPath: '.agents/skills/tdd', contentSha256: 'a'.repeat(64) }),
        candidate({ name: 'tdd', tier: 'repository', rootPath: '.codex/skills/tdd', contentSha256: 'a'.repeat(64) })
      ]
    });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toHaveLength(1);
  });

  it('reports a same-tier collision with different digests and leaves the name unresolved', () => {
    const result = resolveWorkspaceSkills({
      candidates: [
        candidate({ name: 'tdd', tier: 'owner', revisionId: 'skrev_one', contentSha256: '1'.repeat(64) }),
        candidate({ name: 'tdd', tier: 'owner', revisionId: 'skrev_two', contentSha256: '2'.repeat(64) })
      ]
    });
    expect(result.resolved).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.name).toBe('tdd');
    expect(result.conflicts[0]!.candidates.map((entry) => entry.revisionId).sort()).toEqual(['skrev_one', 'skrev_two']);
  });

  it('lets an override resolve a collision and marks the result pinned', () => {
    const result = resolveWorkspaceSkills({
      overrides: { tdd: 'skrev_two' },
      candidates: [
        candidate({ name: 'tdd', tier: 'owner', revisionId: 'skrev_one', contentSha256: '1'.repeat(64) }),
        candidate({ name: 'tdd', tier: 'owner', revisionId: 'skrev_two', contentSha256: '2'.repeat(64) })
      ]
    });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toEqual([{
      name: 'tdd', tier: 'owner', sourceId: 'sk_tdd', revisionId: 'skrev_two',
      contentSha256: '2'.repeat(64), pinned: true
    }]);
  });

  it('reports an override that matches no candidate instead of failing silently', () => {
    const result = resolveWorkspaceSkills({
      overrides: { missing: 'skrev_nope' },
      candidates: [candidate({ name: 'tdd', tier: 'owner' })]
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.ignoredOverrides).toEqual(['missing']);
  });

  it('excludes disabled and archived skills with their reason while leaving their bytes alone', () => {
    const result = resolveWorkspaceSkills({
      candidates: [
        candidate({ name: 'tdd', tier: 'owner', state: 'disabled' }),
        candidate({ name: 'review', tier: 'owner', state: 'archived' }),
        candidate({ name: 'ship', tier: 'owner' })
      ]
    });
    expect(result.resolved.map((skill) => skill.name)).toEqual(['ship']);
    expect(result.excluded).toEqual([
      { name: 'review', tier: 'owner', reason: 'archived' },
      { name: 'tdd', tier: 'owner', reason: 'disabled' }
    ]);
  });
});

describe('resolveWorkspaceSkills determinism', () => {
  it('produces an identical result when candidates arrive in a different order', () => {
    const candidates: SkillCandidate[] = [
      candidate({ name: 'zeta', tier: 'repository', rootPath: '.claude/skills/zeta', contentSha256: 'z'.repeat(64) }),
      candidate({ name: 'alpha', tier: 'owner' }),
      candidate({ name: 'zeta', tier: 'owner', contentSha256: 'y'.repeat(64) }),
      candidate({ name: 'beta', tier: 'workspace' }),
      candidate({ name: 'gamma', tier: 'owner', state: 'disabled' }),
      candidate({ name: 'delta', tier: 'owner', state: 'archived' }),
      candidate({ name: 'mu', tier: 'repository', rootPath: '.codex/skills/mu', contentSha256: 'm'.repeat(64) })
    ];
    const forward = resolveWorkspaceSkills({ candidates });
    const reversed = resolveWorkspaceSkills({ candidates: [...candidates].reverse() });
    const shuffled = resolveWorkspaceSkills({ candidates: [candidates[2]!, candidates[5]!, candidates[0]!, candidates[3]!, candidates[1]!, candidates[4]!] });

    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect(forward.resolved.map((skill) => `${skill.name}:${skill.tier}`)).toEqual(['alpha:owner', 'beta:workspace', 'mu:repository', 'zeta:owner']);
    expect(forward.excluded).toEqual([
      { name: 'delta', tier: 'owner', reason: 'archived' },
      { name: 'gamma', tier: 'owner', reason: 'disabled' }
    ]);
  });
});

describe('assertSkillSetGenerations', () => {
  it('passes when every selected set is still at the previewed generation', () => {
    expect(() => assertSkillSetGenerations(
      [{ skillSetId: 'skset_one', expectedGeneration: 3 }],
      [{ skillSetId: 'skset_one', generation: 3 }]
    )).not.toThrow();
  });

  it('raises a stale-generation error when a set moved or disappeared', () => {
    expect(() => assertSkillSetGenerations(
      [{ skillSetId: 'skset_one', expectedGeneration: 2 }],
      [{ skillSetId: 'skset_one', generation: 4 }]
    )).toThrow(SkillSetGenerationError);

    expect(() => assertSkillSetGenerations(
      [{ skillSetId: 'skset_gone', expectedGeneration: 1 }],
      []
    )).toThrow(/no longer exists/i);

    try {
      assertSkillSetGenerations([{ skillSetId: 'skset_one', expectedGeneration: 2 }], [{ skillSetId: 'skset_one', generation: 4 }]);
    } catch (error) {
      expect((error as SkillSetGenerationError).code).toBe('STALE_GENERATION');
    }
  });
});
