import { z } from 'zod';

/**
 * Workspace limits and lifecycle settings (`GET/POST /settings` → `workspaceLifecycle`).
 * The response is an unmapped runner passthrough (parity matrix F7), so `readLifecycleView`
 * accepts only a complete, well-formed view and the panel renders nothing for anything else
 * (a runner that predates the settings, or a malformed answer). The input parsing mirrors the
 * classic `workspaceLifecycleUpdateInput`; the runner re-validates every rule.
 */

export type LifecycleFieldName = 'maxActiveWorkspacesPerOwner' | 'idleTtlSeconds' | 'wallTtlSeconds' | 'recoverableGraceSeconds';
export type LifecycleSource = 'setting' | 'environment' | 'default';

export type LifecycleField = { name: LifecycleFieldName; label: string; unit: 'count' | 'minutes' };

/** Display order. The quota is a count; the durations are edited in whole minutes over integer seconds. */
export const LIFECYCLE_FIELDS: readonly LifecycleField[] = [
  { name: 'maxActiveWorkspacesPerOwner', label: 'Max active workspaces per principal', unit: 'count' },
  { name: 'idleTtlSeconds', label: 'Idle timeout (minutes)', unit: 'minutes' },
  { name: 'wallTtlSeconds', label: 'Maximum workspace lifetime (minutes)', unit: 'minutes' },
  { name: 'recoverableGraceSeconds', label: 'Recoverable grace before auto-close (minutes)', unit: 'minutes' }
];

export type LifecycleSetting = { value: number; source: LifecycleSource | undefined; runnerValue: number; min: number; max: number };

export type LifecycleView = {
  revision: number;
  updatedAt: string | null;
  settings: Record<LifecycleFieldName, LifecycleSetting>;
  reaperIntervalSeconds: number | undefined;
  usage: { counted: number; limit: number | undefined; recoverable: number; autoCloseDeferred: number };
  executorCeilings: { memoryBytes: number | undefined; cpus: number | undefined; pids: number | undefined };
};

/** The editable form values: raw input text per field, plus the grace-0 acknowledgement. */
export type LifecycleValues = Record<LifecycleFieldName, string> & { acknowledgeImmediateClose: boolean };
export type LifecycleErrors = Partial<Record<LifecycleFieldName | 'acknowledgeImmediateClose', string>>;
export type LifecycleUpdate = { expectedRevision: number } & Partial<Record<LifecycleFieldName, number | null>> & { acknowledgeImmediateClose?: true };

const SOURCE_LABELS: Record<LifecycleSource, string> = { setting: 'Dashboard override', environment: 'Runner environment', default: 'Built-in default' };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const count = (value: unknown, fallback = 0): number => (isCount(value) ? value : fallback);
const optionalCount = (value: unknown): number | undefined => (isCount(value) ? value : undefined);

export function sourceLabel(source: LifecycleSource | undefined): string {
  return source ? SOURCE_LABELS[source] : 'Unknown';
}

/** The complete view, or `undefined` when any field the form needs is missing or malformed. */
export function readLifecycleView(raw: unknown): LifecycleView | undefined {
  const view = record(raw);
  const settings = record(view?.settings);
  if (!view || !settings || !Number.isInteger(view.revision) || (view.revision as number) < 0) return undefined;
  const read = {} as Record<LifecycleFieldName, LifecycleSetting>;
  for (const { name } of LIFECYCLE_FIELDS) {
    const setting = record(settings[name]);
    if (!setting || !isCount(setting.value) || !isCount(setting.runnerValue) || !isCount(setting.min) || !isCount(setting.max)) return undefined;
    const source = setting.source === 'setting' || setting.source === 'environment' || setting.source === 'default' ? setting.source : undefined;
    read[name] = { value: setting.value, source, runnerValue: setting.runnerValue, min: setting.min, max: setting.max };
  }
  const usage = record(view.usage) ?? {};
  const ceilings = record(view.executorCeilings) ?? {};
  return {
    revision: view.revision as number,
    updatedAt: typeof view.updatedAt === 'string' ? view.updatedAt : null,
    settings: read,
    reaperIntervalSeconds: optionalCount(view.reaperIntervalSeconds),
    usage: { counted: count(usage.counted), limit: optionalCount(usage.limit), recoverable: count(usage.recoverable), autoCloseDeferred: count(usage.autoCloseDeferred) },
    executorCeilings: { memoryBytes: optionalCount(ceilings.memoryBytes), cpus: optionalCount(ceilings.cpus), pids: optionalCount(ceilings.pids) }
  };
}

/** The editable bounds in the display unit; minute bounds stay inside the runner's second bounds. */
export function fieldBounds(field: LifecycleField, setting: LifecycleSetting): { min: number; max: number } {
  if (field.unit === 'count') return { min: setting.min, max: setting.max };
  return { min: Math.ceil(setting.min / 60), max: Math.floor(setting.max / 60) };
}

/** A runner value that is not a whole minute (the environment allows 30 s idle) shows as a decimal and is sent only if edited. */
export function displayValue(field: LifecycleField, value: number): string {
  return field.unit === 'count' ? String(value) : String(Math.round((value / 60) * 100) / 100);
}

/** A duration in seconds as the operator reads it. */
export function durationLabel(seconds: unknown): string {
  if (!isCount(seconds)) return 'unknown';
  if (seconds % 60 !== 0) return `${seconds} s`;
  const minutes = seconds / 60;
  return minutes >= 120 && minutes % 60 === 0 ? `${minutes} min (${minutes / 60} h)` : `${minutes} min`;
}

export function valueLabel(field: LifecycleField, value: number): string {
  return field.unit === 'count' ? String(value) : durationLabel(value);
}

export function bytesLabel(bytes: number | undefined): string {
  if (!isCount(bytes)) return 'unknown memory';
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${Math.round(gib * 100) / 100} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** The form values the view loads with. */
export function lifecycleDefaults(view: LifecycleView): LifecycleValues {
  const values = { acknowledgeImmediateClose: false } as LifecycleValues;
  for (const field of LIFECYCLE_FIELDS) values[field.name] = displayValue(field, view.settings[field.name].value);
  return values;
}

/** Any spelling of zero (0, 00, 0.0) needs the acknowledgement, so it must be visible for all of them. */
export function graceIsZero(raw: string): boolean {
  return raw.trim() !== '' && Number(raw.trim()) === 0;
}

/**
 * The lifecycle write for the edited values, or the field errors that block it. Only fields
 * whose value changed are sent, in seconds, with the revision the panel loaded, so a
 * concurrent save from elsewhere surfaces as a conflict instead of being overwritten.
 */
export function lifecycleUpdateInput(view: LifecycleView, values: Partial<LifecycleValues>, acknowledged: boolean): { errors: LifecycleErrors; body: LifecycleUpdate | undefined } {
  const errors: LifecycleErrors = {};
  const update: LifecycleUpdate = { expectedRevision: view.revision };
  const effective = {} as Record<LifecycleFieldName, number>;
  for (const field of LIFECYCLE_FIELDS) {
    const setting = view.settings[field.name];
    effective[field.name] = setting.value;
    const raw = String(values[field.name] ?? '').trim();
    if (raw === displayValue(field, setting.value)) continue;
    const number = raw === '' ? Number.NaN : Number(raw);
    const bounds = fieldBounds(field, setting);
    if (!Number.isInteger(number) || number < bounds.min || number > bounds.max) {
      errors[field.name] = field.unit === 'count'
        ? `Enter a whole number from ${bounds.min} to ${bounds.max}.`
        : `Enter whole minutes from ${bounds.min} to ${bounds.max}.`;
      continue;
    }
    const next = field.unit === 'count' ? number : number * 60;
    if (next === setting.value) continue;
    update[field.name] = next;
    effective[field.name] = next;
  }
  if (!errors.idleTtlSeconds && !errors.wallTtlSeconds && effective.idleTtlSeconds > effective.wallTtlSeconds) {
    const field = update.wallTtlSeconds !== undefined && update.idleTtlSeconds === undefined ? 'wallTtlSeconds' : 'idleTtlSeconds';
    errors[field] = `The idle timeout (${durationLabel(effective.idleTtlSeconds)}) cannot exceed the maximum lifetime (${durationLabel(effective.wallTtlSeconds)}).`;
  }
  if (update.recoverableGraceSeconds === 0) {
    if (acknowledged) update.acknowledgeImmediateClose = true;
    else errors.acknowledgeImmediateClose = 'Confirm that a grace of 0 closes expired workspaces without a recovery window.';
  }
  const changed = LIFECYCLE_FIELDS.some((field) => update[field.name] !== undefined);
  return { errors, body: Object.keys(errors).length > 0 || !changed ? undefined : update };
}

/** Clears every override so each field falls back to the runner value the panel shows beside it. */
export function lifecycleResetInput(view: LifecycleView): { error: string; body?: undefined } | { body: LifecycleUpdate; error?: undefined } {
  const idle = view.settings.idleTtlSeconds.runnerValue;
  const wall = view.settings.wallTtlSeconds.runnerValue;
  if (idle > wall) {
    return { error: `The runner values cannot be restored: the runner idle timeout (${durationLabel(idle)}) exceeds its maximum lifetime (${durationLabel(wall)}). Fix the runner environment, or keep a Dashboard override.` };
  }
  return { body: { expectedRevision: view.revision, maxActiveWorkspacesPerOwner: null, idleTtlSeconds: null, wallTtlSeconds: null, recoverableGraceSeconds: null } };
}

/** The read-back the status line announces after a save, so the operator hears what the runner stored. */
export function lifecycleSummary(view: LifecycleView | undefined): string {
  if (!view) return '';
  const { settings } = view;
  return `Effective: up to ${settings.maxActiveWorkspacesPerOwner.value} active per principal, idle ${durationLabel(settings.idleTtlSeconds.value)}, lifetime ${durationLabel(settings.wallTtlSeconds.value)}, grace ${durationLabel(settings.recoverableGraceSeconds.value)}.`;
}

/**
 * The form schema for `zodResolver`: the field rules of `lifecycleUpdateInput`, checked while
 * the operator types. The grace-0 acknowledgement is asked for only at save time, so it is
 * treated as given here and checked by the save itself.
 */
export function lifecycleSchema(view: LifecycleView) {
  return z.object({
    maxActiveWorkspacesPerOwner: z.string(),
    idleTtlSeconds: z.string(),
    wallTtlSeconds: z.string(),
    recoverableGraceSeconds: z.string(),
    acknowledgeImmediateClose: z.boolean()
  }).superRefine((values, context) => {
    const { errors } = lifecycleUpdateInput(view, values, true);
    for (const [path, message] of Object.entries(errors)) context.addIssue({ code: 'custom', path: [path], message });
  });
}
