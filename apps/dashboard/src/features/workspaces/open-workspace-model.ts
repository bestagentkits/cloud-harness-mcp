/**
 * The "Open new workspace" wizard: its restorable draft, the read shapes it consumes
 * (`/skill-sets`, `POST /skill-sets/preview`, `/toolkits`), and the `workspace_open` body it
 * sends (`packages/contracts/src/tool-schemas.ts`). The classic dialog's skill-set controller
 * (`createLaunchSkillSetController` in `apps/api/dashboard/dashboard.js`) owns the same rules:
 * a selection carries the set's generation, and launch stays blocked while any preview
 * conflict has no override.
 */
import { arr, rec, text } from '@/lib/format';

export const OPEN_WORKSPACE_STEPS = ['repository', 'automation', 'review'] as const;
export type OpenWorkspaceStep = (typeof OPEN_WORKSPACE_STEPS)[number];
export const OPEN_WORKSPACE_STEP_LABELS: Record<OpenWorkspaceStep, string> = {
  repository: 'Repository', automation: 'Skills and toolkits', review: 'Review and launch'
};

export const NETWORK_PROFILES = [
  { value: 'dependency-access', label: 'Dependency access (public DNS, TCP 80/443)' },
  { value: 'network-none', label: 'No network (air-gapped isolation)' }
] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number]['value'];

export const PRESET_TOOLKIT_IDS = ['mattpocock/skills', 'obra/superpowers'] as const;
export type PresetToolkitId = (typeof PRESET_TOOLKIT_IDS)[number];
export const AGENTKIT_IDS = ['engineer', 'marketing'] as const;
export type AgentkitId = (typeof AGENTKIT_IDS)[number];

/**
 * Everything the wizard restores after a reload, including whether it was open. None of it is secret: a repository URL
 * carrying userinfo, a query or a fragment is never stored (`restorableRepositoryUrl`), and
 * the idempotency key is a client-made dedupe token, kept so a reload after a lost launch
 * answer replays the same launch instead of opening a second workspace.
 */
export type OpenWorkspaceDraft = {
  open: boolean;
  step: OpenWorkspaceStep;
  repositoryUrl: string;
  ref: string;
  networkProfile: NetworkProfile;
  skillSetIds: string[];
  skillOverrides: Record<string, string>;
  presets: PresetToolkitId[];
  agentkits: AgentkitId[];
  launch?: { key: string; intent: string } | undefined;
};

export const initialOpenWorkspaceDraft = (): OpenWorkspaceDraft => ({
  open: false, step: 'repository', repositoryUrl: '', ref: '', networkProfile: 'dependency-access',
  skillSetIds: [], skillOverrides: {}, presets: [], agentkits: []
});

const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SKILL_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const strings = <T extends string = string>(value: unknown, allowed: (item: string) => item is T, max: number): T[] =>
  [...new Set(arr<unknown>(value).filter((item): item is T => typeof item === 'string' && allowed(item)))].slice(0, max);
const isId = (item: string): item is string => ID.test(item);
const oneOf = <T extends string>(values: readonly T[]) => (item: string): item is T => (values as readonly string[]).includes(item);

/** The URL as stored for restore: only a plain HTTPS URL without credentials survives. */
export function restorableRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    return trimmed;
  } catch {
    return '';
  }
}

/** What reaches `sessionStorage`: the draft with its URL reduced to the restorable form. */
export function serializeOpenWorkspaceDraft(draft: OpenWorkspaceDraft): unknown {
  return { ...draft, repositoryUrl: restorableRepositoryUrl(draft.repositoryUrl) };
}

/** The allowlist parser for a stored draft: unknown fields and malformed values are dropped. */
export function parseOpenWorkspaceDraft(raw: unknown): OpenWorkspaceDraft | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const base = initialOpenWorkspaceDraft();
  const step = typeof record.step === 'string' && oneOf(OPEN_WORKSPACE_STEPS)(record.step) ? record.step : base.step;
  const network = typeof record.networkProfile === 'string' && oneOf(NETWORK_PROFILES.map((profile) => profile.value))(record.networkProfile)
    ? record.networkProfile : base.networkProfile;
  const overrides: Record<string, string> = {};
  for (const [name, revision] of Object.entries(rec(record.skillOverrides)).slice(0, 128)) {
    if (SKILL_NAME.test(name) && typeof revision === 'string' && ID.test(revision)) overrides[name] = revision;
  }
  const launchRecord = rec(record.launch);
  const launch = typeof launchRecord.key === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(launchRecord.key) && typeof launchRecord.intent === 'string'
    ? { key: launchRecord.key, intent: launchRecord.intent } : undefined;
  return {
    open: record.open === true,
    step,
    repositoryUrl: restorableRepositoryUrl(text(record.repositoryUrl)),
    ref: text(record.ref).slice(0, 255),
    networkProfile: network,
    skillSetIds: strings(record.skillSetIds, isId, 16),
    skillOverrides: overrides,
    presets: strings(record.presets, oneOf(PRESET_TOOLKIT_IDS), PRESET_TOOLKIT_IDS.length),
    agentkits: strings(record.agentkits, oneOf(AGENTKIT_IDS), AGENTKIT_IDS.length),
    ...(launch ? { launch } : {})
  };
}

/** The repository step's own check, before the runner's host and policy validation. */
export function repositoryError(repositoryUrl: string): string | undefined {
  const trimmed = repositoryUrl.trim();
  if (!trimmed) return 'Enter the repository HTTPS URL.';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return 'Use an HTTPS repository URL.';
    if (url.username || url.password) return 'Remove credentials from the URL: private clones authenticate through the harness, never the URL.';
    return undefined;
  } catch {
    return 'Enter a valid URL, for example https://github.com/org/repo.';
  }
}

export type SkillSet = { id: string; name: string; description: string; generation: number };
export type SkillConflict = { name: string; candidates: Array<{ revisionId: string; tier: string }> };
export type SkillPreview = { resolved: number; excluded: number; conflicts: SkillConflict[] };
export type PresetToolkit = { id: PresetToolkitId; name: string; description: string; license: string };
export type LicensedKit = { kitId: AgentkitId; name: string; description: string; channel: string; ready: boolean };

export function skillSetsOf(data: unknown): SkillSet[] {
  return arr(rec(data).sets).flatMap((set) => {
    const id = text(set.id);
    const generation = typeof set.generation === 'number' && Number.isSafeInteger(set.generation) && set.generation > 0 ? set.generation : 0;
    return id ? [{ id, name: text(set.name) || id, description: text(set.description), generation }] : [];
  });
}

export function skillPreviewOf(data: unknown): SkillPreview {
  const record = rec(data);
  return {
    resolved: arr(record.resolved).length,
    excluded: arr(record.excluded).length,
    conflicts: arr(record.conflicts).map((conflict) => ({
      name: text(conflict.name),
      candidates: arr(conflict.candidates).map((candidate) => ({ revisionId: text(candidate.revisionId), tier: text(candidate.tier) || 'unknown' }))
        .filter((candidate) => candidate.revisionId)
    })).filter((conflict) => conflict.name)
  };
}

export function toolkitsOf(data: unknown): { presets: PresetToolkit[]; licensed: LicensedKit[] } {
  const record = rec(data);
  const isPreset = oneOf(PRESET_TOOLKIT_IDS);
  const isKit = oneOf(AGENTKIT_IDS);
  return {
    presets: arr(record.toolkits).flatMap((preset) => {
      const id = text(preset.id);
      return isPreset(id) ? [{ id, name: text(preset.name) || id, description: text(preset.description), license: text(preset.license) }] : [];
    }),
    licensed: arr(record.licensedKits).flatMap((kit) => {
      const kitId = text(kit.kitId);
      return isKit(kitId)
        ? [{ kitId, name: text(kit.name) || kitId, description: text(kit.description), channel: text(kit.defaultChannel) || 'stable', ready: kit.available === true && kit.credentialReady === true }]
        : [];
    })
  };
}

/** The skill-set selections, each fenced by the generation the operator was shown. */
export function skillSetSelections(draft: OpenWorkspaceDraft, sets: SkillSet[]) {
  return draft.skillSetIds.flatMap((id) => {
    const set = sets.find((candidate) => candidate.id === id);
    return set && set.generation > 0 ? [{ skillSetId: id, expectedGeneration: set.generation }] : [];
  });
}

/** Overrides that still answer a live conflict; one for a conflict that went away is dropped. */
export function activeOverrides(draft: OpenWorkspaceDraft, conflicts: SkillConflict[]): Record<string, string> {
  const live: Record<string, string> = {};
  for (const conflict of conflicts) {
    const chosen = draft.skillOverrides[conflict.name];
    if (chosen && conflict.candidates.some((candidate) => candidate.revisionId === chosen)) live[conflict.name] = chosen;
  }
  return live;
}

/** True while any conflict still lacks an override: the resolver would refuse the launch. */
export function launchBlocked(draft: OpenWorkspaceDraft, conflicts: SkillConflict[]): boolean {
  return conflicts.some((conflict) => activeOverrides(draft, conflicts)[conflict.name] === undefined);
}

/**
 * The toolkit selections. Every one is owner-scoped: a workspace-scope toolkit writes into
 * the repository and needs the separate `allowToolkitWorkspaceChanges` confirmation, which
 * this wizard does not offer.
 */
export function toolkitSelections(draft: OpenWorkspaceDraft, licensed: LicensedKit[]) {
  return [
    ...draft.presets.map((id) => ({ kind: 'preset' as const, id, scope: 'owner' as const })),
    ...draft.agentkits.flatMap((kitId) => {
      const kit = licensed.find((candidate) => candidate.kitId === kitId);
      return kit?.ready ? [{ kind: 'agentkit' as const, kitId, channel: kit.channel, scope: 'owner' as const }] : [];
    })
  ];
}

/** The `workspace_open` body without its idempotency key; its JSON is the launch intent. */
export function openWorkspaceRequest(draft: OpenWorkspaceDraft, sets: SkillSet[], conflicts: SkillConflict[], licensed: LicensedKit[]) {
  const ref = draft.ref.trim();
  return {
    repositoryUrl: draft.repositoryUrl.trim(),
    ...(ref ? { ref } : {}),
    networkProfile: draft.networkProfile,
    skillSets: skillSetSelections(draft, sets),
    skillOverrides: activeOverrides(draft, conflicts),
    toolkits: toolkitSelections(draft, licensed)
  };
}

export function openedWorkspaceId(data: unknown): string | undefined {
  const id = text(rec(data).workspaceId);
  return id || undefined;
}
