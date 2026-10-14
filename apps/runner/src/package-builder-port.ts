import type { BuildablePackageEcosystem, PackageRuntime, PackageSource } from '@cloud-harness/contracts';
import type { PackageSbomEntry } from './package-store.js';

/** What `packages_plan` asks the isolated builder to resolve. User values travel only as positional arguments. */
export type ResolvePackagePlanSpec = {
  /** The `pkp_` id reserved for the plan; names the scratch directory and the builder container. */
  scratchId: string;
  ecosystem: BuildablePackageEcosystem;
  name: string;
  /** npm spec or tag (default `latest`) or a PEP 440 specifier for uv. */
  requestedSpec: string;
  /** uv only. */
  python?: string;
  /** npm only; whether the plan asks for lifecycle scripts. */
  lifecycleScripts: boolean;
  signal?: AbortSignal;
};

export type ResolvedPackagePlan = {
  version: string;
  source: PackageSource;
  integrity: string | null;
  /** npm: JSON `{ packageJson, lock }`; uv: `requirements.lock` text. Stored as the plan's lock text. */
  lockText: string;
  lockSha256: string;
  dependencyCount: number;
  sizeEstimateBytes: number;
  /** Sorted, validated binary names the root package exposes. */
  binaries: string[];
  runtime: PackageRuntime;
};

/** One apply build. The builder stages at `stagingDir`, mounted at `/opt/chm-packages/<releaseId>` in containers. */
export type PackageBuildJob = {
  applyId: string;
  releaseId: string;
  ecosystem: BuildablePackageEcosystem;
  name: string;
  version: string;
  lockText: string;
  binaries: readonly string[];
  lifecycleScripts: boolean;
  python?: string;
  /** Absolute host path of the staging directory; the runner creates it before calling `build`. */
  stagingDir: string;
  maxReleaseBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called on every phase change so the service can advance the durable apply state. */
  onPhase?: (phase: 'BUILDING' | 'VERIFYING') => void | Promise<void>;
  /** Receives builder output; the service redacts and bounds it into the apply's output tail. */
  onOutput?: (chunk: string) => void;
};

export type PackageBuildResult = {
  treeDigest: string;
  sizeBytes: number;
  fileCount: number;
  sbom: PackageSbomEntry[];
  runtime: PackageRuntime;
  provenance: Record<string, unknown>;
  /** The launch-check command that passed, per binary. */
  launchChecks: Record<string, string>;
};

/**
 * Boundary between `PackageService` (orchestration, state) and `PackageBuilder` (containers, filesystem).
 * Errors are `ToolError`s carrying the contract codes: `UNAVAILABLE` (proxy host blocked, builder failed to
 * start), `PACKAGE_BUILD_FAILED`, `PACKAGE_VERIFICATION_FAILED`, `LIMIT_EXCEEDED`, `TIMEOUT`, `CANCELLED`.
 */
export interface PackageBuilderPort {
  /** The executor image ID that plans and releases are pinned to. */
  imageId(): Promise<string>;
  /** Fails with `UNAVAILABLE` naming the host when the provisioning proxy refuses a registry host. */
  probeRegistries(ecosystem: BuildablePackageEcosystem): Promise<void>;
  resolvePlan(spec: ResolvePackagePlanSpec): Promise<ResolvedPackagePlan>;
  /** Builds, removes the builder container, verifies the tree, and launch-checks every binary without network. */
  build(job: PackageBuildJob): Promise<PackageBuildResult>;
}
