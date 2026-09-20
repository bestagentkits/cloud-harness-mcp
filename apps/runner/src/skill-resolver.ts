/**
 * Deterministic 4-tier skill resolution.
 *
 * Precedence is `built-in > owner > workspace > repository`. Within the repository tier the shipped
 * ordering (`.agents/skills` above `.codex/skills` above `.claude/skills`) is preserved as an explicit
 * comparator key rather than being left implicit, so same-name repository skills with different
 * digests keep resolving to the winner they resolved to before instead of becoming a new conflict.
 *
 * This module does not add a fourth rank map: it is the projection/conflict owner that the existing
 * `composeOwnerToolkitProjection` and `applyWorkspaceToolkitPatches` helpers feed, and the same
 * ranking that `worker/harness-worker.mjs` applies at executor side.
 */
export type SkillTier = 'built-in' | 'owner' | 'workspace' | 'repository';
export type SkillState = 'enabled' | 'disabled' | 'archived';

export type SkillCandidate = {
  name: string;
  tier: SkillTier;
  sourceId: string;
  revisionId: string;
  contentSha256: string;
  /** Root the skill was discovered under; only used to derive the repository sub-rank. */
  rootPath?: string | undefined;
  state?: SkillState | undefined;
};

export type ResolveSkillsParams = {
  candidates: SkillCandidate[];
  /** name -> revisionId. An override pins that exact revision and resolves a same-tier collision. */
  overrides?: Record<string, string> | undefined;
};

export type ResolvedSkill = {
  name: string;
  tier: SkillTier;
  sourceId: string;
  revisionId: string;
  contentSha256: string;
  pinned: boolean;
};

export type SkillConflict = {
  name: string;
  candidates: { tier: SkillTier; revisionId: string; rootPath?: string | undefined }[];
};

export type ResolvedSkillsResult = {
  resolved: ResolvedSkill[];
  excluded: { name: string; tier: SkillTier; reason: 'disabled' | 'archived' }[];
  conflicts: SkillConflict[];
  ignoredOverrides: string[];
};

export const TIER_RANK: Record<SkillTier, number> = {
  'built-in': 4,
  owner: 3,
  workspace: 2,
  repository: 1
};

export const REPOSITORY_SUB_RANK: ReadonlyArray<{ marker: string; rank: number }> = [
  { marker: '.agents/skills', rank: 3 },
  { marker: '.codex/skills', rank: 2 },
  { marker: '.claude/skills', rank: 1 }
];

export function repositorySubRank(rootPath: string | undefined): number {
  if (!rootPath) return 0;
  const normalized = rootPath.replaceAll('\\', '/');
  for (const entry of REPOSITORY_SUB_RANK) {
    if (normalized.includes(entry.marker)) return entry.rank;
  }
  return 0;
}

function compareCandidates(a: SkillCandidate, b: SkillCandidate): number {
  const tierDelta = TIER_RANK[b.tier] - TIER_RANK[a.tier];
  if (tierDelta !== 0) return tierDelta;
  if (a.tier === 'repository') {
    const rankDelta = repositorySubRank(b.rootPath) - repositorySubRank(a.rootPath);
    if (rankDelta !== 0) return rankDelta;
  }
  return a.revisionId.localeCompare(b.revisionId);
}

export function resolveWorkspaceSkills(params: ResolveSkillsParams): ResolvedSkillsResult {
  const overrides = params.overrides ?? {};
  const excluded: ResolvedSkillsResult['excluded'] = [];
  const ignoredOverrides: string[] = [];
  const usable: SkillCandidate[] = [];

  for (const candidate of params.candidates) {
    const state = candidate.state ?? 'enabled';
    if (state === 'disabled' || state === 'archived') {
      excluded.push({ name: candidate.name, tier: candidate.tier, reason: state });
      continue;
    }
    usable.push(candidate);
  }

  const byName = new Map<string, SkillCandidate[]>();
  for (const candidate of usable) {
    const list = byName.get(candidate.name) ?? [];
    list.push(candidate);
    byName.set(candidate.name, list);
  }

  const resolved: ResolvedSkill[] = [];
  const conflicts: SkillConflict[] = [];
  const overrideNames = Object.keys(overrides);

  for (const [name, candidates] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const overrideRevision = overrides[name];
    if (overrideRevision !== undefined) {
      const pinned = candidates.find((candidate) => candidate.revisionId === overrideRevision);
      if (pinned) {
        resolved.push({
          name,
          tier: pinned.tier,
          sourceId: pinned.sourceId,
          revisionId: pinned.revisionId,
          contentSha256: pinned.contentSha256,
          pinned: true
        });
        continue;
      }
    }

    // A collision is same tier AND same digest rank: identical bytes are the same skill seen twice,
    // while different bytes at the same rank are a real ambiguity an operator must resolve.
    const ranked = [...candidates].sort(compareCandidates);
    const winner = ranked[0]!;
    const sameRank = ranked.filter((candidate) => candidate.tier === winner.tier
      && (candidate.tier !== 'repository' || repositorySubRank(candidate.rootPath) === repositorySubRank(winner.rootPath)));
    const distinctDigests = new Set(sameRank.map((candidate) => candidate.contentSha256));

    if (distinctDigests.size > 1) {
      conflicts.push({
        name,
        candidates: sameRank.map((candidate) => ({
          tier: candidate.tier,
          revisionId: candidate.revisionId,
          ...(candidate.rootPath ? { rootPath: candidate.rootPath } : {})
        }))
      });
      continue;
    }

    resolved.push({
      name,
      tier: winner.tier,
      sourceId: winner.sourceId,
      revisionId: winner.revisionId,
      contentSha256: winner.contentSha256,
      pinned: false
    });
  }

  for (const name of overrideNames) {
    if (!byName.has(name)) ignoredOverrides.push(name);
  }

  // Sorted so the whole result is independent of candidate arrival order, not just `resolved`.
  excluded.sort((a, b) => a.name.localeCompare(b.name) || TIER_RANK[b.tier] - TIER_RANK[a.tier]);

  return { resolved, excluded, conflicts, ignoredOverrides };
}

/**
 * Launch-time guard: a selected Skill Set whose generation moved since the preview is a stale
 * selection, so launch must be refused rather than resolving against a set the operator never saw.
 */
export function assertSkillSetGenerations(
  selected: ReadonlyArray<{ skillSetId: string; expectedGeneration: number }>,
  current: ReadonlyArray<{ skillSetId: string; generation: number }>
): void {
  const generations = new Map(current.map((entry) => [entry.skillSetId, entry.generation]));
  for (const entry of selected) {
    const actual = generations.get(entry.skillSetId);
    if (actual === undefined) {
      throw new SkillSetGenerationError(entry.skillSetId, entry.expectedGeneration, 'missing');
    }
    if (actual !== entry.expectedGeneration) {
      throw new SkillSetGenerationError(entry.skillSetId, entry.expectedGeneration, String(actual));
    }
  }
}

export class SkillSetGenerationError extends Error {
  readonly code = 'STALE_GENERATION';
  constructor(readonly skillSetId: string, readonly expectedGeneration: number, readonly actualGeneration: string) {
    super(actualGeneration === 'missing'
      ? `Skill set ${skillSetId} no longer exists; refresh the preview`
      : `Skill set ${skillSetId} is at generation ${actualGeneration}, preview expected ${expectedGeneration}; refresh the preview`);
    this.name = 'SkillSetGenerationError';
  }
}
