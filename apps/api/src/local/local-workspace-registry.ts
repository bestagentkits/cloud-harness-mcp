import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Operator-owned registry of persistent local workspace roots. The file is the only way to
 * register a root: no MCP operation can add, move, or rename one, so clients can never point
 * host execution at an arbitrary path.
 */
const AliasSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'workspace names use lowercase letters, digits, ".", "_" or "-" (max 63)');

const WorkspaceEntrySchema = z.object({
  path: z.string().min(1).refine(isAbsolute, 'workspace path must be absolute'),
  gitNetwork: z.boolean().optional(),
  gitPush: z.boolean().optional()
}).strict();

const HttpSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(3100),
  publicHosts: z.array(z.string().min(1)).default([]),
  allowedOrigins: z.array(z.string().url()).default([])
}).strict();

const WorkspaceConfigSchema = z.object({
  version: z.literal(1),
  http: HttpSchema.optional(),
  workspaces: z.record(AliasSchema, WorkspaceEntrySchema).refine((value) => Object.keys(value).length > 0, 'at least one workspace is required')
}).strict();

export type LocalHttpSettings = z.infer<typeof HttpSchema>;

/** Device and inode of a root at registration; a remount or replaced directory changes them. */
export type RootIdentity = { dev: number; ino: number };

export type RegisteredLocalWorkspace = {
  name: string;
  workspaceId: string;
  configuredPath: string;
  canonicalRoot: string;
  identity: RootIdentity;
  gitNetwork?: boolean;
  gitPush?: boolean;
};

export type LocalWorkspaceRegistry = {
  workspaces: RegisteredLocalWorkspace[];
  http: LocalHttpSettings;
};

/**
 * Derives a stable identifier from the name and canonical root, so a restart keeps the ID while a
 * root that moves to a different directory gets a new one and stale IDs fail closed.
 */
export function stableLocalWorkspaceId(name: string, canonicalRoot: string): string {
  const digest = createHash('sha256').update(`cloud-harness-local-workspace\0${name}\0${canonicalRoot}`).digest('base64url');
  return `ws_local_${digest.slice(0, 32)}`;
}

function isSameOrNested(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function readRootIdentity(path: string): Promise<RootIdentity & { canonicalRoot: string }> {
  const stats = await stat(path);
  if (!stats.isDirectory()) throw new Error('not a directory');
  return { canonicalRoot: await realpath(path), dev: stats.dev, ino: stats.ino };
}

export function parseLocalWorkspaceConfig(source: string): z.infer<typeof WorkspaceConfigSchema> {
  // YAML 1.2 is a JSON superset, so one parser accepts either format. Duplicate keys are rejected.
  const raw: unknown = parseYaml(source, { uniqueKeys: true, maxAliasCount: 0 });
  const parsed = WorkspaceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const at = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`invalid workspace config${at}: ${issue.message}`);
  }
  return parsed.data;
}

export async function loadLocalWorkspaceRegistry(configPath: string): Promise<LocalWorkspaceRegistry> {
  const config = parseLocalWorkspaceConfig(await readFile(configPath, 'utf8'));
  const workspaces: RegisteredLocalWorkspace[] = [];
  for (const [name, entry] of Object.entries(config.workspaces)) {
    let resolved: Awaited<ReturnType<typeof readRootIdentity>>;
    try {
      resolved = await readRootIdentity(entry.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`workspace "${name}" path "${entry.path}" is unavailable: ${reason}`);
    }
    for (const other of workspaces) {
      if (isSameOrNested(other.canonicalRoot, resolved.canonicalRoot) || isSameOrNested(resolved.canonicalRoot, other.canonicalRoot)) {
        throw new Error(`workspace "${name}" root overlaps workspace "${other.name}" (${resolved.canonicalRoot} and ${other.canonicalRoot})`);
      }
    }
    workspaces.push({
      name,
      workspaceId: stableLocalWorkspaceId(name, resolved.canonicalRoot),
      configuredPath: entry.path,
      canonicalRoot: resolved.canonicalRoot,
      identity: { dev: resolved.dev, ino: resolved.ino },
      ...(entry.gitNetwork !== undefined ? { gitNetwork: entry.gitNetwork } : {}),
      ...(entry.gitPush !== undefined ? { gitPush: entry.gitPush } : {})
    });
  }
  return { workspaces, http: config.http ?? HttpSchema.parse({}) };
}
