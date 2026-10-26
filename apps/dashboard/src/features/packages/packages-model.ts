/**
 * The managed packages overview (`package_overview` in `apps/api/src/dashboard-response.ts`)
 * and the copy of the classic page (`renderPackages` in `apps/api/dashboard/dashboard-render.js`).
 * Rollback and uninstall post the binding generation the operator was shown, so a package
 * that changed since the page loaded is refused (`PackagesRollbackInputSchema`,
 * `PackagesRemoveInputSchema` in `packages/contracts/src/package-schemas.ts`).
 */
import { arr, rec, text } from '@/lib/format';
import { type PackagePlan, planIsActionable } from '@/features/approvals/approvals-model';

export type PackageRuntime = PackagePlan['runtime'];
export type PackageRelease = {
  releaseId: string; name: string; version: string; status: string; stale: boolean;
  treeDigest?: string; sizeBytes?: number; fileCount?: number; dependencyCount?: number;
  binaries: string[]; createdAt?: string; lifecycleScripts: boolean;
  runtime: PackageRuntime; source: string;
};
export type PackageHistoryEntry = { releaseId: string; version: string; generation?: number; reason: string; actor: string; createdAt?: string; available: boolean };
export type PackageBinding = {
  bindingId: string; name: string; ecosystem: string; scope: string; workspaceId?: string;
  generation?: number; affected: number; release: PackageRelease | null; history: PackageHistoryEntry[];
};
export type PackageApply = { applyId: string; title: string; state: string; errorCode?: string; errorMessage?: string; createdAt?: string; updatedAt?: string; finishedAt?: string };
export type PackagesOverview = {
  enabled: boolean;
  approvalMode: string;
  ecosystems: string[];
  lifecycleScripts: string;
  quotas: { maxReleaseBytes?: number; maxOwnerBytes?: number; maxBindings?: number };
  usage: { ownerBytes?: number; bindings?: number };
  bindings: PackageBinding[];
  releases: PackageRelease[];
  inFlight: PackageApply[];
  recentApplies: PackageApply[];
  pendingPlans: number;
};

export const APPLY_STEPS = ['QUEUED', 'BUILDING', 'VERIFYING', 'PUBLISHING'] as const;
export const APPLY_STEP_LABELS: Record<string, string> = { QUEUED: 'Queued', BUILDING: 'Building', VERIFYING: 'Verifying', PUBLISHING: 'Publishing', SUCCEEDED: 'Succeeded', FAILED: 'Failed' };

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined || value === '' ? {} : { [key]: value }) as Partial<Record<K, V>>;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function releaseOf(value: unknown): PackageRelease | null {
  if (!value || typeof value !== 'object') return null;
  const release = value as Record<string, unknown>;
  const source = rec(release.source);
  return {
    releaseId: text(release.releaseId), name: text(release.name), version: text(release.version) || 'unknown',
    status: text(release.status), stale: release.stale === true, lifecycleScripts: release.lifecycleScripts === true,
    binaries: strings(release.binaries), runtime: (release.runtime && typeof release.runtime === 'object' ? release.runtime : null) as PackageRuntime,
    source: text(source.resolved) || text(source.registry) || 'Not reported',
    ...opt('treeDigest', text(release.treeDigest)), ...opt('sizeBytes', num(release.sizeBytes)), ...opt('fileCount', num(release.fileCount)),
    ...opt('dependencyCount', num(release.dependencyCount)), ...opt('createdAt', text(release.createdAt))
  };
}

function applyOf(apply: Record<string, unknown>): PackageApply {
  const name = text(apply.name);
  return {
    applyId: text(apply.applyId), title: name ? `${name}@${text(apply.version)}` : text(apply.applyId) || 'Apply', state: text(apply.state),
    ...opt('errorCode', text(apply.errorCode)), ...opt('errorMessage', text(apply.errorMessage)),
    ...opt('createdAt', text(apply.createdAt)), ...opt('updatedAt', text(apply.updatedAt)), ...opt('finishedAt', text(apply.finishedAt))
  };
}

export function packagesOverviewOf(data: unknown, now = Date.now()): PackagesOverview {
  const body = rec(data);
  const quotas = rec(body.quotas); const usage = rec(body.usage);
  return {
    enabled: body.enabled === true,
    approvalMode: text(body.approvalMode) || 'required',
    ecosystems: strings(body.ecosystems),
    lifecycleScripts: text(body.lifecycleScripts),
    quotas: { ...opt('maxReleaseBytes', num(quotas.maxReleaseBytes)), ...opt('maxOwnerBytes', num(quotas.maxOwnerBytes)), ...opt('maxBindings', num(quotas.maxBindings)) },
    usage: { ...opt('ownerBytes', num(usage.ownerBytes)), ...opt('bindings', num(usage.bindings)) },
    bindings: arr(body.bindings).filter((binding) => text(binding.bindingId) !== '').map((binding) => ({
      bindingId: text(binding.bindingId), name: text(binding.name) || 'package', ecosystem: text(binding.ecosystem), scope: text(binding.scope),
      ...opt('workspaceId', text(binding.workspaceId)), ...opt('generation', num(binding.generation)),
      affected: strings(binding.affectedWorkspaces).length,
      release: releaseOf(binding.release),
      history: arr(binding.history).map((entry) => ({
        releaseId: text(entry.releaseId), version: text(entry.version) || 'Unknown', reason: text(entry.reason), actor: text(entry.actor),
        available: entry.available === true, ...opt('generation', num(entry.generation)), ...opt('createdAt', text(entry.createdAt))
      }))
    })),
    releases: arr(body.releases).map(releaseOf).filter((release): release is PackageRelease => release !== null),
    inFlight: arr(body.inFlight).map(applyOf),
    recentApplies: arr(body.recentApplies).map(applyOf),
    pendingPlans: arr(body.pendingPlans).filter((plan) => planIsActionable(plan as unknown as PackagePlan, now)).length
  };
}

/** A release's health label and the badge tone the classic page gives it. */
export function releaseHealth(release: PackageRelease | null): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!release) return { label: 'Missing release', tone: 'danger' };
  if (release.status === 'MISSING') return { label: 'Missing on disk', tone: 'danger' };
  if (release.stale) return { label: 'Stale image', tone: 'warning' };
  if (release.status === 'VERIFIED') return { label: 'Verified', tone: 'success' };
  return { label: release.status || 'Unknown', tone: 'neutral' };
}

export function bindingRisks(release: PackageRelease | null): string[] {
  const risks: string[] = [];
  if (release?.lifecycleScripts) risks.push('Built with npm lifecycle scripts enabled.');
  if (release?.status === 'MISSING') risks.push('The release directory is missing. New workspaces start without this tool until it is re-applied or rolled back.');
  if (release?.stale) risks.push('Built against an older executor image. Re-plan and apply to rebuild it.');
  return risks;
}

export function approvalModeText(mode: string): string {
  return mode === 'not_required' ? 'Not required (policy)' : mode === 'unavailable' ? 'Unavailable' : 'Required';
}

export function workspaceCount(count: number): string {
  return `${count} ${count === 1 ? 'workspace' : 'workspaces'}`;
}

/** A write is fenced by the binding generation; a binding without one cannot change from here. */
export function bindingFenced(binding: PackageBinding): binding is PackageBinding & { generation: number } {
  return Number.isInteger(binding.generation) && (binding.generation ?? 0) > 0;
}

export type PackageChange =
  | { kind: 'rollback'; binding: PackageBinding & { generation: number }; entry: PackageHistoryEntry }
  | { kind: 'remove'; binding: PackageBinding & { generation: number } };

/** The request of one change, exactly as the classic page sends it. */
export function packageChangeRequest(change: PackageChange): { path: string; body: Record<string, unknown> } {
  return change.kind === 'rollback'
    ? { path: '/packages/rollback', body: { bindingId: change.binding.bindingId, releaseId: change.entry.releaseId, expectedGeneration: change.binding.generation } }
    : { path: '/packages/remove', body: { bindingId: change.binding.bindingId, expectedGeneration: change.binding.generation } };
}

/** The confirmation copy of the classic page: title, consequence, target, labels and success. */
export function packageChangeCopy(change: PackageChange) {
  const { binding } = change;
  const affected = workspaceCount(binding.affected);
  if (change.kind === 'rollback') {
    const from = binding.release?.version ?? 'unknown';
    const to = change.entry.version;
    return {
      title: `Roll back ${binding.name} from ${from} to ${to}?`,
      description: `This replaces the active release for ${affected}. Workspaces created or recreated afterwards get ${to}; running workspaces keep ${from} until they are recreated. The rollback is refused if the package changed after this page loaded (expected generation ${binding.generation}). It is audited.`,
      target: `${binding.name} ${to} · ${change.entry.releaseId}`,
      confirmLabel: 'Roll back', pendingLabel: 'Rolling back…',
      success: `${binding.name} rolled back to ${to}.`
    };
  }
  return {
    title: `Uninstall ${binding.name}?`,
    description: `This removes the ${binding.scope === 'workspace' ? 'workspace' : 'owner'} binding and its release history for ${affected}. Workspaces created or recreated afterwards start without ${binding.name}; running workspaces keep it until they are recreated, and releases they still mount are collected later. Installing it again needs a new plan and apply. The uninstall is refused while an apply is running or if the package changed after this page loaded (expected generation ${binding.generation}). It is audited.`,
    target: `${binding.name} · ${binding.bindingId}`,
    confirmLabel: 'Uninstall', pendingLabel: 'Uninstalling…',
    success: `${binding.name} uninstalled.`
  };
}
