import { z } from 'zod';
import { WorkspaceIdSchema } from './identifiers.js';

/**
 * The "Skills over MCP" extension serves each file of a skill as a resource under a `skill://` URI and
 * describes every skill with an entry that pins each file to a digest and size. These are the runner's
 * wire shapes for that surface; the public JSON-RPC methods are owned by the API.
 */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** The extension's per-skill limits. A skill above either is not served rather than served partially. */
export const SKILLS_EXTENSION_MAX_FILES = 512;
export const SKILLS_EXTENSION_MAX_BYTES = 16 * 1024 * 1024;
/** How many directory levels a skill may nest; a deeper skill is refused on upload and not served. */
export const SKILLS_EXTENSION_MAX_TREE_DEPTH = 32;

/**
 * The organisational prefix of every URI this harness serves; the tier keeps same-named skills apart.
 * Built-in and owner skills are `<prefix><tier>/<name>/<file>`. Workspace and repository skills are read
 * from one workspace's checkout, so their URIs also name it: `<prefix><tier>/<workspaceId>/<name>/<file>`.
 */
export const SKILLS_EXTENSION_URI_PREFIX = 'skill://cloud-harness/';
export const SkillExtensionTierSchema = z.enum(['built-in', 'owner', 'workspace', 'repository']);
/** The tiers served only to a request bound to one workspace, whose URIs carry that workspace's id. */
export const SKILLS_EXTENSION_WORKSPACE_TIERS = ['workspace', 'repository'] as const;
/** The final skill-path segment must equal `frontmatter.name`, so the name is also a URI segment. */
export const SKILLS_EXTENSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export const SKILLS_EXTENSION_LIST_MAX_LIMIT = 100;
export const SKILLS_EXTENSION_URI_MAX_LENGTH = 1_024;
/**
 * The serialized size one list page may reach. A page also stops at this many bytes, well below the
 * API's bound on a metadata response, so a page of large manifests is split rather than refused.
 */
export const SKILLS_EXTENSION_LIST_MAX_PAGE_BYTES = 8 * 1024 * 1024;

const SkillUriSchema = z.string().min(1).max(SKILLS_EXTENSION_URI_MAX_LENGTH);
const SkillDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const SkillResourceSchema = z.object({
  uri: SkillUriSchema,
  digest: SkillDigestSchema,
  size: z.number().int().min(0).max(SKILLS_EXTENSION_MAX_BYTES)
}).strict();

export const SkillEntrySchema = z.object({
  uri: SkillUriSchema,
  // The frontmatter is passed through verbatim, so only the two fields the format requires are typed.
  frontmatter: z.object({ name: z.string().min(1), description: z.string().min(1) }).loose(),
  resources: z.union([z.array(SkillResourceSchema).min(1).max(SKILLS_EXTENSION_MAX_FILES), z.literal('dynamic')])
}).strict();

export const SkillResourceContentSchema = z.object({
  uri: SkillUriSchema,
  mimeType: z.string().min(1),
  text: z.string().optional(),
  blob: z.string().optional()
}).strict().refine((value) => (value.text === undefined) !== (value.blob === undefined), 'exactly one of text or blob is required');

/**
 * `workspaceId` binds one request to one of the caller's workspaces: absent, only built-in and owner
 * skills are served; present, that workspace's workspace and repository skills are served as well, after
 * the runner re-checks on every call that the workspace is the caller's and still open.
 */
const WorkspaceBinding = { workspaceId: WorkspaceIdSchema.optional() };
export const SkillsExtListInputSchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(SKILLS_EXTENSION_LIST_MAX_LIMIT).default(50),
  ...WorkspaceBinding
}).strict();
export const SkillsExtGetInputSchema = z.object({ uri: SkillUriSchema, ...WorkspaceBinding }).strict();
/**
 * `expectedDigest` is runner-internal: a file whose digest differs is refused as stale. The public
 * `resources/read` method never forwards it, so it is not part of the client-facing contract.
 */
export const SkillsExtReadInputSchema = z.object({ uri: SkillUriSchema, expectedDigest: SkillDigestSchema.optional(), ...WorkspaceBinding }).strict();

/** `skills_ext_list` answers `{ skills }`; the response envelope's `cursor` carries the next page. */
export const SkillsExtListDataSchema = z.object({ skills: z.array(SkillEntrySchema) }).strict();
export const SkillsExtGetDataSchema = z.object({ skill: SkillEntrySchema }).strict();
export const SkillsExtReadDataSchema = z.object({ contents: z.array(SkillResourceContentSchema).length(1) }).strict();

export type SkillExtensionTier = z.infer<typeof SkillExtensionTierSchema>;
export type SkillResource = z.infer<typeof SkillResourceSchema>;
export type SkillEntry = z.infer<typeof SkillEntrySchema>;
export type SkillResourceContent = z.infer<typeof SkillResourceContentSchema>;
export type SkillsExtListData = z.infer<typeof SkillsExtListDataSchema>;
export type SkillsExtGetData = z.infer<typeof SkillsExtGetDataSchema>;
export type SkillsExtReadData = z.infer<typeof SkillsExtReadDataSchema>;
