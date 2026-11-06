/**
 * Global and environment secret references: types, the browser-side name and value checks,
 * the `.env` parser and the bulk-import plan. Values are write-only: no response carries
 * one, and nothing here stores or logs a value.
 */
export type SecretReference = {
  id: string;
  environmentId?: string | null;
  name: string;
  description: string | null;
  state?: string | null;
  version?: number | null;
  generation: number;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
};

export type SecretList = { secrets: SecretReference[]; readiness?: { ready: boolean; error?: string } };

/**
 * Browser mirror of the reserved-name policy in `packages/contracts/src/secret-policy.ts`
 * (as in the classic Dashboard), so a form can refuse a name before spending a request.
 * `GH_TOKEN` and `GITHUB_TOKEN` are deliberately allowed. `secret-model.test.ts` fails if
 * this list drifts from the contract.
 */
export const FORBIDDEN_CLIENT_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
  'AUTHORIZATION', 'OWNER_ID', 'RUNNER_TOKEN', 'SECRET_KEYRING',
  'SECRET_KEYRING_FILE', 'STATE_DB', 'JOBS_ROOT', 'DOCKER_HOST',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BUILTIN_SKILLS_ROOT'
]);
export const FORBIDDEN_CLIENT_PREFIXES: readonly string[] = [
  'HARNESS_', 'CH_', 'CLOUDFLARE_', 'CF_', 'GITHUB_APP_', 'ACCESS_', 'RUNNER_', 'DOCKER_',
  'XDG_', 'NPM_', 'NPM_CONFIG_', 'UV_', 'BUN_', 'PNPM_', 'GIT_', 'LD_'
];

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const SECRET_DESCRIPTION_MAX = 500;
const MIN_VALUE_BYTES = 4;
const MAX_VALUE_BYTES = 65_536;

export function secretNameError(name: string): string | undefined {
  if (!SECRET_NAME_PATTERN.test(name)) return 'Use a letter or underscore, then letters, digits or underscores (up to 100).';
  const upper = name.toUpperCase();
  if (FORBIDDEN_CLIENT_NAMES.has(upper)) return 'This name is reserved for the control plane or toolchain.';
  const prefix = FORBIDDEN_CLIENT_PREFIXES.find((candidate) => upper.startsWith(candidate));
  return prefix ? `Names starting with ${prefix} are reserved.` : undefined;
}

/** Byte-accurate like the server: 4 to 65,536 UTF-8 bytes, no NUL or line breaks. */
export function secretValueError(value: string): string | undefined {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < MIN_VALUE_BYTES) return 'Enter at least 4 characters.';
  if (bytes > MAX_VALUE_BYTES) return 'Keep the value to 64 KiB.';
  if (/[\0\r\n]/.test(value)) return 'The value cannot contain line breaks or NUL characters.';
  return undefined;
}

export type DotEnvItem = { name: string; value: string; description: string | null };

/** Parses `.env` text exactly as the classic Dashboard does (see its `parseDotEnv`). */
export function parseDotEnv(text: string): DotEnvItem[] {
  const items: DotEnvItem[] = [];
  let comments: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { comments = []; continue; }
    if (trimmed.startsWith('#')) { comments.push(trimmed.replace(/^#+\s*/, '')); continue; }
    const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const index = assignment.indexOf('=');
    if (index <= 0) continue;
    const name = assignment.slice(0, index).trim();
    let value = assignment.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    items.push({ name, value, description: comments.length ? comments.join(' / ').slice(0, SECRET_DESCRIPTION_MAX) : null });
    comments = [];
  }
  return items;
}

export type BulkPlanLine =
  | { kind: 'create'; name: string; description: string | null }
  | { kind: 'rotate'; name: string; description: string | null; fromVersion: number; toVersion: number }
  | { kind: 'rejected'; name: string; reason: string }
  | { kind: 'duplicate'; name: string };

export type BulkItem = { name: string; value: string; description?: string; action: 'create' | 'rotate'; expectedGeneration: number };

/**
 * The bulk-import preview and request. Existing names rotate with their current
 * generation; new names create with generation 0; an invalid or repeated name blocks the
 * whole batch. The preview lines carry names and descriptions only, never values.
 */
export function planBulkImport(text: string, existing: readonly SecretReference[]): { lines: BulkPlanLine[]; items: BulkItem[]; blocked: number } {
  const byName = new Map(existing.map((secret) => [secret.name, secret]));
  const seen = new Set<string>();
  const lines: BulkPlanLine[] = [];
  const items: BulkItem[] = [];
  let blocked = 0;
  for (const item of parseDotEnv(text)) {
    const reason = secretNameError(item.name) ?? secretValueError(item.value);
    if (reason) { lines.push({ kind: 'rejected', name: item.name, reason }); blocked += 1; continue; }
    if (seen.has(item.name)) { lines.push({ kind: 'duplicate', name: item.name }); blocked += 1; continue; }
    seen.add(item.name);
    const previous = byName.get(item.name);
    if (previous) {
      const version = previous.version ?? previous.generation;
      lines.push({ kind: 'rotate', name: item.name, description: item.description, fromVersion: version, toVersion: version + 1 });
    } else {
      lines.push({ kind: 'create', name: item.name, description: item.description });
    }
    items.push({
      name: item.name,
      value: item.value,
      ...(item.description ? { description: item.description } : {}),
      action: previous ? 'rotate' : 'create',
      expectedGeneration: previous ? Number(previous.generation) : 0
    });
  }
  return { lines, items, blocked };
}

/** `.env.example` text: each description line as a comment, then `NAME=` with no value. */
export function buildEnvExample(secrets: readonly SecretReference[]): string {
  const lines: string[] = [];
  for (const secret of secrets) {
    for (const line of (secret.description ?? '').split('\n')) if (line.trim()) lines.push(`# ${line.trim()}`);
    lines.push(`${secret.name}=`);
  }
  return `${lines.join('\n')}\n`;
}

export function envExampleFilename(scopeName: string | undefined): string {
  return scopeName ? `${scopeName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}.env.example` : 'global.env.example';
}
