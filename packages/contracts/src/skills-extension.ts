import { z } from 'zod';

/**
 * The "Skills over MCP" extension serves each file of a skill as a resource under a `skill://` URI and
 * describes every skill with an entry that pins each file to a digest and size. These are the runner's
 * wire shapes for that surface; the public JSON-RPC methods are owned by the API.
 */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** The extension's per-skill limits. A skill above either is not served rather than served partially. */
export const SKILLS_EXTENSION_MAX_FILES = 512;
export const SKILLS_EXTENSION_MAX_BYTES = 16 * 1024 * 1024;

/** The organisational prefix of every URI this harness serves; the tier keeps same-named skills apart. */
export const SKILLS_EXTENSION_URI_PREFIX = 'skill://cloud-harness/';
export const SkillExtensionTierSchema = z.enum(['built-in', 'owner']);
/** The final skill-path segment must equal `frontmatter.name`, so the name is also a URI segment. */
export const SKILLS_EXTENSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export const SKILLS_EXTENSION_LIST_MAX_LIMIT = 100;
export const SKILLS_EXTENSION_URI_MAX_LENGTH = 1_024;

const SkillUriSchema = z.string().min(1).max(SKILLS_EXTENSION_URI_MAX_LENGTH);

export const SkillResourceSchema = z.object({
  uri: SkillUriSchema,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
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

export const SkillsExtListInputSchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(SKILLS_EXTENSION_LIST_MAX_LIMIT).default(50)
}).strict();
export const SkillsExtGetInputSchema = z.object({ uri: SkillUriSchema }).strict();
export const SkillsExtReadInputSchema = z.object({ uri: SkillUriSchema }).strict();

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
