import { z } from 'zod';

/**
 * GitHub credential names an operator may inject as a `runtime` secret.
 *
 * These names are deliberately *not* reserved. A workspace secret with one of
 * these names is both injected into the executor environment (so the bundled
 * `gh` CLI authenticates without a login step) and usable by the runner as a
 * principal-scoped fallback credential when no GitHub App repository token is
 * available. Keep them out of both `FORBIDDEN_SECRET_NAMES` and
 * `FORBIDDEN_SECRET_PREFIXES`: a reserved entry or prefix that matches one of
 * these names would silently re-block the documented workspace `gh` path.
 * Every other control-plane, GitHub App, and toolchain name stays reserved.
 * See `docs/security-model.md` for the boundary this opens.
 */
export const GITHUB_CREDENTIAL_SECRET_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export const FORBIDDEN_SECRET_NAMES: Record<string, true> = {
  PATH: true,
  HOME: true,
  SHELL: true,
  USER: true,
  LOGNAME: true,
  GIT_CONFIG_NOSYSTEM: true,
  GIT_TERMINAL_PROMPT: true,
  AUTHORIZATION: true,
  OWNER_ID: true,
  RUNNER_TOKEN: true,
  SECRET_KEYRING: true,
  SECRET_KEYRING_FILE: true,
  STATE_DB: true,
  JOBS_ROOT: true,
  DOCKER_HOST: true,
  LD_PRELOAD: true,
  LD_LIBRARY_PATH: true,
  // Selects the trusted `built-in` skills tier. Reserved so a workspace environment can never
  // shadow the operator's catalog, now that the worker reads this single name.
  BUILTIN_SKILLS_ROOT: true
};

export const FORBIDDEN_SECRET_PREFIXES = [
  'HARNESS_',
  'CH_',
  'CLOUDFLARE_',
  'CF_',
  'GITHUB_APP_',
  'ACCESS_',
  'RUNNER_',
  'DOCKER_',
  'XDG_',
  'NPM_',
  'NPM_CONFIG_',
  'UV_',
  'BUN_',
  'PNPM_',
  'GIT_',
  'LD_'
] as const;

export const SECRET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const MIN_SECRET_VALUE_BYTES = 4;
export const MAX_SECRET_VALUE_BYTES = 65_536;
export const MAX_SECRET_DESCRIPTION_CHARS = 500;

export function validateSecretName(rawName: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof rawName !== 'string') {
    return { ok: false, error: 'secret name must be a string' };
  }
  const name = rawName.trim();
  if (!SECRET_NAME_REGEX.test(name)) {
    return { ok: false, error: 'secret name must be 1-100 characters and contain only letters, numbers, and underscores (starting with letter or underscore)' };
  }
  const upper = name.toUpperCase();
  if (FORBIDDEN_SECRET_NAMES[upper]) {
    return { ok: false, error: `secret name ${name} is reserved for the control plane or system toolchains` };
  }
  for (const prefix of FORBIDDEN_SECRET_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return { ok: false, error: `secret name ${name} uses reserved prefix ${prefix}` };
    }
  }
  return { ok: true, name };
}

/**
 * Shape-only variant for operations that only read or DELETE an existing record. Reserving a name
 * stops a value from being injected into an executor; it must not stop an operator from removing a
 * record whose name became reserved after it was stored.
 */
export function validateSecretNameShape(rawName: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof rawName !== 'string') {
    return { ok: false, error: 'secret name must be a string' };
  }
  const name = rawName.trim();
  if (!SECRET_NAME_REGEX.test(name)) {
    return { ok: false, error: 'secret name must be 1-100 characters and contain only letters, numbers, and underscores (starting with letter or underscore)' };
  }
  return { ok: true, name };
}

export function validateSecretValue(rawValue: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof rawValue !== 'string') {
    return { ok: false, error: 'secret value must be a string' };
  }
  if (rawValue.includes('\0') || rawValue.includes('\n') || rawValue.includes('\r')) {
    return { ok: false, error: 'secret value must not contain null or newline characters' };
  }
  const byteLength = Buffer.byteLength(rawValue, 'utf8');
  if (byteLength < MIN_SECRET_VALUE_BYTES) {
    return { ok: false, error: `secret value must be at least ${MIN_SECRET_VALUE_BYTES} bytes to ensure reliable output redaction` };
  }
  if (byteLength > MAX_SECRET_VALUE_BYTES) {
    return { ok: false, error: `secret value must not exceed ${MAX_SECRET_VALUE_BYTES} bytes` };
  }
  return { ok: true, value: rawValue };
}

export function validateSecretDescription(rawDesc: unknown): { ok: true; description: string | null } | { ok: false; error: string } {
  if (rawDesc === undefined || rawDesc === null || rawDesc === '') {
    return { ok: true, description: null };
  }
  if (typeof rawDesc !== 'string') {
    return { ok: false, error: 'secret description must be a string' };
  }
  const trimmed = rawDesc.trim();
  if (trimmed.length === 0) {
    return { ok: true, description: null };
  }
  if (trimmed.length > MAX_SECRET_DESCRIPTION_CHARS) {
    return { ok: false, error: `secret description must not exceed ${MAX_SECRET_DESCRIPTION_CHARS} characters` };
  }
  if (trimmed.includes('\0')) {
    return { ok: false, error: 'secret description must not contain null bytes' };
  }
  return { ok: true, description: trimmed };
}

export const SecretNameSchema = z.string().superRefine((val, ctx) => {
  const result = validateSecretName(val);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.error });
  }
});

/** Shape-only name schema for delete requests, so a record whose name became reserved can still be removed. */
export const SecretNameShapeSchema = z.string().superRefine((val, ctx) => {
  const result = validateSecretNameShape(val);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.error });
  }
});

export const SecretValueSchema = z.string().superRefine((val, ctx) => {
  const result = validateSecretValue(val);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.error });
  }
});

export const SecretDescriptionSchema = z.string().nullable().optional().superRefine((val, ctx) => {
  if (val === undefined || val === null) return;
  const result = validateSecretDescription(val);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.error });
  }
}).transform((val) => {
  if (val === undefined || val === null) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
});

export const SecretPurposeSchema = z.enum(['runtime', 'provisioning']).default('runtime');
export type SecretPurpose = z.infer<typeof SecretPurposeSchema>;
