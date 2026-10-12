import { z } from 'zod';
import { RunnerPrincipalSelectorSchema } from './runner-api.js';
import { WorkspaceIdSchema } from './identifiers.js';

/**
 * Skills over MCP (SEP-2640). The wire shapes and limits live here so the API adapter, the runner
 * reader and the tests share one definition; the runner owns discovery, precedence and file bytes.
 */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILLS_URI_SCHEME = 'skill:';
export const SKILLS_RESOURCE_META_PREFIX = 'io.modelcontextprotocol.skills/';

/** Published per-skill baseline: 512 files and 16 MiB. A larger skill is excluded, never truncated. */
export const SKILL_RESOURCES_MAX_FILES = 512;
export const SKILL_RESOURCES_MAX_BYTES = 16 * 1024 * 1024;
/** Bounds one `resources/read` response; a skill with a larger file is excluded from the protocol. */
export const SKILL_RESOURCE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SKILLS_LIST_PAGE_SIZE = 50;
/** Freshness hints for clients; they are cache hints, never integrity guarantees. */
export const SKILLS_TTL_MS = 60_000;

/** The tiers the protocol serves. Workspace and repository skills stay on the tool surface. */
export const SKILL_PROTOCOL_TIERS = ['built-in', 'owner'] as const;
export type SkillProtocolTier = (typeof SKILL_PROTOCOL_TIERS)[number];

/** Agent Skills naming rule: lowercase alphanumerics with single interior hyphens, at most 64 characters. */
export const AGENT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const AGENT_SKILL_NAME_MAX = 64;
export const AGENT_SKILL_DESCRIPTION_MAX = 1024;

export function isValidAgentSkillName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= AGENT_SKILL_NAME_MAX && AGENT_SKILL_NAME_PATTERN.test(name);
}

const SKILL_FILE_SEGMENT = /^[^\\/\0]{1,255}$/;

export function isSafeSkillFilePath(path: string): boolean {
  if (path.length === 0 || path.length > 1_024) return false;
  return path.split('/').every((segment) => segment !== '.' && segment !== '..' && SKILL_FILE_SEGMENT.test(segment));
}

export function skillUri(tier: SkillProtocolTier, name: string, filePath = 'SKILL.md'): string {
  return `${SKILLS_URI_SCHEME}//${tier}/${name}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

export type ParsedSkillUri = { tier: SkillProtocolTier; name: string; filePath: string };

/** Returns undefined for anything that is not a well-formed, traversal-free `skill://<tier>/<name>/<path>` URI. */
export function parseSkillUri(uri: string): ParsedSkillUri | undefined {
  if (uri.length > 2_048 || !uri.startsWith(`${SKILLS_URI_SCHEME}//`)) return undefined;
  const rest = uri.slice(SKILLS_URI_SCHEME.length + 2);
  if (rest.includes('?') || rest.includes('#')) return undefined;
  const [tier, name, ...fileSegments] = rest.split('/');
  if (!tier || !name || fileSegments.length === 0) return undefined;
  if (!(SKILL_PROTOCOL_TIERS as readonly string[]).includes(tier) || !isValidAgentSkillName(name)) return undefined;
  let filePath: string;
  try {
    filePath = fileSegments.map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
  if (!isSafeSkillFilePath(filePath)) return undefined;
  return { tier: tier as SkillProtocolTier, name, filePath };
}

export const SkillDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const SkillFileEntrySchema = z.object({
  uri: z.string().max(2_048),
  digest: SkillDigestSchema,
  size: z.number().int().min(0).max(SKILL_RESOURCES_MAX_BYTES)
}).strict();

export const SkillEntrySchema = z.object({
  uri: z.string().max(2_048),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.array(SkillFileEntrySchema).min(1).max(SKILL_RESOURCES_MAX_FILES)
}).strict();

export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/** Runner-internal operations backing the protocol adapter. They are not part of the public tool catalog. */
export const SkillProtocolOperationSchema = z.enum(['skills_protocol_list', 'skills_protocol_get', 'skills_protocol_read']);
export type SkillProtocolOperation = z.infer<typeof SkillProtocolOperationSchema>;

const workspaceBinding = { workspaceId: WorkspaceIdSchema.optional() };

export const SkillProtocolRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    version: z.literal(2),
    principal: RunnerPrincipalSelectorSchema,
    operation: z.literal('skills_protocol_list'),
    input: z.object({ ...workspaceBinding, cursor: z.string().max(256).optional() }).strict()
  }).strict(),
  z.object({
    version: z.literal(2),
    principal: RunnerPrincipalSelectorSchema,
    operation: z.literal('skills_protocol_get'),
    input: z.object({ ...workspaceBinding, uri: z.string().max(2_048) }).strict()
  }).strict(),
  z.object({
    version: z.literal(2),
    principal: RunnerPrincipalSelectorSchema,
    operation: z.literal('skills_protocol_read'),
    input: z.object({ ...workspaceBinding, uri: z.string().max(2_048) }).strict()
  }).strict()
]);
export type SkillProtocolRequest = z.infer<typeof SkillProtocolRequestSchema>;
