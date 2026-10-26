/**
 * The Automation and Deploy tabs' read shapes (`apps/api/src/dashboard-response.ts`
 * `skills_list`, `hooks_list`, `deployments_list`) and the guarded run bodies. Every run
 * carries the digest it was shown (`packages/contracts/src/tool-schemas.ts` `skills_run`,
 * `hooks_run`), so a skill or hook changed after the page loaded is refused, not run.
 */
import { ApiError } from '@/lib/api-client';
import { arr, text } from '@/lib/format';

/** `contentSha256` is the skill bundle digest `skills_run` verifies (`expectedContentSha256`). */
export type WorkspaceSkill = { name: string; tier?: string; description?: string; contentSha256?: string };
export type WorkspaceHook = { name: string; events: string[]; active: boolean; description?: string; sha256?: string };
export type DeploymentTarget = { name: string; cwd: string; lastResult: string; duration: string; failure: string };
export type RunResult = { exitCode?: number; durationMs?: number; output: string; status?: string; executionMode?: string; signal?: string };

/** The lifecycle events hooks can run on, in pipeline order (`HookEventSchema`). */
export const HOOK_LIFECYCLE = [
  { id: 'on_workspace_open', label: 'On workspace open' },
  { id: 'post_checkout', label: 'After checkout' },
  { id: 'pre_commit', label: 'Before commit' },
  { id: 'post_commit', label: 'After commit' },
  { id: 'manual', label: 'Manual' }
] as const;

/** The contract's script and target name pattern: no paths, no shell syntax. */
export const SCRIPT_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

const optional = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const digest = (value: unknown) => (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : undefined);

export function skillsOf(data: unknown): WorkspaceSkill[] {
  return arr((data as Record<string, unknown> | undefined)?.skills)
    .filter((skill) => text(skill.name) !== '')
    .map((skill) => {
      const tier = optional(skill.tier); const description = optional(skill.description); const contentSha256 = digest(skill.contentSha256);
      return { name: text(skill.name), ...(tier ? { tier } : {}), ...(description ? { description } : {}), ...(contentSha256 ? { contentSha256 } : {}) };
    });
}

export function hooksOf(data: unknown): { hooks: WorkspaceHook[]; manifestSha256?: string } {
  const record = (data ?? {}) as Record<string, unknown>;
  const hooks = arr(record.hooks)
    .map((hook) => {
      const name = text(hook.name) || text(hook.path);
      const events = Array.isArray(hook.events) ? hook.events.filter((event): event is string => typeof event === 'string') : (typeof hook.event === 'string' ? [hook.event] : []);
      const description = optional(hook.description); const sha256 = digest(hook.sha256);
      return { name, events, active: hook.active !== false, ...(description ? { description } : {}), ...(sha256 ? { sha256 } : {}) };
    })
    .filter((hook) => hook.name !== '');
  const manifestSha256 = digest(record.manifestSha256);
  return { hooks, ...(manifestSha256 ? { manifestSha256 } : {}) };
}

/** Hooks grouped by the lifecycle event that runs them (one hook may sit in several stages). */
export function groupHooksByLifecycle(hooks: readonly WorkspaceHook[]) {
  return HOOK_LIFECYCLE.map((event) => ({ ...event, hooks: hooks.filter((hook) => hook.events.includes(event.id)) }));
}

/**
 * The `hooks_run` body for one hook at one stage. The contract requires a digest: the
 * manifest digest when the list reported one, else the hook's own. No digest, no run.
 */
export function hookRunBody(hook: WorkspaceHook, event: string, manifestSha256: string | undefined): Record<string, unknown> | undefined {
  if (manifestSha256) return { name: hook.name, event, expectedManifestSha256: manifestSha256 };
  if (hook.sha256) return { name: hook.name, event, expectedSha256: hook.sha256 };
  return undefined;
}

/** The Deploy tab's restorable wizard state: only the chosen target's name, never run output. */
export type DeployDraft = { target?: string };
export function parseDeployDraft(raw: unknown): DeployDraft | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const target = (raw as Record<string, unknown>).target;
  return typeof target === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(target) ? { target } : {};
}

export function deploymentsOf(data: unknown): DeploymentTarget[] {
  return arr((data as Record<string, unknown> | undefined)?.deployments)
    .filter((target) => text(target.name) !== '')
    .map((target) => {
      const ms = Number(target.durationMs);
      return {
        name: text(target.name),
        cwd: text(target.cwd),
        lastResult: text(target.lastResult) || text(target.status) || 'Not reported',
        duration: target.durationMs !== undefined && target.durationMs !== null && Number.isFinite(ms) ? `${ms} ms` : 'Not reported',
        failure: text(target.error) || 'None reported'
      };
    });
}

export function runResultOf(data: unknown): RunResult {
  const record = (data ?? {}) as Record<string, unknown>;
  const status = optional(record.status); const executionMode = optional(record.executionMode);
  const signal = typeof record.signal === 'string' && /^SIG[A-Z0-9]+$/.test(record.signal) ? record.signal : undefined;
  return {
    ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
    ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
    ...(status ? { status } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(signal ? { signal } : {}),
    output: text(record.output)
  };
}

/**
 * The result a failed skill run still reports: a script that ran and exited non-zero is a 422
 * `execution_failed` carrying the run's projection, so the operator sees its exit code and
 * output. Any other error has no run to show.
 */
export function skillRunFailure(error: unknown): RunResult | undefined {
  return error instanceof ApiError && error.code === 'execution_failed' && error.data ? runResultOf(error.data) : undefined;
}
