import { z } from 'zod';
import { ExecutorNetworkProfileSchema } from './identifiers.js';

/**
 * How long an expired workspace stays recoverable before the reaper may close it. It was a fixed hour
 * before the policy became configurable, so a row written by an earlier release keeps that value.
 */
export const DEFAULT_RECOVERABLE_GRACE_SECONDS = 3_600;

/**
 * The ranges a Dashboard override may take. They are integer seconds; the Dashboard edits whole minutes.
 * The idle floor is a minute because the runner environment's 30-second floor exists only for backward
 * compatibility, and a grace of 0 is accepted only with an explicit acknowledgement.
 */
export const WORKSPACE_LIFECYCLE_BOUNDS = {
  maxActiveWorkspacesPerOwner: { min: 1, max: 64 },
  idleTtlSeconds: { min: 60, max: 43_200 },
  wallTtlSeconds: { min: 60, max: 86_400 },
  recoverableGraceSeconds: { min: 0, max: 86_400 }
} as const;

export type WorkspaceLifecycleSettingName = keyof typeof WORKSPACE_LIFECYCLE_BOUNDS;
export const WORKSPACE_LIFECYCLE_SETTING_NAMES = Object.keys(WORKSPACE_LIFECYCLE_BOUNDS) as WorkspaceLifecycleSettingName[];

const override = (name: WorkspaceLifecycleSettingName) => z.union([
  z.number().int().min(WORKSPACE_LIFECYCLE_BOUNDS[name].min).max(WORKSPACE_LIFECYCLE_BOUNDS[name].max),
  z.null()
]).optional();

/**
 * One field-scoped lifecycle change. An omitted field is left as it is and `null` clears the override so
 * the runner configuration applies again. `expectedRevision` is the revision the operator loaded, so two
 * concurrent saves cannot silently overwrite each other.
 */
export const WorkspaceLifecycleSettingsUpdateSchema = z.object({
  expectedRevision: z.number().int().min(0),
  maxActiveWorkspacesPerOwner: override('maxActiveWorkspacesPerOwner'),
  idleTtlSeconds: override('idleTtlSeconds'),
  wallTtlSeconds: override('wallTtlSeconds'),
  recoverableGraceSeconds: override('recoverableGraceSeconds'),
  acknowledgeImmediateClose: z.literal(true).optional()
}).strict().superRefine((value, context) => {
  if (WORKSPACE_LIFECYCLE_SETTING_NAMES.every((name) => value[name] === undefined)) {
    context.addIssue({ code: 'custom', message: 'at least one workspace lifecycle setting is required' });
  }
  if (value.recoverableGraceSeconds === 0 && value.acknowledgeImmediateClose !== true) {
    context.addIssue({
      code: 'custom',
      path: ['acknowledgeImmediateClose'],
      message: 'a recoverable grace of 0 closes clean expired workspaces on the next reaper pass and must be acknowledged'
    });
  }
});
export type WorkspaceLifecycleSettingsUpdate = z.infer<typeof WorkspaceLifecycleSettingsUpdateSchema>;

/** The instance settings write shared by the Dashboard BFF and the internal runner operation. */
export const InstanceSettingsUpdateInputSchema = z.object({
  defaultNetworkProfile: z.union([ExecutorNetworkProfileSchema, z.null()]).optional(),
  workspaceLifecycle: WorkspaceLifecycleSettingsUpdateSchema.optional()
}).strict().refine(
  (value) => value.defaultNetworkProfile !== undefined || value.workspaceLifecycle !== undefined,
  'at least one setting is required'
);
export type InstanceSettingsUpdateInput = z.infer<typeof InstanceSettingsUpdateInputSchema>;

/** Where an effective value came from: a Dashboard override, the runner environment, or the built-in default. */
export type WorkspaceLifecycleSettingSource = 'setting' | 'environment' | 'default';

export type WorkspaceLifecycleSettingView = {
  value: number;
  source: WorkspaceLifecycleSettingSource;
  /** The value that applies when the override is reset. */
  runnerValue: number;
  min: number;
  max: number;
};

export type WorkspaceLifecycleSettingsView = {
  revision: number;
  updatedAt: string | null;
  settings: Record<WorkspaceLifecycleSettingName, WorkspaceLifecycleSettingView>;
  reaperIntervalSeconds: number;
  /** The requesting principal's own usage, because the quota is per principal. */
  usage: { counted: number; limit: number; recoverable: number; autoCloseDeferred: number };
  /** Per-executor ceilings, not reservations: they multiply with concurrent workspaces. */
  executorCeilings: { memoryBytes: number; cpus: number; pids: number };
};
