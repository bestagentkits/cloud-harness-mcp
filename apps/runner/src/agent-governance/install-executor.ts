import { randomBytes } from 'node:crypto';
import { HarnessError, type ExecutorNetworkProfile } from '@cloud-harness/contracts';
import { removeContainer, runDocker, type CommandResult } from '../docker-engine.js';
import { isSafeBindPath } from '../toolbox-runner.js';

/**
 * The lockfile install executor for coding workflows. A coding agent stays on `network-none` and never
 * installs anything; when the owner turns on AGENT_CODING_PACKAGE_INSTALL_ENABLED and the policy allows
 * each locked package, the runner installs the checkout's npm lockfile once, before the agent starts, in
 * a one-shot container on the `dependency-access` profile. The install is frozen to the lockfile
 * (`npm ci`), lifecycle scripts are off, and the container gets the checkout and nothing else: no
 * secrets, no Docker socket, no tools or cache mounts, and the executor hardening and resource bounds.
 * The workspace record's network profile is never changed.
 */

export const NPM_LOCKFILE = 'package-lock.json';
/** Larger lockfiles are refused rather than parsed; `files_read` also returns at most 1 MiB in one call. */
export const MAX_LOCKFILE_BYTES = 1_048_576;
export const MAX_LOCKED_PACKAGES = 5_000;
export const INSTALL_TIMEOUT_MS = 600_000;
const INSTALL_MAX_OUTPUT_BYTES = 262_144;
const CONTAINER_NAME = /^chm-install-[a-f0-9]{16}$/u;
const INSTANCE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,128}$/u;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export type LockedPackage = { name: string; version: string; registryHost: string };

export type LockfileAdmission =
  | { ok: true; packages: LockedPackage[] }
  | { ok: false; reason: string };

/**
 * Supply-chain admission for an npm lockfile. Every installed entry must be a registry tarball from an
 * allowed registry with a sha512 integrity hash, so `npm ci` can only fetch exactly what the lockfile
 * pins. Git, file, link and workspace entries, lockfile v1, and unpinned entries are refused.
 */
export function admitNpmLockfile(text: string, allowedRegistries: readonly string[]): LockfileAdmission {
  if (Buffer.byteLength(text) > MAX_LOCKFILE_BYTES) return { ok: false, reason: 'lockfile is too large' };
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'lockfile is not valid JSON' };
  }
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return { ok: false, reason: 'lockfile is not an object' };
  const { lockfileVersion, packages } = lock as { lockfileVersion?: unknown; packages?: unknown };
  if (lockfileVersion !== 2 && lockfileVersion !== 3) return { ok: false, reason: 'lockfileVersion 2 or 3 is required' };
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) return { ok: false, reason: 'lockfile has no packages map' };
  const registries = allowedRegistries.map((registry) => new URL(registry));
  const admitted: LockedPackage[] = [];
  const entries = Object.entries(packages as Record<string, unknown>);
  if (entries.length > MAX_LOCKED_PACKAGES + 1) return { ok: false, reason: 'lockfile has too many packages' };
  for (const [key, value] of entries) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'lockfile entry is not an object' };
    const entry = value as { version?: unknown; resolved?: unknown; integrity?: unknown; link?: unknown; inBundle?: unknown; workspaces?: unknown };
    if (key === '') {
      if (entry.workspaces !== undefined) return { ok: false, reason: 'npm workspaces are not supported' };
      continue;
    }
    if (!key.startsWith('node_modules/')) return { ok: false, reason: 'lockfile names a package outside node_modules' };
    if (entry.link === true) return { ok: false, reason: 'linked packages are not supported' };
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!NPM_NAME.test(name) || name.length > 200) return { ok: false, reason: 'lockfile names an invalid package' };
    // A bundled dependency ships inside its parent's verified tarball and has no source of its own.
    if (entry.inBundle === true) continue;
    if (typeof entry.version !== 'string' || entry.version.length > 128) return { ok: false, reason: `${name} has no pinned version` };
    if (typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') return { ok: false, reason: `${name} is not pinned to a registry tarball` };
    if (!SRI_SHA512.test(entry.integrity)) return { ok: false, reason: `${name} has no sha512 integrity` };
    let resolved: URL;
    try {
      resolved = new URL(entry.resolved);
    } catch {
      return { ok: false, reason: `${name} has an invalid source` };
    }
    const registry = registries.find((allowed) => resolved.origin === allowed.origin && resolved.pathname.startsWith(allowed.pathname)
      && resolved.username === '' && resolved.password === '');
    if (!registry || !resolved.pathname.endsWith('.tgz')) return { ok: false, reason: `${name} is not from an allowed registry` };
    admitted.push({ name, version: entry.version, registryHost: registry.hostname });
  }
  return { ok: true, packages: admitted };
}

/**
 * The fixed install script. It keeps `node_modules` out of the commit the runner makes later by adding
 * it to the clone's local exclude file, then runs a frozen, script-free install. Nothing in it comes from
 * the repository, the agent or the workflow; the registry arrives as a positional argument.
 */
export const NPM_LOCKFILE_INSTALL_SCRIPT = `set -eu
registry=$1
mkdir -p .git/info /tmp/cloud-harness-home /tmp/npm-cache
grep -qxF '/node_modules/' .git/info/exclude 2>/dev/null || printf '%s\\n' '/node_modules/' >> .git/info/exclude
exec npm ci --ignore-scripts --no-audit --no-fund --registry "$registry"
`;

export type InstallContainerSpec = {
  name: string;
  image: string;
  instanceId: string;
  workspaceId: string;
  /** Host path of the workspace job directory; only its `repo` subdirectory is mounted. */
  workspacePath: string;
  registry: string;
  networkArgs: readonly string[];
};

export function installContainerName(): string {
  return `chm-install-${randomBytes(8).toString('hex')}`;
}

/** The complete `docker run` argument list for one install. Validated, so no value can inject an option. */
export function npmInstallContainerArgs(spec: InstallContainerSpec): string[] {
  if (!CONTAINER_NAME.test(spec.name) || !INSTANCE_ID.test(spec.instanceId) || !WORKSPACE_ID.test(spec.workspaceId)) {
    throw new HarnessError('INTERNAL_ERROR', 'install container identity is invalid', 500, false);
  }
  const repo = `${spec.workspacePath}/repo`;
  if (!isSafeBindPath(repo)) {
    throw new HarnessError('INTERNAL_ERROR', 'install mount is invalid', 500, false);
  }
  const registry = new URL(spec.registry);
  if ((registry.protocol !== 'https:' && registry.protocol !== 'http:') || registry.username || registry.password) {
    throw new HarnessError('INTERNAL_ERROR', 'install registry is invalid', 500, false);
  }
  return [
    'run', '--rm', '--pull', 'never', '--name', spec.name,
    '--label', 'cloud-harness.managed=true',
    '--label', `cloud-harness.instance=${spec.instanceId}`,
    '--label', `cloud-harness.workspace=${spec.workspaceId}`,
    '--label', 'cloud-harness.role=coding-install',
    '--label', 'cloud-harness.ephemeral=true',
    ...spec.networkArgs,
    '--user', '10001:10001', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024',
    '--mount', `type=bind,source=${repo},target=/workspace`,
    '--workdir', '/workspace',
    // The environment is fixed: no secret, token or proxy credential is ever passed.
    '--env', 'HOME=/tmp/cloud-harness-home',
    '--env', 'npm_config_cache=/tmp/npm-cache',
    '--env', 'npm_config_ignore_scripts=true',
    '--env', 'npm_config_update_notifier=false',
    '--env', 'npm_config_fund=false',
    '--env', 'npm_config_audit=false',
    '--entrypoint', '/bin/sh',
    spec.image,
    '-c', NPM_LOCKFILE_INSTALL_SCRIPT, 'coding-install', registry.href
  ];
}

export type InstallNetwork = {
  ensureProfileReady(profile: ExecutorNetworkProfile): Promise<void>;
  dockerLaunchArgs(profile: ExecutorNetworkProfile): string[];
};

export type LockfileInstallOptions = {
  image: string;
  instanceId: string;
  network: InstallNetwork;
  registry: string;
  run?: (args: string[], options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => Promise<CommandResult>;
  remove?: (name: string) => Promise<void>;
};

export type InstallResult = { ok: true; exitCode: 0 } | { ok: false; code: string; exitCode: number | null; output: string };

export class LockfileInstallExecutor {
  private readonly run: NonNullable<LockfileInstallOptions['run']>;
  private readonly remove: NonNullable<LockfileInstallOptions['remove']>;

  constructor(private readonly options: LockfileInstallOptions) {
    this.run = options.run ?? runDocker;
    this.remove = options.remove ?? removeContainer;
  }

  /**
   * Installs the checkout's lockfile. The dependency-access attestation runs first and a failure stops
   * the install with DEPENDENCY_EGRESS_UNAVAILABLE: egress is never silently downgraded or widened.
   */
  async install(target: { workspaceId: string; workspacePath: string }, signal?: AbortSignal): Promise<InstallResult> {
    await this.options.network.ensureProfileReady('dependency-access');
    const name = installContainerName();
    const args = npmInstallContainerArgs({
      name, image: this.options.image, instanceId: this.options.instanceId, workspaceId: target.workspaceId,
      workspacePath: target.workspacePath, registry: this.options.registry,
      networkArgs: this.options.network.dockerLaunchArgs('dependency-access')
    });
    try {
      const result = await this.run(args, { timeoutMs: INSTALL_TIMEOUT_MS, maxBytes: INSTALL_MAX_OUTPUT_BYTES, ...(signal ? { signal } : {}) });
      if (result.exitCode === 0) return { ok: true, exitCode: 0 };
      return { ok: false, code: 'CODING_INSTALL_FAILED', exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.slice(-4_000) };
    } finally {
      await this.remove(name);
    }
  }
}
