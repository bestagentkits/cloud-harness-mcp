import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, type AgentKitSkillLock, type KitLock, type ToolkitSelection } from '@cloud-harness/contracts';

type LicensedKitId = 'engineer' | 'marketing';
type AgentKitSelection = Extract<ToolkitSelection, { kind: 'agentkit' }>;

const LICENSED_KITS: readonly LicensedKitId[] = ['engineer', 'marketing'];
const SEMVER = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_INCLUDED_SKILLS = 128;

/** One locked package the planned toolkit must deliver: any of `names` present in the bundle satisfies it. */
export type KitLockExpectation = { instanceId: string; identity: string; names: string[] };

export type KitLockPlan = { toolkits: AgentKitSelection[]; expectations: KitLockExpectation[] };

export function kitLockInstanceId(kitId: LicensedKitId): string {
  return `kit-lock-${kitId}`;
}

/**
 * The registry publishes prereleases on the `dev` and `beta` channels; a locked version is resolved on
 * the channel its prerelease tag names, and a plain release on `stable`.
 */
function channelForVersion(version: string): AgentKitSelection['channel'] {
  const prerelease = SEMVER.exec(version)?.[1]?.toLowerCase();
  if (!prerelease) return 'stable';
  if (prerelease.startsWith('dev')) return 'dev';
  return 'beta';
}

/** The kit package names a skill directory after its alias; a package with none uses its identity's last segment. */
function lockedSkillNames(entry: AgentKitSkillLock['packages'][number]): string[] {
  if (entry.aliases && entry.aliases.length > 0) return [...new Set(entry.aliases)];
  const tail = entry.identity.split('/').pop() ?? entry.identity;
  return [tail];
}

function planAgentKitLock(lock: AgentKitSkillLock): KitLockPlan {
  const versions = new Map<LicensedKitId, string>();
  const names = new Map<LicensedKitId, Set<string>>();
  const expectations: KitLockExpectation[] = [];
  const unsupported: string[] = [];

  for (const entry of lock.packages) {
    // A skill several kits ship is installed from the first kit its lock record names, so one bundle
    // owns it and two toolkits never project the same skill name.
    const source = entry.sources.find((candidate) => candidate.provider === 'kit');
    const kitId = source?.kit as LicensedKitId | undefined;
    if (!source || !kitId || !LICENSED_KITS.includes(kitId)) {
      unsupported.push(entry.identity);
      continue;
    }
    const kitVersion = source.kitVersion;
    if (!kitVersion || !SEMVER.test(kitVersion)) {
      throw new HarnessError('INVALID_INPUT', `kit lock entry ${entry.identity} does not pin a semantic kit version`, 400, false);
    }
    const pinned = versions.get(kitId);
    if (pinned !== undefined && pinned !== kitVersion) {
      throw new HarnessError('INVALID_INPUT', `kit lock pins the ${kitId} kit at both ${pinned} and ${kitVersion}`, 400, false);
    }
    versions.set(kitId, kitVersion);
    const skillNames = lockedSkillNames(entry);
    const included = names.get(kitId) ?? new Set<string>();
    for (const name of skillNames) included.add(name);
    names.set(kitId, included);
    expectations.push({ instanceId: kitLockInstanceId(kitId), identity: entry.identity, names: skillNames });
  }

  // Skills from SkillX, Git or local sources need their own resolvers; installing only part of a lock
  // would leave the workspace silently different from the machine that wrote it.
  if (unsupported.length > 0) {
    const shown = unsupported.slice(0, 10).join(', ');
    const more = unsupported.length > 10 ? ` and ${unsupported.length - 10} more` : '';
    throw new HarnessError(
      'INVALID_INPUT',
      `kit lock entries without an engineer or marketing kit source cannot be installed yet: ${shown}${more}`,
      400,
      false
    );
  }

  const toolkits: AgentKitSelection[] = [];
  for (const kitId of LICENSED_KITS) {
    const version = versions.get(kitId);
    const include = names.get(kitId);
    if (!version || !include) continue;
    if (include.size > MAX_INCLUDED_SKILLS) {
      throw new HarnessError('INVALID_INPUT', `kit lock selects ${include.size} ${kitId} skills, above the ${MAX_INCLUDED_SKILLS} limit`, 400, false);
    }
    toolkits.push({
      kind: 'agentkit',
      instanceId: kitLockInstanceId(kitId),
      kitId,
      channel: channelForVersion(version),
      version,
      scope: 'owner',
      skills: { include: [...include].sort() },
      activation: 'skills-only'
    });
  }
  return { toolkits, expectations };
}

/**
 * Expands `workspace_open.kitLocks` into pinned `agentkit` toolkit selections. The registry still
 * verifies every kit package signature and digest; the lock only chooses the kit version and skills.
 */
export function planKitLockToolkits(
  locks: KitLock[] | undefined,
  options: { enabled: boolean; explicitToolkits: ToolkitSelection[] }
): KitLockPlan {
  if (!locks || locks.length === 0) return { toolkits: [], expectations: [] };
  if (!options.enabled) {
    throw new HarnessError(
      'INVALID_INPUT',
      'kitLocks installation is disabled on this instance; the operator enables it with ENABLE_KIT_LOCK_INSTALL=true',
      400,
      false
    );
  }
  const plan: KitLockPlan = { toolkits: [], expectations: [] };
  for (const lock of locks) {
    if (lock.schema === 'skillx.personal-kit-lock/v1') {
      throw new HarnessError(
        'INVALID_INPUT',
        `SkillX personal kit ${lock.kit} cannot be installed yet: resolving private kit revisions needs agentkit.best sign-in, which this instance does not support`,
        400,
        false
      );
    }
    const next = planAgentKitLock(lock);
    for (const toolkit of next.toolkits) {
      if (plan.toolkits.some((existing) => existing.kitId === toolkit.kitId)) {
        throw new HarnessError('INVALID_INPUT', `more than one kit lock selects the ${toolkit.kitId} kit`, 400, false);
      }
    }
    plan.toolkits.push(...next.toolkits);
    plan.expectations.push(...next.expectations);
  }
  for (const toolkit of plan.toolkits) {
    if (options.explicitToolkits.some((explicit) => explicit.kind === 'agentkit' && explicit.kitId === toolkit.kitId)) {
      throw new HarnessError(
        'INVALID_INPUT',
        `the ${toolkit.kitId} kit is selected by both toolkits and kitLocks; choose one`,
        400,
        false
      );
    }
  }
  return plan;
}

/**
 * Confirms every locked package arrived in its kit bundle. The adapter's include filter skips a name
 * the package does not carry, so a renamed or removed skill would otherwise open a workspace that
 * quietly lacks it.
 */
export function assertKitLockSatisfied(
  expectations: KitLockExpectation[],
  bundlePaths: Array<{ instanceId: string; path: string }>
): void {
  if (expectations.length === 0) return;
  const delivered = new Map<string, Set<string>>();
  for (const bundle of bundlePaths) {
    delivered.set(bundle.instanceId, readBundleSkillNames(bundle.path));
  }
  const missing = expectations.filter((expectation) => {
    const names = delivered.get(expectation.instanceId);
    return !names || !expectation.names.some((name) => names.has(name));
  });
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).map((entry) => entry.identity).join(', ');
    const more = missing.length > 10 ? ` and ${missing.length - 10} more` : '';
    throw new HarnessError(
      'NOT_FOUND',
      `the locked kit version does not contain these locked skills: ${shown}${more}`,
      404,
      false
    );
  }
}

function readBundleSkillNames(bundlePath: string): Set<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8')) as { skills?: unknown };
    if (!Array.isArray(manifest.skills)) return new Set();
    return new Set(manifest.skills.flatMap((skill) => {
      const name = (skill as { name?: unknown } | null)?.name;
      return typeof name === 'string' ? [name] : [];
    }));
  } catch {
    return new Set();
  }
}
