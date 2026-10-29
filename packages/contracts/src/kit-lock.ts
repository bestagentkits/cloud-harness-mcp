import { z } from 'zod';

/**
 * Lockfiles a caller may hand to `workspace_open` so the workspace installs the same kit skills a
 * machine already has. The documents are owned by AgentKit (`agentkit.skill-lock/v1`) and SkillX
 * (`skillx.personal-kit-lock/v1`); only the fields the harness reads are validated here. Their specs
 * require readers to ignore unknown optional fields, so the objects stay loose.
 */
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256:<64 lowercase hex> digest');
const identity = z.string().min(1).max(200).refine((value) => !value.includes('\0'), 'identity cannot contain null bytes');
const lockedVersion = z.string().min(1).max(80);
const skillAlias = z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/, 'invalid skill alias');

export const AgentKitSkillLockSourceSchema = z.looseObject({
  owner: z.string().min(1).max(200),
  provider: z.string().min(1).max(40),
  kit: z.string().min(1).max(80).optional(),
  kitVersion: lockedVersion.optional(),
  origin: z.string().min(1).max(40).optional()
});

export const AgentKitSkillLockPackageSchema = z.looseObject({
  identity,
  version: lockedVersion,
  treeDigest: digest,
  aliases: z.array(skillAlias).max(16).optional(),
  sources: z.array(AgentKitSkillLockSourceSchema).min(1).max(16)
});

export const AgentKitSkillLockSchema = z.looseObject({
  schema: z.literal('agentkit.skill-lock/v1'),
  scope: z.enum(['global', 'project']),
  generation: z.number().int().min(0),
  packages: z.array(AgentKitSkillLockPackageSchema).max(512)
});

export const SkillXPersonalKitLockEntrySchema = z.looseObject({
  identity,
  alias: skillAlias.nullable().optional(),
  mode: z.string().min(1).max(40),
  package: identity,
  version: lockedVersion,
  releaseDigest: digest,
  overlayDigests: z.array(digest).max(64),
  compositionDigest: digest
});

export const SkillXPersonalKitLockSchema = z.looseObject({
  schema: z.literal('skillx.personal-kit-lock/v1'),
  resolver: z.string().min(1).max(80),
  kit: identity,
  revisionDigest: digest,
  entries: z.array(SkillXPersonalKitLockEntrySchema).max(512)
});

export const KitLockSchema = z.discriminatedUnion('schema', [AgentKitSkillLockSchema, SkillXPersonalKitLockSchema]);

export type AgentKitSkillLock = z.infer<typeof AgentKitSkillLockSchema>;
export type SkillXPersonalKitLock = z.infer<typeof SkillXPersonalKitLockSchema>;
export type KitLock = z.infer<typeof KitLockSchema>;
