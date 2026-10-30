import { z } from 'zod';
import { IdempotencyKeySchema } from './identifiers.js';

/**
 * Organization login: 1-39 characters, alphanumeric or single hyphens, not starting or ending
 * with a hyphen. GitHub refuses consecutive hyphens in new account names.
 */
export const GitHubOrganizationLoginSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'owner must be a GitHub organization login (1-39 letters, digits, or single hyphens)')
  .refine((value) => !value.includes('--'), 'owner cannot contain consecutive hyphens');

/**
 * Repository name as GitHub stores it. GitHub silently rewrites other characters to `-`; the
 * harness refuses them instead, so `fullName` in the result is exactly what the caller asked for.
 */
export const GitHubRepositoryNameSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'name may contain only letters, digits, ".", "_", and "-"')
  .refine((value) => value !== '.' && value !== '..', 'name cannot be "." or ".."')
  .refine((value) => !value.toLowerCase().endsWith('.git'), 'name cannot end with ".git"');

const singleLineText = (max: number, label: string) => z.string().max(max)
  .refine((value) => !/[\0\r\n]/.test(value), `${label} cannot contain null bytes or line breaks`);

/** A .gitignore template name from GitHub's catalog, such as `Node` or `C++`. */
const gitignoreTemplate = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,99}$/, 'gitignoreTemplate must be a GitHub .gitignore template name such as Node');
/** An SPDX-style license key from GitHub's catalog, such as `mit` or `apache-2.0`. */
const licenseTemplate = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/, 'licenseTemplate must be a GitHub license key such as mit or apache-2.0');

export const GitHubRepositoryVisibilitySchema = z.enum(['public', 'private']);

export const GitHubRepositoryCreateInputSchema = z.object({
  owner: GitHubOrganizationLoginSchema.describe('Organization that will own the repository. Personal accounts are not supported.'),
  name: GitHubRepositoryNameSchema.describe('Repository name; GitHub naming rules apply and other characters are refused, not rewritten.'),
  visibility: GitHubRepositoryVisibilitySchema.describe('Required, no default: "public" or "private".'),
  description: singleLineText(350, 'description').optional(),
  autoInit: z.boolean().optional().describe('Create an initial commit with an empty README. Omitted means an empty repository, unless a template is requested.'),
  gitignoreTemplate: gitignoreTemplate.optional(),
  licenseTemplate: licenseTemplate.optional(),
  idempotencyKey: IdempotencyKeySchema.describe('Required. Replaying the same key with the same input returns the recorded result without a second GitHub call.')
}).strict().superRefine((input, ctx) => {
  // Templates are committed in an initial commit, so they contradict an explicit empty repository.
  if (input.autoInit === false && (input.gitignoreTemplate !== undefined || input.licenseTemplate !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'gitignoreTemplate and licenseTemplate create an initial commit; omit autoInit or set it to true' });
  }
});

export const GitHubRepositoryCreateResultSchema = z.object({
  fullName: z.string().min(3).max(140),
  repositoryId: z.number().int().positive(),
  htmlUrl: z.url(),
  visibility: GitHubRepositoryVisibilitySchema,
  defaultBranch: z.string().min(1).max(255),
  /** True for the call that created the repository; false when an exact idempotency replay returned it. */
  created: z.boolean(),
  replayed: z.boolean()
}).strict();

/** One organization the principal could target, as last verified by the runner. */
export const GitHubRepositoryCreateOrganizationSchema = z.object({
  login: z.string().min(1).max(39),
  /** Installation permission `administration` as last verified; null when not yet verified. */
  administration: z.enum(['none', 'read', 'write']).nullable(),
  available: z.boolean(),
  reason: z.string().max(300).optional()
}).strict();

/**
 * Principal-level availability of github_repository_create, reported by workspace_capabilities.
 * It is computed from verified installation records without minting a token; the create call
 * re-verifies the installation live and stays the authority.
 */
export const GitHubRepositoryCreateCapabilitySchema = z.object({
  tool: z.literal('github_repository_create'),
  available: z.boolean(),
  organizations: z.array(GitHubRepositoryCreateOrganizationSchema).max(100),
  personalAccounts: z.literal(false),
  requiredPermission: z.literal('administration:write'),
  reason: z.string().max(300).optional()
}).strict();

export type GitHubRepositoryCreateInput = z.infer<typeof GitHubRepositoryCreateInputSchema>;
export type GitHubRepositoryCreateResult = z.infer<typeof GitHubRepositoryCreateResultSchema>;
export type GitHubRepositoryCreateCapability = z.infer<typeof GitHubRepositoryCreateCapabilitySchema>;
export type GitHubRepositoryCreateOrganization = z.infer<typeof GitHubRepositoryCreateOrganizationSchema>;
