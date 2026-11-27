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

/**
 * Any GitHub account login (user or organization): 1-39 letters, digits, hyphens, or underscores, starting and
 * ending with a letter or digit. Enterprise Managed User logins carry an underscore (`developer_company`).
 */
export const GitHubAccountLoginSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?$/, 'owner must be a GitHub account login (1-39 letters, digits, hyphens, or underscores)');

export const GitHubRepositoriesListInputSchema = z.object({
  owner: GitHubAccountLoginSchema.optional().describe('Only repositories owned by this user or organization (case-insensitive).'),
  query: z.string().min(1).max(100).optional().describe('Case-insensitive substring matched against owner/name.'),
  refresh: z.boolean().default(false).describe('Bypass the short per-principal cache and read GitHub again.'),
  cursor: z.string().regex(/^(?:0|[1-9]\d{0,5})$/, 'invalid repository list cursor').optional(),
  limit: z.number().int().min(1).max(500).default(200)
}).strict();

/** Which credential lane reaches a listed repository, in the order the runner tries them. */
export const GitHubRepositoryAccessLaneSchema = z.enum(['installation', 'user']);

export const GitHubListedRepositorySchema = z.object({
  fullName: z.string().min(3).max(140),
  owner: z.string().min(1).max(39),
  name: z.string().min(1).max(100),
  /** Credential-free clone URL accepted by workspace_open: exactly `https://github.com/<owner>/<name>.git`. */
  repositoryUrl: z.string().max(200).regex(/^https:\/\/github\.com\/[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9._-]{1,100}\.git$/, 'repositoryUrl must be a credential-free github.com clone URL'),
  /**
   * The credential permission the listing saw, capped at the connected GitHub user's own permission:
   * `write` is what git_push needs, not a guarantee (branch protection still applies). A repository the
   * user's listing reports as archived is `read`; installation grants alone do not say whether it is.
   */
  access: z.enum(['read', 'write']),
  via: GitHubRepositoryAccessLaneSchema,
  /** Known when the connected GitHub user's listing reported it. */
  private: z.boolean().optional(),
  archived: z.boolean().optional(),
  defaultBranch: z.string().min(1).max(255).optional()
}).strict();

export const GitHubListedAccountSchema = z.object({
  login: z.string().min(1).max(39),
  type: z.enum(['Organization', 'User']).nullable(),
  via: GitHubRepositoryAccessLaneSchema,
  installationId: z.string().min(1).max(100),
  repositoryCount: z.number().int().min(0),
  /** False when GitHub could not be read for this account now: stored grants or partial pages stand in. */
  live: z.boolean()
}).strict();

/**
 * An account the connected GitHub user belongs to (the personal account and public organization
 * memberships) where no installation of this App reachable by that user exists. `installed`: the principal
 * has a binding there, so the App is installed but this user cannot access any of its repositories (ask an
 * owner for access). `unknown`: the App may not be installed (installUrl, when the slug is known).
 */
export const GitHubUnreachableAccountSchema = z.object({
  login: z.string().min(1).max(39),
  type: z.enum(['Organization', 'User']),
  installation: z.enum(['installed', 'unknown']),
  installUrl: z.string().max(200).regex(/^https:\/\/github\.com\/apps\/[A-Za-z0-9-]{1,100}\/installations\/new$/, 'installUrl must be a github.com App installation URL').optional()
}).strict();

/** Most repositories one principal's listing holds; past it the listing reports itself incomplete. */
export const GITHUB_REPOSITORY_LISTING_MAX = 10_000;

/** The whole listing of one principal before filters and paging; the dashboard reads it whole. */
export const GitHubRepositoryListingSchema = z.object({
  repositories: z.array(GitHubListedRepositorySchema).max(GITHUB_REPOSITORY_LISTING_MAX),
  accounts: z.array(GitHubListedAccountSchema).max(1_000),
  unreachableAccounts: z.array(GitHubUnreachableAccountSchema).max(1_000),
  /** The principal's GitHub user authorization as the user lane saw it. */
  userAuthorization: z.enum(['connected', 'revoked', 'disconnected', 'not_connected', 'not_applicable', 'unavailable']),
  /** When the listing was read (ISO 8601); a cached answer keeps its original time. */
  listedAt: z.string().max(40),
  /** False when installation grants came from the store without a refresh from GitHub. */
  synced: z.boolean(),
  /** True when a bound or a failure left reachable repositories out. */
  incomplete: z.boolean(),
  warnings: z.array(z.string().max(500)).max(20)
}).strict();

export const GitHubRepositoriesListResultSchema = GitHubRepositoryListingSchema.extend({
  repositories: z.array(GitHubListedRepositorySchema).max(500),
  /** Repositories matching the filters before paging. */
  totalCount: z.number().int().min(0)
}).strict();

export type GitHubRepositoriesListInput = z.infer<typeof GitHubRepositoriesListInputSchema>;
export type GitHubListedRepository = z.infer<typeof GitHubListedRepositorySchema>;
export type GitHubListedAccount = z.infer<typeof GitHubListedAccountSchema>;
export type GitHubUnreachableAccount = z.infer<typeof GitHubUnreachableAccountSchema>;
export type GitHubRepositoryListing = z.infer<typeof GitHubRepositoryListingSchema>;
export type GitHubRepositoriesListResult = z.infer<typeof GitHubRepositoriesListResultSchema>;
