import { z } from 'zod';
import { WorkspaceIdSchema } from './identifiers.js';

/**
 * Managed toolbox packages: owner- or workspace-scoped CLI tools built into immutable, verified releases.
 *
 * Every user-supplied value here later travels into a builder container as a positional argument, so the
 * schemas refuse anything that could be read as a URL, git, file, or marker spec, or as an option flag.
 * `apt` is accepted only so the runner can answer `NOT_SUPPORTED` with the image-variant guidance; the
 * single-owner `instance` scope is refused because the owner scope already covers it.
 */
export const PACKAGE_ECOSYSTEMS = ['npm', 'uv', 'apt'] as const;
export const PackageEcosystemSchema = z.enum(PACKAGE_ECOSYSTEMS);
export type PackageEcosystem = z.infer<typeof PackageEcosystemSchema>;

/** Ecosystems the runner can actually build. */
export const BUILDABLE_PACKAGE_ECOSYSTEMS = ['npm', 'uv'] as const;
export const BuildablePackageEcosystemSchema = z.enum(BUILDABLE_PACKAGE_ECOSYSTEMS);
export type BuildablePackageEcosystem = z.infer<typeof BuildablePackageEcosystemSchema>;

export const PackageScopeSchema = z.enum(['owner', 'workspace']);
export type PackageScope = z.infer<typeof PackageScopeSchema>;

export const NPM_PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const NPM_PACKAGE_NAME_MAX_LENGTH = 214;
export const UV_PACKAGE_NAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const UV_PACKAGE_NAME_MAX_LENGTH = 128;
/** Debian package names; only checked so an `apt` request is well-formed before NOT_SUPPORTED. */
export const APT_PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]{1,127}$/;
export const PACKAGE_BINARY_NAME_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
export const PACKAGE_VERSION_SPEC_MAX_LENGTH = 128;
/** Characters an npm range/tag or a PEP 440 specifier needs; `:`, `/`, `@`, and `;` are deliberately absent. */
const VERSION_SPEC_CHARACTERS = /^[A-Za-z0-9.*+^~<>=!|,_ -]+$/;
export const PACKAGE_PYTHON_VERSION_PATTERN = /^3\.\d{1,2}(\.\d{1,2})?$/;
export const PACKAGE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const PACKAGES_STATUS_MAX_WAIT_MS = 30_000;

const packageId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,80}$`), `invalid ${prefix} identifier`);
export const PackagePlanIdSchema = packageId('pkp');
export const PackageApplyIdSchema = packageId('pka');
export const PackageBindingIdSchema = packageId('pkb');
export const PackageReleaseIdSchema = packageId('pkr');
export const PackageDigestSchema = z.string().regex(PACKAGE_DIGEST_PATTERN, 'digest must be 64 lowercase hexadecimal characters');
export const PackageBinaryNameSchema = z.string().regex(PACKAGE_BINARY_NAME_PATTERN, 'invalid binary name');

/** Returns why `name` is not a valid package name for `ecosystem`, or undefined when it is. */
export function packageNameIssue(ecosystem: PackageEcosystem, name: string): string | undefined {
  if (ecosystem === 'npm') {
    if (name.length > NPM_PACKAGE_NAME_MAX_LENGTH || !NPM_PACKAGE_NAME_PATTERN.test(name)) return 'invalid npm package name';
    return undefined;
  }
  if (ecosystem === 'uv') {
    if (name.length > UV_PACKAGE_NAME_MAX_LENGTH || !UV_PACKAGE_NAME_PATTERN.test(name)) return 'invalid Python distribution name';
    return undefined;
  }
  return APT_PACKAGE_NAME_PATTERN.test(name) ? undefined : 'invalid apt package name';
}

/** Returns why `spec` is not an acceptable version spec, or undefined when it is. */
export function packageVersionSpecIssue(spec: string): string | undefined {
  if (spec.trim().length === 0) return 'version must not be blank';
  if (spec.length > PACKAGE_VERSION_SPEC_MAX_LENGTH) return `version must be at most ${PACKAGE_VERSION_SPEC_MAX_LENGTH} characters`;
  if (spec.trimStart().startsWith('-')) return 'version must not start with "-"';
  if (/[:/@;]/.test(spec)) return 'URL, git, file, alias, and marker version specs are not supported';
  if (!VERSION_SPEC_CHARACTERS.test(spec)) return 'version contains unsupported characters';
  return undefined;
}

const PackageNameFieldSchema = z.string().min(1).max(NPM_PACKAGE_NAME_MAX_LENGTH);
const PackageVersionFieldSchema = z.string().min(1).max(PACKAGE_VERSION_SPEC_MAX_LENGTH);

function requireWorkspaceForScope(
  input: { scope?: PackageScope | undefined; workspaceId?: string | undefined },
  context: z.RefinementCtx,
  scopeRequired: boolean
): void {
  const scope = input.scope ?? (scopeRequired ? 'owner' : undefined);
  if (scope === 'workspace' && input.workspaceId === undefined) {
    context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'workspaceId is required when scope is "workspace"' });
  }
  if (scope === 'owner' && input.workspaceId !== undefined) {
    context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'workspaceId is only allowed when scope is "workspace"' });
  }
}

export const PackagesPlanInputSchema = z.object({
  ecosystem: PackageEcosystemSchema,
  name: PackageNameFieldSchema,
  version: PackageVersionFieldSchema.optional(),
  scope: PackageScopeSchema.default('owner'),
  workspaceId: WorkspaceIdSchema.optional(),
  python: z.string().regex(PACKAGE_PYTHON_VERSION_PATTERN, 'python must look like 3.12 or 3.12.4').optional(),
  lifecycleScripts: z.boolean().optional()
}).strict().superRefine((input, context) => {
  const nameIssue = packageNameIssue(input.ecosystem, input.name);
  if (nameIssue) context.addIssue({ code: 'custom', path: ['name'], message: nameIssue });
  if (input.version !== undefined) {
    const versionIssue = packageVersionSpecIssue(input.version);
    if (versionIssue) context.addIssue({ code: 'custom', path: ['version'], message: versionIssue });
  }
  requireWorkspaceForScope(input, context, true);
  if (input.python !== undefined && input.ecosystem !== 'uv') {
    context.addIssue({ code: 'custom', path: ['python'], message: 'python is only allowed for the uv ecosystem' });
  }
  if (input.lifecycleScripts !== undefined && input.ecosystem !== 'npm') {
    context.addIssue({ code: 'custom', path: ['lifecycleScripts'], message: 'lifecycleScripts is only allowed for the npm ecosystem' });
  }
});
export type PackagesPlanInput = z.infer<typeof PackagesPlanInputSchema>;

export const PackagesApplyInputSchema = z.object({
  planId: PackagePlanIdSchema,
  planDigest: PackageDigestSchema
}).strict();
export type PackagesApplyInput = z.infer<typeof PackagesApplyInputSchema>;

export const PackagesListInputSchema = z.object({
  scope: PackageScopeSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
  includeHistory: z.boolean().default(false)
}).strict().superRefine((input, context) => requireWorkspaceForScope(input, context, false));
export type PackagesListInput = z.infer<typeof PackagesListInputSchema>;

export const PackagesStatusInputSchema = z.object({
  applyId: PackageApplyIdSchema.optional(),
  waitMs: z.number().int().min(0).max(PACKAGES_STATUS_MAX_WAIT_MS).default(0)
}).strict().superRefine((input, context) => {
  if (input.waitMs > 0 && input.applyId === undefined) {
    context.addIssue({ code: 'custom', path: ['waitMs'], message: 'waitMs requires applyId' });
  }
});
export type PackagesStatusInput = z.infer<typeof PackagesStatusInputSchema>;

export const PackagesRollbackInputSchema = z.object({
  bindingId: PackageBindingIdSchema,
  releaseId: PackageReleaseIdSchema,
  expectedGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();
export type PackagesRollbackInput = z.infer<typeof PackagesRollbackInputSchema>;

/** Dashboard (BFF to runner) inputs. Approval is bound to the digest the operator was shown. */
export const PackageOverviewInputSchema = z.object({}).strict();
export const PackagePlanListInputSchema = z.object({}).strict();
export const PackagePlanApproveInputSchema = z.object({
  planId: PackagePlanIdSchema,
  planDigest: PackageDigestSchema
}).strict();
export type PackagePlanApproveInput = z.infer<typeof PackagePlanApproveInputSchema>;
export const PackagePlanRejectInputSchema = z.object({ planId: PackagePlanIdSchema }).strict();
export type PackagePlanRejectInput = z.infer<typeof PackagePlanRejectInputSchema>;
export const PackageRollbackInputSchema = PackagesRollbackInputSchema;
export type PackageRollbackInput = PackagesRollbackInput;

/* Result views. */

export const PackagePlanStatusSchema = z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED']);
export type PackagePlanStatus = z.infer<typeof PackagePlanStatusSchema>;
export const PackageApplyStateSchema = z.enum(['QUEUED', 'BUILDING', 'VERIFYING', 'PUBLISHING', 'SUCCEEDED', 'FAILED']);
export type PackageApplyState = z.infer<typeof PackageApplyStateSchema>;
export const PackageReleaseStatusSchema = z.enum(['VERIFIED', 'MISSING', 'COLLECTED']);
export type PackageReleaseStatus = z.infer<typeof PackageReleaseStatusSchema>;
export const PackageApprovalSchema = z.enum(['required', 'not_required', 'unavailable']);
export type PackageApproval = z.infer<typeof PackageApprovalSchema>;

export const PackageRuntimeSchema = z.object({
  imageId: z.string().min(1).max(256),
  node: z.string().max(64).nullable(),
  npm: z.string().max(64).nullable(),
  uv: z.string().max(64).nullable(),
  python: z.string().max(64).nullable()
}).strict();
export type PackageRuntime = z.infer<typeof PackageRuntimeSchema>;

export const PackageSourceSchema = z.object({
  registry: z.string().min(1).max(2_048),
  resolved: z.string().min(1).max(2_048)
}).strict();
export type PackageSource = z.infer<typeof PackageSourceSchema>;

/** A binary name another binding already exposes where this plan would also expose it. */
export const PackageConflictSchema = z.object({
  binary: PackageBinaryNameSchema,
  bindingId: PackageBindingIdSchema,
  scope: PackageScopeSchema,
  workspaceId: z.string().nullable(),
  ecosystem: BuildablePackageEcosystemSchema,
  name: PackageNameFieldSchema
}).strict();
export type PackageConflict = z.infer<typeof PackageConflictSchema>;

export const PackagePlanResultSchema = z.object({
  planId: PackagePlanIdSchema,
  planDigest: PackageDigestSchema,
  expiresAt: z.string(),
  approval: PackageApprovalSchema,
  package: z.object({ ecosystem: BuildablePackageEcosystemSchema, name: PackageNameFieldSchema, version: z.string().min(1).max(PACKAGE_VERSION_SPEC_MAX_LENGTH) }).strict(),
  source: PackageSourceSchema,
  integrity: z.string().max(512).nullable(),
  dependencyCount: z.number().int().min(0),
  sizeEstimateBytes: z.number().int().min(0),
  binaries: z.array(PackageBinaryNameSchema),
  conflicts: z.array(PackageConflictSchema),
  affectedWorkspaces: z.array(z.string()),
  bindingGeneration: z.number().int().min(0),
  runtime: z.object({ imageId: z.string(), node: z.string().optional(), python: z.string().optional() }).strict()
}).strict();
export type PackagePlanResult = z.infer<typeof PackagePlanResultSchema>;

export const PackageApplyResultSchema = z.object({
  applyId: PackageApplyIdSchema,
  planId: PackagePlanIdSchema,
  releaseId: PackageReleaseIdSchema,
  state: PackageApplyStateSchema
}).strict();
export type PackageApplyResult = z.infer<typeof PackageApplyResultSchema>;

export const PackageReleaseViewSchema = z.object({
  releaseId: PackageReleaseIdSchema,
  ecosystem: BuildablePackageEcosystemSchema,
  name: PackageNameFieldSchema,
  version: z.string(),
  treeDigest: z.string(),
  sizeBytes: z.number().int().min(0),
  binaries: z.array(PackageBinaryNameSchema),
  createdAt: z.string(),
  runtime: PackageRuntimeSchema,
  status: PackageReleaseStatusSchema,
  stale: z.boolean()
}).strict();
export type PackageReleaseView = z.infer<typeof PackageReleaseViewSchema>;

export const PackageBindingViewSchema = z.object({
  bindingId: PackageBindingIdSchema,
  scope: PackageScopeSchema,
  workspaceId: z.string().optional(),
  ecosystem: BuildablePackageEcosystemSchema,
  name: PackageNameFieldSchema,
  generation: z.number().int().min(0),
  release: PackageReleaseViewSchema.nullable()
}).strict();
export type PackageBindingView = z.infer<typeof PackageBindingViewSchema>;

export const PackagesListResultSchema = z.object({
  bindings: z.array(PackageBindingViewSchema),
  releases: z.array(PackageReleaseViewSchema)
}).strict();
export type PackagesListResult = z.infer<typeof PackagesListResultSchema>;

export const PackageApplyViewSchema = z.object({
  applyId: PackageApplyIdSchema,
  planId: PackagePlanIdSchema,
  bindingId: PackageBindingIdSchema,
  releaseId: PackageReleaseIdSchema,
  state: PackageApplyStateSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().max(2_000).optional(),
  outputTail: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional()
}).strict();
export type PackageApplyView = z.infer<typeof PackageApplyViewSchema>;

export const PackagePlanSummarySchema = z.object({
  planId: PackagePlanIdSchema,
  planDigest: PackageDigestSchema,
  status: PackagePlanStatusSchema,
  scope: PackageScopeSchema,
  workspaceId: z.string().optional(),
  ecosystem: BuildablePackageEcosystemSchema,
  name: PackageNameFieldSchema,
  version: z.string(),
  createdAt: z.string(),
  expiresAt: z.string()
}).strict();
export type PackagePlanSummary = z.infer<typeof PackagePlanSummarySchema>;

export const PackagesStatusResultSchema = z.union([
  z.object({ apply: PackageApplyViewSchema }).strict(),
  z.object({
    inFlight: z.array(PackageApplyViewSchema),
    pendingPlans: z.array(PackagePlanSummarySchema),
    missingReleases: z.array(PackageReleaseIdSchema),
    workspacesPendingRecreate: z.array(z.string())
  }).strict()
]);
export type PackagesStatusResult = z.infer<typeof PackagesStatusResultSchema>;

export const PackagesRollbackResultSchema = z.object({
  binding: PackageBindingViewSchema,
  affectedWorkspaces: z.array(z.string())
}).strict();
export type PackagesRollbackResult = z.infer<typeof PackagesRollbackResultSchema>;
