import type { ImportValues } from './skill-form-schemas';
import type { SKILL_PROVIDERS, SKILL_SORTS, SKILL_STATES, SkillTab } from './skill-search';

export { SKILL_ID_PATTERN, SKILL_PROVIDERS, SKILL_SORTS, SKILL_STATES, SKILL_TABS, type SkillTab, TAG_MAX } from './skill-search';

/**
 * The skill projections the BFF returns (`skillKeys`, `skillRevisionKeys`, `skillSetKeys`,
 * `skillImportJobKeys`, `skillCatalogKeys` in `apps/api/src/dashboard-response.ts`) and the
 * pure rules of the Skills page. Bounds mirror the operation schemas in
 * `packages/contracts/src/internal-runner-api.ts`; the runner re-checks every one of them.
 */
export type Skill = {
  id: string;
  slug?: string;
  displayName?: string;
  description?: string;
  kind?: string;
  provider?: string;
  sourceRef?: string;
  currentRevisionId?: string;
  state?: string;
  tags?: unknown;
  generation?: number;
  createdAt?: string;
  updatedAt?: string;
  version?: string;
};

export type SkillRevision = { id: string; skillSourceId?: string; parentRevisionId?: string; origin?: string; hasExecutableAssets?: boolean; createdAt?: string; version?: string };
export type SkillUsage = { sets?: { skillSetId?: string; name?: string }[]; liveWorkspaces?: { workspaceId?: string; status?: string; name?: string; revisionId?: string }[] };
export type SkillSet = { id: string; name?: string; description?: string; generation?: number; createdAt?: string; updatedAt?: string };
export type SkillSetItem = { skillSetId?: string; ordinal?: number; skillSourceId?: string; revisionId?: string; name?: string };
export type SkillImportJob = { id: string; sourceKind?: string; sourceRef?: string; state?: string; progress?: unknown; errorCode?: string | null; skillRevisionId?: string | null; generation?: number; updatedAt?: unknown };
export type RegistryEntry = { id?: string; provider?: string; slug?: string; displayName?: string; description?: string; cacheState?: string; pinnedCommit?: string; skillCount?: number; lockState?: string };
export type RegistryPreset = { id?: string; name?: string; description?: string; defaultRevision?: string; installable?: boolean };
export type SkillSearchResult = {
  local?: Skill[];
  providers?: { provider?: string; status?: string; warning?: string; count?: number }[];
  results?: { provider?: string; reference?: string; name?: string; description?: string; installs?: number }[];
};
export type BulkResult = { skillId?: string; ok?: boolean; error?: string };
export type ArchiveResult = { slug?: string; ok?: boolean; skillId?: string; error?: string; message?: string };

/** Opaque runner identifiers (`opaqueId` in `packages/contracts/src/identifiers.ts`). */
export const SKILL_JOB_ID_PATTERN = /^skjob_[A-Za-z0-9_-]{20,80}$/;

export const SKILL_TAB_LABELS: Record<SkillTab, string> = { library: 'Library', imports: 'Discover', sets: 'Skill sets', registry: 'Registry' };

export const PROVIDER_LABELS: Record<string, string> = { 'skills-sh': 'skills.sh', skillx: 'SkillX', custom: 'Custom', git: 'Git' };
export const STATE_LABELS: Record<string, string> = { enabled: 'Enabled', disabled: 'Disabled', archived: 'Archived' };

export type LibraryFilters = {
  q?: string | undefined;
  provider?: (typeof SKILL_PROVIDERS)[number] | undefined;
  state?: (typeof SKILL_STATES)[number] | undefined;
  tag?: string | undefined;
  sort?: (typeof SKILL_SORTS)[number] | undefined;
};

export function skillTags(skill: Skill): string[] {
  return Array.isArray(skill.tags) ? skill.tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

export function skillLabel(skill: Skill | undefined): string {
  return skill?.displayName || skill?.slug || 'Skill';
}

/**
 * The library rows matching the filters, sorted. Filtering runs over the one `/skills` read in
 * the browser, as the classic page does, so typing never refetches.
 */
export function filterSkills(skills: readonly Skill[], filters: LibraryFilters): Skill[] {
  const needle = filters.q?.trim().toLowerCase() ?? '';
  const tag = filters.tag?.trim().toLowerCase() ?? '';
  const field = filters.sort ?? 'displayName';
  return skills
    .filter((skill) => !filters.provider || skill.provider === filters.provider)
    .filter((skill) => !filters.state || skill.state === filters.state)
    .filter((skill) => !tag || skillTags(skill).some((entry) => entry.toLowerCase().includes(tag)))
    .filter((skill) => !needle || `${skill.displayName ?? ''} ${skill.slug ?? ''} ${skill.provider ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')));
}

/** "3 skills", "1 of 3 skills" or "0 of 3 skills": the count says whether a filter is responsible. */
export function libraryCount(total: number, visible: number): string {
  if (total === 0) return 'No skills yet';
  const label = total === 1 ? 'skill' : 'skills';
  return visible === total ? `${total} ${label}` : `${visible} of ${total} ${label}`;
}

/**
 * The bulk operation carries one generation for the batch, so rows selected at different
 * generations are sent as one request per generation (the classic `groupBulkRequests`).
 * A row whose generation is unknown is sent with 1, the generation a new source starts at.
 */
export function groupBulkRequests(skills: readonly Skill[], skillIds: readonly string[]): { expectedGeneration: number; skillIds: string[] }[] {
  const groups = new Map<number, string[]>();
  for (const skillId of skillIds) {
    const generation = positiveGeneration(skills.find((skill) => skill.id === skillId)?.generation);
    groups.set(generation, [...(groups.get(generation) ?? []), skillId]);
  }
  return [...groups.entries()].map(([expectedGeneration, ids]) => ({ expectedGeneration, skillIds: ids }));
}

/** A positive integer generation, else 1 (the runner's first generation for sources and sets). */
export function positiveGeneration(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * Validates instructions the runner would refuse anyway (the classic
 * `validateSkillInstructions`). The editor stores text and never executes it.
 */
export function instructionsProblem(text: string): string | null {
  if (text.trim() === '') return 'Instructions cannot be empty.';
  if (text.includes('\0')) return 'Instructions cannot contain null bytes.';
  if (/^\s*---\s*\n/.test(text) && text.indexOf('\n---', 3) === -1) return 'Frontmatter opens with --- but never closes.';
  return null;
}

/** `skill_create_custom` caps instructions at 64 KiB; `skill_revision_create` at 200,000 characters. */
export const CREATE_INSTRUCTIONS_MAX = 65_536;
export const REVISION_INSTRUCTIONS_MAX = 200_000;
export const SLUG_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
export const DISPLAY_NAME_MAX = 100;
export const DESCRIPTION_MAX = 2_000;

/** Tags are entered comma-separated; `skill_update` takes at most 16 of up to 32 characters. */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * A fork starts a new source from a revision's bytes, so it needs a new slug and name; the
 * classic page derives `<slug>-fork` and "<name> fork", clipped here to the schema bounds.
 */
export function forkBody(skill: Skill | undefined): { slug: string; displayName: string; expectedGeneration: 0 } {
  const slug = `${(skill?.slug ?? 'skill').slice(0, 115)}-fork`;
  const displayName = `${skillLabel(skill).slice(0, DISPLAY_NAME_MAX - 5)} fork`;
  return { slug, displayName, expectedGeneration: 0 };
}

export const IMPORT_SOURCE_KINDS = ['skills-sh', 'skillx', 'git'] as const;

export function importBody(values: ImportValues): { sourceKind: ImportValues['sourceKind']; sourceRef: string; ref?: string; expectedGeneration: 0 } {
  return { sourceKind: values.sourceKind, sourceRef: values.sourceRef, ...(values.ref ? { ref: values.ref } : {}), expectedGeneration: 0 };
}

export const TERMINAL_IMPORT_STATES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminalImport(job: SkillImportJob | undefined): boolean {
  return (TERMINAL_IMPORT_STATES as readonly string[]).includes(String(job?.state));
}

/** The classic poller's budget: every 1.5 s, at most 40 reads, so a dead runner never spins forever. */
export const IMPORT_POLL_INTERVAL_MS = 1_500;
export const IMPORT_POLL_MAX_READS = 40;

/** The percentage a job reports, when it reports one; never a made-up value. */
export function importPercent(job: SkillImportJob | undefined): number | undefined {
  const progress = job?.progress;
  const percent = progress && typeof progress === 'object' ? (progress as { percent?: unknown }).percent : undefined;
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : undefined;
}

/** What the operator can do about a job's state (the classic `renderImportJobGuidance`). */
export function importGuidance(job: SkillImportJob | undefined): string {
  const state = job?.state;
  if (state === 'failed') {
    const code = job?.errorCode ?? 'unknown';
    if (code === 'CACHE_MISS') return 'CACHE_MISS: this skill is not mirrored in the runner cache. Import it while the runner has network access, then retry.';
    return `The import failed (${code}). Retry, or check the runner logs for the provider response.`;
  }
  if (state === 'succeeded') return 'Import finished. The skill is now in the library.';
  if (state === 'cancelled') return 'Import cancelled.';
  const percent = importPercent(job);
  return `Import ${state ?? 'queued'}${percent === undefined ? '' : ` (${percent}%)`}.`;
}

/**
 * The fence for cancelling an import, read from the job the page is watching (the classic
 * page hard-coded 1). The job projection carries no generation today and the runner only
 * checks the job's state, so a missing value falls back to 1, the schema's minimum.
 */
export function cancelGeneration(job: SkillImportJob | undefined): number {
  return positiveGeneration(job?.generation);
}

/** The upload route's media types and size cap (`SKILL_ARCHIVE_MEDIA_TYPES`, `SKILL_ARCHIVE_MAX_BYTES`). */
export const SKILL_ARCHIVE_MEDIA_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'] as const;
export const SKILL_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;

export function archiveProblem(file: { name: string; size: number } | undefined): string | null {
  if (!file) return 'Choose a .zip archive first.';
  if (!/\.zip$/i.test(file.name)) return 'Choose a .zip archive.';
  if (file.size === 0) return 'The archive is empty.';
  if (file.size > SKILL_ARCHIVE_MAX_BYTES) return 'Archive must be 8 MiB or smaller.';
  return null;
}

/** The browser's type when the route accepts it, else `application/zip` (some systems report none). */
export function archiveContentType(type: string): string {
  return (SKILL_ARCHIVE_MEDIA_TYPES as readonly string[]).includes(type) ? type : 'application/zip';
}

export function archiveSummary(results: readonly ArchiveResult[]): string {
  const created = results.filter((row) => row.ok === true).length;
  if (results.length === 0) return 'The archive held no skills.';
  return created === results.length
    ? `Imported ${created} skill${created === 1 ? '' : 's'}.`
    : `Imported ${created} of ${results.length}. The rest are listed below.`;
}

/**
 * Members for a new skill set: each pins the chosen skill's current revision, so a set never
 * stores a name that could later resolve to other bytes (the classic `buildSkillSetBody`).
 */
export function skillSetItems(skills: readonly Skill[], selectedIds: readonly string[]): { ok: true; items: { skillSourceId: string; revisionId: string; name: string }[] } | { ok: false; message: string } {
  if (selectedIds.length === 0) return { ok: false, message: 'Select at least one skill.' };
  if (selectedIds.length > 128) return { ok: false, message: 'A skill set holds at most 128 skills.' };
  const items: { skillSourceId: string; revisionId: string; name: string }[] = [];
  for (const id of selectedIds) {
    const skill = skills.find((candidate) => candidate.id === id);
    if (!skill?.currentRevisionId) return { ok: false, message: 'Every member needs a skill that has a revision.' };
    const name = skill.slug ?? id;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) return { ok: false, message: `${skillLabel(skill)} has a slug a skill set cannot store.` };
    items.push({ skillSourceId: id, revisionId: skill.currentRevisionId, name });
  }
  return { ok: true, items };
}

