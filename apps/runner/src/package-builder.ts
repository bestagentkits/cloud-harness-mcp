import { createHash, randomBytes } from 'node:crypto';
import { chmod, chown, lstat, mkdir, readdir, readlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  HarnessError,
  PACKAGE_BINARY_NAME_PATTERN,
  PACKAGE_PYTHON_VERSION_PATTERN,
  PackageReleaseIdSchema,
  packageNameIssue,
  packageVersionSpecIssue,
  type BuildablePackageEcosystem,
  type PackageRuntime
} from '@cloud-harness/contracts';
import { computeFullTreeDigestAsync } from './adapters/mattpocock-adapter.js';
import { removeContainer, runDocker, spawnDocker } from './docker-engine.js';
import type {
  PackageBuildJob,
  PackageBuildResult,
  PackageBuilderPort,
  ResolvedPackagePlan,
  ResolvePackagePlanSpec
} from './package-builder-port.js';
import { PACKAGE_MAX_LOCK_TEXT_BYTES, PACKAGE_MAX_SBOM_JSON_BYTES, PACKAGE_STORE_ID_PATTERN, type PackageSbomEntry } from './package-store.js';
import {
  EXECUTOR_HARDENING_ARGS,
  isSafeBindPath,
  removeContainerUntilGone,
  runToolboxCommand,
  toolboxContainerName
} from './toolbox-runner.js';

/**
 * The isolated package builder: it resolves plans and builds releases in disposable builder containers, then
 * verifies the staged tree and launch-checks every binary without network.
 *
 * Builder containers carry the executor hardening, run as uid 10001, see only their scratch directory (and,
 * for an apply, the staging directory mounted at the release's final path), and reach registries only through
 * the provisioning proxy. The scripts are fixed strings; user values travel only as positional arguments, so
 * no package name or version spec is ever parsed as shell. No secret, env file, Docker socket, or credential
 * is ever passed. Each builder container is removed by exact name, and its absence is confirmed before the
 * staged tree is read, so nothing can still be writing while the runner verifies and digests it.
 */

/** Where releases are mounted inside containers; the builder stages at this same path. */
export const PACKAGE_MOUNT_ROOT = '/opt/chm-packages';
/** Largest builder stdout the runner parses. */
export const PACKAGE_BUILDER_MAX_OUTPUT_BYTES = 8 * 1_048_576;
/** More entries than this in one release is refused rather than walked and digested. */
export const PACKAGE_MAX_RELEASE_ENTRIES = 200_000;
export const PACKAGE_LAUNCH_CHECK_TIMEOUT_MS = 30_000;
export const PACKAGE_LAUNCH_CHECK_MAX_OUTPUT_BYTES = 65_536;
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_PYPI_INDEX = 'https://pypi.org/simple';
/** Host uv downloads managed Python builds from when no mirror is configured. */
const DEFAULT_PYTHON_DOWNLOAD_HOST = 'github.com';
/** GitHub release downloads redirect here, so the default managed-Python download needs both hosts. */
const GITHUB_RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com';
const PYPI_FILES_HOST = 'files.pythonhosted.org';
const PROBE_TIMEOUT_MS = 10_000;
const HELPER_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_BYTES = 65_536;
const MAX_SYMLINK_HOPS = 40;
const BUILDER_NAME = /^chm-pkgbuild-[a-f0-9]{16}$/;
const INSTANCE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const RESOLVED_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const TOOL_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

/* Fixed builder scripts. Every user value arrives as "$1", "$2", ...; nothing user-controlled is in the text. */

/** npm plan: resolve a lockfile only (no install, no scripts), then emit the lock, package.json, and `npm view`. */
export const NPM_PLAN_SCRIPT = `set -euo pipefail
name=$1
spec=$2
mkdir -p /work/home /work/npm-cache /work/plan
cd /work/plan
printf '%s\\n' '{"name":"chm-release","private":true}' > package.json
npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact -- "$name@$spec" >&2
version=$(node -e 'const lock = require("/work/plan/package-lock.json"); const entry = (lock.packages || {})["node_modules/" + process.argv[1]]; if (!entry || typeof entry.version !== "string") process.exit(3); process.stdout.write(entry.version);' "$name")
npm view --json -- "$name@$version" bin dist.unpackedSize engines > /work/plan/view.json
node -e 'const fs = require("fs"); const view = fs.readFileSync("/work/plan/view.json", "utf8").trim(); process.stdout.write(JSON.stringify({ packageJson: fs.readFileSync("/work/plan/package.json", "utf8"), lock: fs.readFileSync("/work/plan/package-lock.json", "utf8"), view: view ? JSON.parse(view) : null, node: process.versions.node, npm: process.argv[1] }));' "$(npm --version)"
`;

/** npm apply: `npm ci` from the approved lock into the release, then link only the root package's binaries. */
export const NPM_APPLY_SCRIPT = `set -euo pipefail
release=$1
scripts=$2
shift 2
dest=/opt/chm-packages/$release
mkdir -p /work/home /work/npm-cache "$dest/npm" "$dest/bin"
cp /work/input/package.json /work/input/package-lock.json "$dest/npm/"
cd "$dest/npm"
if [ "$scripts" = allow ]; then
  npm ci --omit=dev --no-audit --no-fund >&2
else
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2
fi
for bin in "$@"; do
  if [ ! -e "node_modules/.bin/$bin" ]; then echo "binary $bin was not installed" >&2; exit 3; fi
  ln -s "../npm/node_modules/.bin/$bin" "$dest/bin/$bin"
done
node -e 'process.stdout.write(JSON.stringify({ node: process.versions.node, npm: process.argv[1] }));' "$(npm --version)"
`;

/**
 * Printed after uv fails to resolve or install with `--no-build`, so the build failure names the wheel-only rule
 * even when uv's own resolver explanation scrolls out of the bounded output tail.
 */
export const UV_WHEELS_ONLY_MESSAGE = 'uv could not resolve or install the requirement from pre-built wheels: only wheels are supported, and source distributions are never built';

/**
 * uv plan: install a managed Python into scratch, compile a hash-pinned lock, trial-sync it into a probe venv,
 * and read the root distribution's console scripts. Every uv pip call passes `--no-build`, so no source
 * distribution's build backend ever runs: resolution happens before approval and must not execute package code.
 */
export const UV_PLAN_SCRIPT = `set -euo pipefail
name=$1
requirement=$2
python=$3
mkdir -p /work/home /work/uv-cache
export UV_PYTHON_INSTALL_DIR=/work/python
if [ -n "$python" ]; then
  uv python install -- "$python" >&2
  interpreter=$(uv python find -- "$python")
else
  uv python install >&2
  interpreter=$(uv python find)
fi
printf '%s\\n' "$requirement" > /work/requirements.in
if ! uv pip compile --python "$interpreter" --no-build --generate-hashes --no-header --quiet --output-file /work/requirements.lock /work/requirements.in >&2; then
  echo "${UV_WHEELS_ONLY_MESSAGE}" >&2
  exit 4
fi
uv venv --python "$interpreter" /work/probe >&2
if ! uv pip sync --python /work/probe/bin/python --no-build --require-hashes /work/requirements.lock >&2; then
  echo "${UV_WHEELS_ONLY_MESSAGE}" >&2
  exit 4
fi
python_version=$(/work/probe/bin/python -c 'import platform; print(platform.python_version())')
size=$(du -sbc /work/probe /work/python | tail -n 1 | cut -f1)
node -e 'const fs = require("fs"); const path = require("path"); const [name, pythonVersion, uvVersion, size] = process.argv.slice(1); const normalize = (value) => value.toLowerCase().replace(/[-_.]+/g, "_"); const lib = "/work/probe/lib"; const pythonDir = fs.readdirSync(lib).find((entry) => entry.startsWith("python")); if (!pythonDir) { process.stderr.write("probe environment has no site-packages\\n"); process.exit(3); } const sitePackages = path.join(lib, pythonDir, "site-packages"); const info = fs.readdirSync(sitePackages).find((entry) => { if (!entry.endsWith(".dist-info")) return false; const stem = entry.slice(0, -10); const dash = stem.lastIndexOf("-"); return dash > 0 && normalize(stem.slice(0, dash)) === normalize(name); }); if (!info) { process.stderr.write("root distribution metadata was not found\\n"); process.exit(3); } const scripts = []; const entryPoints = path.join(sitePackages, info, "entry_points.txt"); if (fs.existsSync(entryPoints)) { let inSection = false; for (const raw of fs.readFileSync(entryPoints, "utf8").split(/\\r?\\n/)) { const line = raw.trim(); if (line.startsWith("[")) { inSection = line === "[console_scripts]"; continue; } if (!inSection || !line || line.startsWith("#") || line.startsWith(";")) continue; const equals = line.indexOf("="); if (equals > 0) scripts.push(line.slice(0, equals).trim()); } } process.stdout.write(JSON.stringify({ lock: fs.readFileSync("/work/requirements.lock", "utf8"), pythonVersion, uvVersion, scripts, sizeBytes: Number(size) }));' "$name" "$python_version" "$(uv --version)" "$size"
`;

/**
 * uv apply: install the managed Python into the release itself (the executor image has none), create the
 * venv at its final path, sync the hash-pinned lock from wheels only (`--no-build`), and link the root
 * distribution's console scripts.
 */
export const UV_APPLY_SCRIPT = `set -euo pipefail
release=$1
python=$2
shift 2
dest=/opt/chm-packages/$release
mkdir -p /work/home /work/uv-cache "$dest/bin"
export UV_PYTHON_INSTALL_DIR="$dest/python"
if [ -n "$python" ]; then
  uv python install -- "$python" >&2
  interpreter=$(uv python find -- "$python")
else
  uv python install >&2
  interpreter=$(uv python find)
fi
cp /work/input/requirements.lock "$dest/requirements.lock"
uv venv --python "$interpreter" "$dest/venv" >&2
if ! uv pip sync --python "$dest/venv/bin/python" --no-build --require-hashes "$dest/requirements.lock" >&2; then
  echo "${UV_WHEELS_ONLY_MESSAGE}" >&2
  exit 4
fi
for bin in "$@"; do
  if [ ! -x "$dest/venv/bin/$bin" ]; then echo "binary $bin was not installed" >&2; exit 3; fi
  ln -s "../venv/bin/$bin" "$dest/bin/$bin"
done
python_version=$("$dest/venv/bin/python" -c 'import platform; print(platform.python_version())')
node -e 'process.stdout.write(JSON.stringify({ uv: process.argv[1], python: process.argv[2] }));' "$(uv --version)" "$python_version"
`;

/* Errors. */

const buildFailed = (message: string) => new HarnessError('PACKAGE_BUILD_FAILED', message.slice(0, 2_000), 422, false);
const verificationFailed = (message: string) => new HarnessError('PACKAGE_VERIFICATION_FAILED', message.slice(0, 2_000), 422, false);
const internal = (message: string) => new HarnessError('INTERNAL_ERROR', message, 500, false);
const cancelled = () => new HarnessError('CANCELLED', 'request cancelled', 499, false);
/** Paths and names from a package are quoted and bounded before they appear in an error message. */
const quote = (value: string) => JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);

function tail(text: string, bytes = 1_500): string {
  const trimmed = text.trim();
  return trimmed.length > bytes ? `…${trimmed.slice(-bytes)}` : trimmed;
}

/* URLs and the proxy probe. */

/** Parses a registry, index, mirror, or proxy URL: http(s) only, no credentials, no whitespace. */
export function parseServiceUrl(value: string, what: string, protocols: readonly string[] = ['http:', 'https:']): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw internal(`${what} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || /[\s"',]/.test(value) || !url.hostname) {
    throw internal(`${what} must be a credential-free ${protocols.join(' or ')} URL`);
  }
  return url;
}

/**
 * Asks the provisioning proxy to open `CONNECT <host>:443`, which is exactly what a builder's TLS request does.
 * A 200 means the host is allow-listed; a 403 means the operator has not opted it in. The tunnel is closed as
 * soon as the status line arrives, so no request ever crosses it.
 */
export async function probeHost(proxyUrl: string, host: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  const proxy = parseServiceUrl(proxyUrl, 'provisioning proxy', ['http:']);
  const target = host.toLowerCase();
  if (!HOSTNAME.test(target)) throw internal('registry host is invalid');
  const port = Number(proxy.port || 80);
  const status = await new Promise<number>((resolve, reject) => {
    const socket = connect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port });
    let buffered = '';
    const finish = (error: HarnessError | undefined, code?: number) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(code ?? 0);
    };
    const unreachable = () => new HarnessError('UNAVAILABLE', `provisioning proxy is unreachable while checking ${target}`, 503, true);
    const timer = setTimeout(() => finish(unreachable()), timeoutMs);
    socket.setEncoding('latin1');
    socket.on('connect', () => socket.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const lineEnd = buffered.indexOf('\r\n');
      if (lineEnd < 0 && buffered.length < 8_192) return;
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffered);
      if (!match) finish(new HarnessError('UNAVAILABLE', `provisioning proxy sent an invalid response while checking ${target}`, 503, true));
      else finish(undefined, Number(match[1]));
    });
    socket.on('error', () => finish(unreachable()));
    socket.on('close', () => finish(unreachable()));
  });
  if (status === 200) return;
  if (status === 403) {
    throw new HarnessError('UNAVAILABLE', `provisioning proxy refuses ${target}: the operator must add ${target} to PACKAGES_PROXY_HOSTS`, 503, false);
  }
  throw new HarnessError('UNAVAILABLE', `provisioning proxy could not reach ${target} (status ${status})`, 503, true);
}

/* Builder argv. */

export type PackageBuilderRunSpec = {
  name: string;
  image: string;
  instanceId: string;
  network: string;
  proxy: string | undefined;
  npmRegistry: string;
  pypiIndex: string;
  pythonMirror: string | undefined;
  /** Host scratch directory, mounted read-write at `/work`. */
  scratchDir: string;
  /** Apply only: the host staging directory, mounted read-write at the release's final path. */
  staging?: { source: string; releaseId: string };
  script: string;
  args: readonly string[];
};

export function builderContainerName(): string {
  return `chm-pkgbuild-${randomBytes(8).toString('hex')}`;
}

export const packageMountPath = (releaseId: string): string => `${PACKAGE_MOUNT_ROOT}/${releaseId}`;

function assertReleaseId(releaseId: string): void {
  if (!PackageReleaseIdSchema.safeParse(releaseId).success) throw internal('package release id is invalid');
}

/**
 * Builds the `docker run` argv for one builder container. The only egress is the provisioning network and its
 * proxy; the only mounts are scratch at `/work` and, for an apply, staging at `/opt/chm-packages/<release>`.
 */
export function buildPackageBuilderArgs(spec: PackageBuilderRunSpec): string[] {
  if (!BUILDER_NAME.test(spec.name)) throw internal('package builder container name is invalid');
  if (!INSTANCE_ID.test(spec.instanceId)) throw internal('package builder instance label is invalid');
  if (!NETWORK_NAME.test(spec.network) || spec.network === 'host') throw internal('package builder network is invalid');
  const urls = [spec.npmRegistry, spec.pypiIndex, ...(spec.pythonMirror ? [spec.pythonMirror] : [])];
  for (const url of urls) parseServiceUrl(url, 'package registry');
  if (spec.proxy !== undefined) parseServiceUrl(spec.proxy, 'provisioning proxy', ['http:']);
  const mounts: Array<[string, string]> = [[spec.scratchDir, '/work']];
  if (spec.staging) {
    assertReleaseId(spec.staging.releaseId);
    mounts.push([spec.staging.source, packageMountPath(spec.staging.releaseId)]);
  }
  for (const [source] of mounts) if (!isSafeBindPath(source)) throw internal('package builder mount path is invalid');
  for (const arg of spec.args) if (arg.includes('\0')) throw internal('package builder argument is invalid');
  const proxyEnv = spec.proxy === undefined ? [] : [
    '--env', `HTTP_PROXY=${spec.proxy}`, '--env', `HTTPS_PROXY=${spec.proxy}`, '--env', 'NO_PROXY=localhost,127.0.0.1',
    '--env', `npm_config_proxy=${spec.proxy}`, '--env', `npm_config_https_proxy=${spec.proxy}`
  ];
  return [
    'run', '--rm', '--pull', 'never', '--name', spec.name,
    '--label', 'cloud-harness.role=package-builder', '--label', 'cloud-harness.ephemeral=true',
    '--label', `cloud-harness.instance=${spec.instanceId}`,
    ...EXECUTOR_HARDENING_ARGS,
    '--network', spec.network,
    ...proxyEnv,
    '--env', 'HOME=/work/home', '--env', 'npm_config_cache=/work/npm-cache', '--env', `npm_config_registry=${spec.npmRegistry}`,
    '--env', 'npm_config_update_notifier=false',
    '--env', 'UV_CACHE_DIR=/work/uv-cache', '--env', 'UV_PYTHON_PREFERENCE=only-managed', '--env', `UV_INDEX_URL=${spec.pypiIndex}`,
    // Copy, never hardlink, from the scratch cache: a release must not share inodes with deleted scratch.
    '--env', 'UV_LINK_MODE=copy',
    ...(spec.pythonMirror ? ['--env', `UV_PYTHON_INSTALL_MIRROR=${spec.pythonMirror}`] : []),
    '--workdir', '/work',
    ...mounts.flatMap(([source, target]) => ['--mount', `type=bind,source=${source},target=${target}`]),
    spec.image,
    '/bin/bash', '-c', spec.script, 'package-builder', ...spec.args
  ];
}

/** The uv requirement for a name and PEP 440 specifier; a bare version pins it exactly. */
export function uvRequirement(name: string, spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === 'latest') return name;
  return /^[0-9]/.test(trimmed) ? `${name}==${trimmed}` : `${name}${trimmed}`;
}

/* Output parsers. Builder output is untrusted: it is bounded, parsed with zod, and cross-checked. */

function parseBuilderJson<T>(stdout: string, schema: z.ZodType<T>, what: string): T {
  if (Buffer.byteLength(stdout) > PACKAGE_BUILDER_MAX_OUTPUT_BYTES) throw buildFailed(`${what} output exceeds ${PACKAGE_BUILDER_MAX_OUTPUT_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw buildFailed(`${what} output is not valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw buildFailed(`${what} output is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

const ToolVersionSchema = z.string().trim().regex(TOOL_VERSION);
const NpmPlanOutputSchema = z.object({
  packageJson: z.string().max(65_536),
  lock: z.string().max(PACKAGE_MAX_LOCK_TEXT_BYTES),
  view: z.unknown(),
  node: ToolVersionSchema,
  npm: ToolVersionSchema
}).strict();
const NpmLockEntrySchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
  bin: z.record(z.string(), z.string()).optional(),
  dev: z.boolean().optional(),
  link: z.boolean().optional(),
  inBundle: z.boolean().optional()
}).passthrough();
const NpmLockSchema = z.object({
  lockfileVersion: z.number().int().min(2),
  packages: z.record(z.string(), NpmLockEntrySchema)
}).passthrough();
const NpmLockTextSchema = z.object({ packageJson: z.string(), lock: z.string() }).strict();
const UvPlanOutputSchema = z.object({
  lock: z.string().min(1).max(PACKAGE_MAX_LOCK_TEXT_BYTES),
  pythonVersion: ToolVersionSchema,
  uvVersion: z.string().max(128),
  scripts: z.array(z.string().max(256)).max(256),
  sizeBytes: z.number().int().min(0)
}).strict();
const ApplyRuntimeSchema = z.object({
  node: ToolVersionSchema.optional(),
  npm: ToolVersionSchema.optional(),
  uv: z.string().max(128).optional(),
  python: ToolVersionSchema.optional()
}).strict();

/** `uv --version` prints `uv 0.9.5 (...)`; the runtime records only the version token. */
function uvVersionToken(output: string): string {
  const token = output.trim().split(/\s+/)[1] ?? '';
  if (!TOOL_VERSION.test(token)) throw buildFailed('builder reported an unrecognised uv version');
  return token;
}

function sortedBinaries(names: readonly string[], what: string): string[] {
  const unique = [...new Set(names)].sort();
  for (const name of unique) {
    if (!PACKAGE_BINARY_NAME_PATTERN.test(name)) throw buildFailed(`${what} exposes the unsupported binary name ${quote(name)}`);
  }
  if (unique.length === 0) throw buildFailed(`${what} exposes no binaries`);
  return unique;
}

export type ParsedNpmLock = {
  packageJson: string;
  lock: string;
  version: string;
  resolved: string;
  integrity: string;
  binaries: string[];
  dependencyCount: number;
  sbom: PackageSbomEntry[];
};

/**
 * Validates an npm lock against the registry it was resolved from. Every installed package must come from the
 * registry's exact origin and carry a sha512 integrity that `npm ci` will enforce; links, git, file, and
 * foreign-host tarballs are refused. Bundled (`inBundle`) entries are covered by their parent's integrity and are
 * recorded without one. Only the root package's binaries are exposed.
 */
export function parseNpmLock(packageJson: string, lockText: string, name: string, registry: string): ParsedNpmLock {
  const registryUrl = parseServiceUrl(registry, 'npm registry');
  let raw: unknown;
  try {
    raw = JSON.parse(lockText);
    JSON.parse(packageJson);
  } catch {
    throw buildFailed('npm lockfile is not valid JSON');
  }
  const parsed = NpmLockSchema.safeParse(raw);
  if (!parsed.success) throw buildFailed('npm lockfile is malformed');
  const rootKey = `node_modules/${name}`;
  const sbom: PackageSbomEntry[] = [];
  let dependencyCount = 0;
  for (const [key, entry] of Object.entries(parsed.data.packages)) {
    if (key === '') continue;
    if (entry.link) throw buildFailed(`npm lockfile links ${quote(key)} instead of installing it from the registry`);
    if (entry.dev) continue;
    const segment = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (entry.inBundle && key !== rootKey) {
      // Bundled dependencies ship inside their parent's tarball, whose pinned integrity already covers them, so
      // they are only accepted nested under that parent and are never fetched on their own.
      if (!key.includes('/node_modules/')) throw buildFailed(`npm lockfile entry ${quote(key)} is bundled but has no parent package`);
      if (!entry.version) throw buildFailed(`npm lockfile entry ${quote(key)} has no version`);
      dependencyCount += 1;
      sbom.push({ name: entry.name ?? segment, version: entry.version });
      continue;
    }
    if (!entry.resolved || !entry.integrity || !entry.version) throw buildFailed(`npm lockfile entry ${quote(key)} is not pinned to a registry tarball`);
    let resolved: URL;
    try {
      resolved = new URL(entry.resolved);
    } catch {
      throw buildFailed(`npm lockfile entry ${quote(key)} has an invalid tarball URL`);
    }
    if (resolved.protocol !== registryUrl.protocol || resolved.host !== registryUrl.host || resolved.username || resolved.password) {
      throw buildFailed(`npm lockfile entry ${quote(key)} resolves to ${quote(resolved.host)}, not the registry host ${quote(registryUrl.host)}`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) throw buildFailed(`npm lockfile entry ${quote(key)} has no sha512 integrity`);
    if (key !== rootKey) dependencyCount += 1;
    sbom.push({ name: entry.name ?? segment, version: entry.version, integrity: entry.integrity });
  }
  const root = parsed.data.packages[rootKey];
  if (!root?.version || !root.resolved || !root.integrity) throw buildFailed(`npm lockfile does not pin ${quote(name)}`);
  if (!RESOLVED_VERSION.test(root.version)) throw buildFailed('npm resolved an unsupported version string');
  sbom.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  return {
    packageJson,
    lock: lockText,
    version: root.version,
    resolved: root.resolved,
    integrity: root.integrity,
    binaries: sortedBinaries(Object.keys(root.bin ?? {}), `npm package ${quote(name)}`),
    dependencyCount,
    sbom
  };
}

/** `npm view` prints a bare value when only one requested field exists, so the size may be either shape. */
function npmUnpackedSize(view: unknown): number {
  const value = typeof view === 'number' ? view
    : (view && typeof view === 'object' ? (view as Record<string, unknown>)['dist.unpackedSize'] : undefined);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export type ParsedPlanOutput = Omit<ResolvedPackagePlan, 'runtime'> & { runtime: Omit<PackageRuntime, 'imageId'> };

export function parseNpmPlanOutput(stdout: string, name: string, registry: string): ParsedPlanOutput {
  const output = parseBuilderJson(stdout, NpmPlanOutputSchema, 'npm plan');
  const lock = parseNpmLock(output.packageJson, output.lock, name, registry);
  const lockText = JSON.stringify({ packageJson: output.packageJson, lock: output.lock });
  if (Buffer.byteLength(lockText) > PACKAGE_MAX_LOCK_TEXT_BYTES) throw buildFailed('npm lockfile is too large');
  return {
    version: lock.version,
    source: { registry, resolved: lock.resolved },
    integrity: lock.integrity,
    lockText,
    lockSha256: createHash('sha256').update(lockText).digest('hex'),
    dependencyCount: lock.dependencyCount,
    sizeEstimateBytes: npmUnpackedSize(output.view),
    binaries: lock.binaries,
    runtime: { node: output.node, npm: output.npm, uv: null, python: null }
  };
}

const normalizePythonName = (value: string) => value.toLowerCase().replace(/[-_.]+/g, '-');
const UV_REQUIREMENT_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9._,-]*\])?==([A-Za-z0-9.+!_-]+)(\s*;[^\\]*)?\s*(\\)?$/;
const UV_HASH_LINE = /^\s+--hash=sha256:[a-f0-9]{64}\s*(\\)?$/;

export type ParsedUvLock = { version: string; dependencyCount: number; sbom: PackageSbomEntry[] };

/**
 * Validates a `uv pip compile --generate-hashes` lock: only `name==version` requirements, each followed by at
 * least one sha256 hash, so `uv pip sync --require-hashes` checks every wheel. Index options, editable or
 * direct URL references, and anything else are refused.
 */
export function parseUvLock(lockText: string, name: string): ParsedUvLock {
  const requirements: Array<{ name: string; version: string; hashes: number }> = [];
  for (const line of lockText.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) {
      const current = requirements.at(-1);
      if (!current || !UV_HASH_LINE.test(line)) throw buildFailed(`uv lock has an unexpected line ${quote(line.trim())}`);
      current.hashes += 1;
      continue;
    }
    const match = UV_REQUIREMENT_LINE.exec(line);
    if (!match) throw buildFailed(`uv lock has an unexpected line ${quote(line.trim())}`);
    requirements.push({ name: match[1]!, version: match[3]!, hashes: 0 });
  }
  for (const requirement of requirements) {
    if (requirement.hashes === 0) throw buildFailed(`uv lock does not hash-pin ${quote(requirement.name)}`);
  }
  const root = requirements.find((requirement) => normalizePythonName(requirement.name) === normalizePythonName(name));
  if (!root) throw buildFailed(`uv lock does not pin ${quote(name)}`);
  if (!RESOLVED_VERSION.test(root.version)) throw buildFailed('uv resolved an unsupported version string');
  const sbom = requirements
    .map((requirement) => ({ name: normalizePythonName(requirement.name), version: requirement.version }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  return { version: root.version, dependencyCount: requirements.length - 1, sbom };
}

export function parseUvPlanOutput(stdout: string, name: string, index: string): ParsedPlanOutput {
  const output = parseBuilderJson(stdout, UvPlanOutputSchema, 'uv plan');
  const lock = parseUvLock(output.lock, name);
  return {
    version: lock.version,
    source: { registry: index, resolved: `${index.replace(/\/+$/, '')}/${normalizePythonName(name)}/` },
    integrity: null,
    lockText: output.lock,
    lockSha256: createHash('sha256').update(output.lock).digest('hex'),
    dependencyCount: lock.dependencyCount,
    sizeEstimateBytes: output.sizeBytes,
    binaries: sortedBinaries(output.scripts, `Python distribution ${quote(name)}`),
    runtime: { node: null, npm: null, uv: uvVersionToken(output.uvVersion), python: output.pythonVersion }
  };
}

export function parseApplyRuntime(stdout: string, ecosystem: BuildablePackageEcosystem): Omit<PackageRuntime, 'imageId'> {
  const output = parseBuilderJson(stdout, ApplyRuntimeSchema, 'package build');
  if (ecosystem === 'npm') {
    if (!output.node || !output.npm) throw buildFailed('package build did not report its node and npm versions');
    return { node: output.node, npm: output.npm, uv: null, python: null };
  }
  if (!output.uv || !output.python) throw buildFailed('package build did not report its uv and Python versions');
  return { node: null, npm: null, uv: uvVersionToken(output.uv), python: output.python };
}

/* Tree verification. */

/**
 * Resolves `relativePath` inside the release the way the kernel would inside a container where the release is
 * mounted at `mountPath`, following every symlink component. Returns the resolved components, or undefined when
 * resolution leaves the release (a `..` above its root, or an absolute target outside `mountPath`) or loops.
 * A missing component is kept lexically: the kernel would fail there, so it can never lead outside.
 */
async function resolveInsideRelease(root: string, mountPath: string, relativePath: string): Promise<string[] | undefined> {
  const resolved: string[] = [];
  const pending = relativePath.split('/').filter((part) => part !== '');
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return undefined;
      resolved.pop();
      continue;
    }
    const candidate = join(root, ...resolved, part);
    const stats = await lstat(candidate).catch(() => undefined);
    if (!stats?.isSymbolicLink()) {
      resolved.push(part);
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) return undefined;
    const target = await readlink(candidate);
    if (target.startsWith('/')) {
      if (target !== mountPath && !target.startsWith(`${mountPath}/`)) return undefined;
      resolved.length = 0;
      pending.unshift(...target.slice(mountPath.length).split('/').filter((entry) => entry !== ''));
    } else {
      pending.unshift(...target.split('/').filter((entry) => entry !== ''));
    }
  }
  return resolved;
}

export type VerifiedReleaseTree = { sizeBytes: number; fileCount: number; treeDigest: string };

/**
 * Verifies a staged release with no container running. It walks with `lstat` (never following a link) and
 * refuses special files, setuid/setgid/sticky bits, symlinks that resolve outside the release, more than
 * `PACKAGE_MAX_RELEASE_ENTRIES` entries, and a `bin/` that is not exactly the plan's binaries, each resolving
 * to an executable file inside the release. A tree larger than `maxReleaseBytes` is `LIMIT_EXCEEDED`.
 */
export async function verifyReleaseTree(
  stagingDir: string,
  releaseId: string,
  binaries: readonly string[],
  maxReleaseBytes: number
): Promise<VerifiedReleaseTree> {
  assertReleaseId(releaseId);
  const mountPath = packageMountPath(releaseId);
  const rootStats = await lstat(stagingDir).catch(() => undefined);
  if (!rootStats?.isDirectory()) throw verificationFailed('staged release directory is missing');
  if ((rootStats.mode & 0o7000) !== 0) throw verificationFailed('staged release directory has a setuid, setgid, or sticky bit');
  const links: string[] = [];
  const directories = [''];
  let entries = 0;
  let bytes = 0;
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const name of await readdir(join(stagingDir, directory))) {
      entries += 1;
      if (entries > PACKAGE_MAX_RELEASE_ENTRIES) throw verificationFailed(`release has more than ${PACKAGE_MAX_RELEASE_ENTRIES} entries`);
      const relativePath = directory ? `${directory}/${name}` : name;
      const stats = await lstat(join(stagingDir, relativePath));
      if ((stats.mode & 0o7000) !== 0) throw verificationFailed(`release entry ${quote(relativePath)} has a setuid, setgid, or sticky bit`);
      if (stats.isDirectory()) {
        directories.push(relativePath);
        continue;
      }
      if (stats.isSymbolicLink()) links.push(relativePath);
      else if (!stats.isFile()) throw verificationFailed(`release entry ${quote(relativePath)} is a special file`);
      bytes += stats.size;
      if (bytes > maxReleaseBytes) {
        throw new HarnessError('LIMIT_EXCEEDED', `release exceeds PACKAGES_MAX_RELEASE_BYTES (${maxReleaseBytes} bytes)`, 507, false);
      }
    }
  }
  for (const link of links) {
    if (!(await resolveInsideRelease(stagingDir, mountPath, link))) throw verificationFailed(`release symlink ${quote(link)} resolves outside the release`);
  }
  const binStats = await lstat(join(stagingDir, 'bin')).catch(() => undefined);
  if (!binStats?.isDirectory()) throw verificationFailed('release has no bin directory');
  const expected = [...binaries].sort();
  const actual = (await readdir(join(stagingDir, 'bin'))).sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw verificationFailed(`release bin directory ${quote(actual.join(','))} does not match the planned binaries ${quote(expected.join(','))}`);
  }
  for (const name of actual) {
    const resolved = await resolveInsideRelease(stagingDir, mountPath, `bin/${name}`);
    const target = resolved ? await lstat(join(stagingDir, ...resolved)).catch(() => undefined) : undefined;
    if (!target?.isFile() || (target.mode & 0o111) === 0) throw verificationFailed(`release binary ${quote(name)} does not resolve to an executable file in the release`);
  }
  const digest = await computeFullTreeDigestAsync(stagingDir);
  if (digest.byteCount > maxReleaseBytes) {
    throw new HarnessError('LIMIT_EXCEEDED', `release exceeds PACKAGES_MAX_RELEASE_BYTES (${maxReleaseBytes} bytes)`, 507, false);
  }
  return { sizeBytes: digest.byteCount, fileCount: digest.fileCount, treeDigest: digest.bundleSha256 };
}

/** The launch-check command for one binary; release ids and binary names are validated, so it is safe to embed. */
export function launchCheckCommand(releaseId: string, binary: string): string {
  assertReleaseId(releaseId);
  if (!PACKAGE_BINARY_NAME_PATTERN.test(binary)) throw internal('package binary name is invalid');
  return `B=${packageMountPath(releaseId)}/bin/${binary}; "$B" --version || "$B" --help`;
}

/* The builder. */

export type PackageBuilderOptions = {
  executorImage: string;
  instanceId: string;
  /** PACKAGES_ROOT; scratch lives at `<root>/scratch/<id>` and applies stage at `<root>/staging/<release>`. */
  packagesRoot: string;
  /** PROVISIONING_NETWORK: the only network a builder joins. */
  provisioningNetwork: string;
  /** TOOLKIT_EGRESS_PROXY. Undefined only for hermetic tests, which also skips the CONNECT probe. */
  proxy: string | undefined;
  /** Builder timeout for plan resolution (PACKAGES_BUILD_TIMEOUT_MS); applies carry their own. */
  planTimeoutMs: number;
  npmRegistry?: string;
  pypiIndex?: string;
  /** UV_PYTHON_INSTALL_MIRROR; uv's default Python download location when absent. */
  pythonMirror?: string;
  /** Test-only override of the builder network, for a hermetic registry on an internal network. */
  network?: string;
};

type BuilderRunResult = { stdout: string; outputTail: string };

export class PackageBuilder implements PackageBuilderPort {
  private readonly npmRegistry: string;
  private readonly pypiIndex: string;
  private readonly network: string;

  constructor(private readonly options: PackageBuilderOptions) {
    if (!INSTANCE_ID.test(options.instanceId)) throw internal('package builder instance label is invalid');
    if (!isSafeBindPath(options.packagesRoot) || options.packagesRoot === '/') throw internal('PACKAGES_ROOT is invalid');
    this.npmRegistry = options.npmRegistry ?? DEFAULT_NPM_REGISTRY;
    this.pypiIndex = options.pypiIndex ?? DEFAULT_PYPI_INDEX;
    this.network = options.network ?? options.provisioningNetwork;
    for (const url of [this.npmRegistry, this.pypiIndex, ...(options.pythonMirror ? [options.pythonMirror] : [])]) parseServiceUrl(url, 'package registry');
    if (options.proxy !== undefined) parseServiceUrl(options.proxy, 'provisioning proxy', ['http:']);
    if (!NETWORK_NAME.test(this.network) || this.network === 'host') throw internal('package builder network is invalid');
  }

  async imageId(): Promise<string> {
    const result = await runDocker(['image', 'inspect', '--format', '{{.Id}}', this.options.executorImage], { timeoutMs: 15_000, maxBytes: 8_192 })
      .catch(() => undefined);
    const id = result?.stdout.trim() ?? '';
    if (!result || result.exitCode !== 0 || !IMAGE_ID.test(id)) {
      throw new HarnessError('UNAVAILABLE', 'the executor image is not available to the package builder', 503, true);
    }
    return id;
  }

  /** Hosts a builder of this ecosystem must reach through the proxy. */
  registryHosts(ecosystem: BuildablePackageEcosystem): string[] {
    if (ecosystem === 'npm') return [new URL(this.npmRegistry).hostname];
    const index = new URL(this.pypiIndex).hostname;
    const python = this.options.pythonMirror ? [new URL(this.options.pythonMirror).hostname] : [DEFAULT_PYTHON_DOWNLOAD_HOST, GITHUB_RELEASE_ASSET_HOST];
    return [...new Set([index, ...(index === 'pypi.org' ? [PYPI_FILES_HOST] : []), ...python])];
  }

  async probeRegistries(ecosystem: BuildablePackageEcosystem): Promise<void> {
    const proxy = this.options.proxy;
    if (proxy === undefined) return;
    for (const host of this.registryHosts(ecosystem)) await probeHost(proxy, host);
  }

  async resolvePlan(spec: ResolvePackagePlanSpec): Promise<ResolvedPackagePlan> {
    if (!/^pkp_/.test(spec.scratchId) || !PACKAGE_STORE_ID_PATTERN.test(spec.scratchId)) throw internal('package plan id is invalid');
    const nameIssue = packageNameIssue(spec.ecosystem, spec.name);
    if (nameIssue) throw new HarnessError('INVALID_INPUT', nameIssue, 400, false);
    // An empty uv specifier means the latest release; npm always names a spec or tag.
    const specIssue = spec.ecosystem === 'uv' && spec.requestedSpec === '' ? undefined : packageVersionSpecIssue(spec.requestedSpec);
    if (specIssue) throw new HarnessError('INVALID_INPUT', specIssue, 400, false);
    if (spec.python !== undefined && (spec.ecosystem !== 'uv' || !PACKAGE_PYTHON_VERSION_PATTERN.test(spec.python))) {
      throw new HarnessError('INVALID_INPUT', 'python is only allowed for uv and must look like 3.12', 400, false);
    }
    const imageId = await this.imageId();
    const scratchDir = await this.prepareScratch(spec.scratchId, {});
    const script = spec.ecosystem === 'npm' ? NPM_PLAN_SCRIPT : UV_PLAN_SCRIPT;
    const args = spec.ecosystem === 'npm'
      ? [spec.name, spec.requestedSpec]
      : [spec.name, uvRequirement(spec.name, spec.requestedSpec), spec.python ?? ''];
    const run = await this.runBuilder({ image: imageId, scratchDir, script, args }, {
      timeoutMs: this.options.planTimeoutMs,
      what: 'package plan',
      ...(spec.signal ? { signal: spec.signal } : {})
    });
    const parsed = spec.ecosystem === 'npm'
      ? parseNpmPlanOutput(run.stdout, spec.name, this.npmRegistry)
      : parseUvPlanOutput(run.stdout, spec.name, this.pypiIndex);
    return { ...parsed, runtime: { imageId, ...parsed.runtime } };
  }

  async build(job: PackageBuildJob): Promise<PackageBuildResult> {
    if (!/^pka_/.test(job.applyId) || !PACKAGE_STORE_ID_PATTERN.test(job.applyId)) throw internal('package apply id is invalid');
    assertReleaseId(job.releaseId);
    if (job.stagingDir !== join(this.options.packagesRoot, 'staging', job.releaseId)) throw internal('package staging directory is not the release staging path');
    const nameIssue = packageNameIssue(job.ecosystem, job.name);
    if (nameIssue) throw internal(nameIssue);
    if (job.python !== undefined && (job.ecosystem !== 'uv' || !PACKAGE_PYTHON_VERSION_PATTERN.test(job.python))) throw internal('package python version is invalid');
    const binaries = sortedBinaries(job.binaries, `package ${quote(job.name)}`);
    if (job.signal?.aborted) throw cancelled();

    const lockSha256 = createHash('sha256').update(job.lockText).digest('hex');
    let inputs: Record<string, string>;
    let sbom: PackageSbomEntry[];
    let lockDetails: { resolved?: string; integrity?: string } = {};
    if (job.ecosystem === 'npm') {
      const lockFiles = NpmLockTextSchema.safeParse(safeJson(job.lockText));
      if (!lockFiles.success) throw buildFailed('the approved npm lock is malformed');
      // Re-checked at apply time: the lock must still pin every tarball to the registry this builder uses.
      const lock = parseNpmLock(lockFiles.data.packageJson, lockFiles.data.lock, job.name, this.npmRegistry);
      if (lock.version !== job.version) throw buildFailed('the approved npm lock does not pin the planned version');
      inputs = { 'package.json': lockFiles.data.packageJson, 'package-lock.json': lockFiles.data.lock };
      sbom = lock.sbom;
      lockDetails = { resolved: lock.resolved, integrity: lock.integrity };
    } else {
      const lock = parseUvLock(job.lockText, job.name);
      if (lock.version !== job.version) throw buildFailed('the approved uv lock does not pin the planned version');
      inputs = { 'requirements.lock': job.lockText };
      sbom = lock.sbom;
    }
    if (Buffer.byteLength(JSON.stringify(sbom)) > PACKAGE_MAX_SBOM_JSON_BYTES) throw buildFailed('the dependency list is too large to record');

    await job.onPhase?.('BUILDING');
    const imageId = await this.imageId();
    await this.ownForExecutor(job.stagingDir);
    const scratchDir = await this.prepareScratch(job.applyId, inputs);
    const args = job.ecosystem === 'npm'
      ? [job.releaseId, job.lifecycleScripts ? 'allow' : 'deny', ...binaries]
      : [job.releaseId, job.python ?? '', ...binaries];
    const run = await this.runBuilder({
      image: imageId,
      scratchDir,
      staging: { source: job.stagingDir, releaseId: job.releaseId },
      script: job.ecosystem === 'npm' ? NPM_APPLY_SCRIPT : UV_APPLY_SCRIPT,
      args
    }, {
      timeoutMs: job.timeoutMs,
      what: 'package build',
      ...(job.signal ? { signal: job.signal } : {}),
      ...(job.onOutput ? { onOutput: job.onOutput } : {})
    });
    const runtime: PackageRuntime = { imageId, ...parseApplyRuntime(run.stdout, job.ecosystem) };

    await job.onPhase?.('VERIFYING');
    const tree = await verifyReleaseTree(job.stagingDir, job.releaseId, binaries, job.maxReleaseBytes);
    const launchChecks = await this.launchCheck(job.releaseId, job.stagingDir, binaries, imageId, job.signal);
    return {
      treeDigest: tree.treeDigest,
      sizeBytes: tree.sizeBytes,
      fileCount: tree.fileCount,
      sbom,
      runtime,
      provenance: {
        registry: job.ecosystem === 'npm' ? this.npmRegistry : this.pypiIndex,
        ...(lockDetails.resolved ? { resolved: lockDetails.resolved } : {}),
        ...(lockDetails.integrity ? { integrity: lockDetails.integrity } : {}),
        lockSha256,
        builderImageId: imageId,
        node: runtime.node,
        npm: runtime.npm,
        uv: runtime.uv,
        python: runtime.python,
        lifecycleScripts: job.ecosystem === 'npm' && job.lifecycleScripts,
        builtAt: new Date().toISOString()
      },
      launchChecks
    };
  }

  /**
   * Runs each binary from the staged release in a fresh toolbox container with no network and the release
   * mounted read-only at its final path. Only exit status 0 passes; the passing command is returned per binary.
   */
  async launchCheck(releaseId: string, stagingDir: string, binaries: readonly string[], image?: string, signal?: AbortSignal): Promise<Record<string, string>> {
    const target = packageMountPath(releaseId);
    const checks: Record<string, string> = {};
    for (const binary of binaries) {
      const command = launchCheckCommand(releaseId, binary);
      const result = await runToolboxCommand({
        name: toolboxContainerName(),
        image: image ?? this.options.executorImage,
        instanceId: this.options.instanceId,
        command,
        mounts: [{ source: stagingDir, target }],
        binDirs: [`${target}/bin`]
      }, { timeoutMs: PACKAGE_LAUNCH_CHECK_TIMEOUT_MS, maxOutputBytes: PACKAGE_LAUNCH_CHECK_MAX_OUTPUT_BYTES }, signal);
      if (result.exitCode !== 0) {
        const reason = result.timedOut ? 'timed out' : result.exitCode === null ? 'was stopped' : `exited ${result.exitCode}`;
        throw verificationFailed(`launch check for ${quote(binary)} ${reason} without network: ${tail(result.output, 1_000)}`);
      }
      checks[binary] = command;
    }
    return checks;
  }

  /**
   * Runs one builder container to completion, streaming stderr to `onOutput` and bounding stdout. Timeout,
   * abort, and an oversized stdout stop the container by name. Whatever happens, the container is removed by
   * exact name and its absence is confirmed before this returns, so a caller never reads a tree a builder
   * could still be writing.
   */
  private async runBuilder(
    run: { image: string; scratchDir: string; staging?: { source: string; releaseId: string }; script: string; args: readonly string[] },
    options: { timeoutMs: number; what: string; signal?: AbortSignal; onOutput?: (chunk: string) => void }
  ): Promise<BuilderRunResult> {
    if (options.signal?.aborted) throw cancelled();
    const name = builderContainerName();
    const args = buildPackageBuilderArgs({
      name,
      image: run.image,
      instanceId: this.options.instanceId,
      network: this.network,
      proxy: this.options.proxy,
      npmRegistry: this.npmRegistry,
      pypiIndex: this.pypiIndex,
      pythonMirror: this.options.pythonMirror,
      scratchDir: run.scratchDir,
      ...(run.staging ? { staging: run.staging } : {}),
      script: run.script,
      args: run.args
    });
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let outcome: { code: number | null } | { error: unknown };
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawnDocker(args);
        child.stdin.end();
        const decoder = new StringDecoder('utf8');
        let stopping: Promise<void> | undefined;
        const stop = () => {
          stopping ??= removeContainer(name).catch(() => undefined).finally(() => { child.kill(); });
        };
        const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
        const onAbort = () => { aborted = true; stop(); };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const settle = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        };
        child.stdout.on('data', (chunk: Buffer) => {
          if (overflow) return;
          if (stdoutBytes + chunk.length > PACKAGE_BUILDER_MAX_OUTPUT_BYTES) {
            overflow = true;
            stop();
            return;
          }
          stdout.push(chunk);
          stdoutBytes += chunk.length;
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrTail = Buffer.concat([stderrTail, chunk]);
          if (stderrTail.length > OUTPUT_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - OUTPUT_TAIL_BYTES);
          // The sink belongs to the caller; a throwing sink must not take down the event loop or the build.
          try { options.onOutput?.(decoder.write(chunk)); } catch { /* output forwarding is best effort */ }
        });
        child.on('error', (error) => {
          settle();
          reject(new HarnessError('UNAVAILABLE', `package builder could not start: ${error.message}`.slice(0, 2_000), 503, true));
        });
        child.on('close', (exitCode) => {
          settle();
          void (stopping ?? Promise.resolve()).then(() => resolve(exitCode));
        });
      });
      outcome = { code };
    } catch (error) {
      outcome = { error };
    }
    // Never return, and never let a caller read the tree, while a builder might still write to it.
    if (!(await removeContainerUntilGone(name))) {
      throw new HarnessError('UNAVAILABLE', 'package builder container could not be confirmed removed', 503, true);
    }
    if ('error' in outcome) throw outcome.error;
    const code = outcome.code;
    const outputTail = stderrTail.toString('utf8');
    if (aborted) throw cancelled();
    if (timedOut) throw new HarnessError('TIMEOUT', `${options.what} timed out after ${options.timeoutMs} ms`, 504, true);
    if (overflow) throw buildFailed(`${options.what} output exceeds ${PACKAGE_BUILDER_MAX_OUTPUT_BYTES} bytes`);
    // 125 is Docker's own failure to create or start the container, not the script's exit status.
    if (code === 125) throw new HarnessError('UNAVAILABLE', `package builder could not start: ${tail(outputTail)}`.slice(0, 2_000), 503, true);
    if (code !== 0) throw buildFailed(`${options.what} failed with exit code ${code ?? 'unknown'}: ${tail(outputTail)}`);
    return { stdout: Buffer.concat(stdout).toString('utf8'), outputTail };
  }

  private scratchPath(id: string): string {
    if (!PACKAGE_STORE_ID_PATTERN.test(id)) throw internal('package scratch id is invalid');
    return join(this.options.packagesRoot, 'scratch', id);
  }

  /**
   * Ensures `<root>/scratch/<id>` exists (the service normally creates it) and writes the input files under
   * `input/`, all owned by the executor user. The service owns the scratch directory's removal.
   */
  private async prepareScratch(id: string, inputs: Record<string, string>): Promise<string> {
    const scratchDir = this.scratchPath(id);
    await mkdir(join(scratchDir, 'input'), { recursive: true, mode: 0o755 });
    for (const [file, content] of Object.entries(inputs)) await writeFile(join(scratchDir, 'input', file), content, { mode: 0o644 });
    await this.ownForExecutor(scratchDir, [join(scratchDir, 'input'), ...Object.keys(inputs).map((file) => join(scratchDir, 'input', file))]);
    return scratchDir;
  }

  /**
   * Gives `directory` (and the listed paths inside it) to uid 10001 with mode 0755 so the unprivileged builder
   * can write there. A runner without CHOWN falls back to a root helper container scoped to that directory.
   */
  private async ownForExecutor(directory: string, inside: readonly string[] = []): Promise<void> {
    try {
      for (const path of [directory, ...inside]) {
        const stats = await lstat(path);
        // Already prepared by the service (or an earlier call): leave ownership exactly as it is.
        if (stats.uid === 10001 && stats.gid === 10001) continue;
        await chown(path, 10001, 10001);
      }
      if (((await lstat(directory)).mode & 0o7777) !== 0o755) await chmod(directory, 0o755);
    } catch {
      await this.runHelper(directory, 'chown -R 10001:10001 /job && chmod 0755 /job');
    }
  }

  private async runHelper(directory: string, command: string): Promise<void> {
    if (!isSafeBindPath(directory)) throw internal('package helper mount path is invalid');
    const name = `chm-pkghelper-${randomBytes(8).toString('hex')}`;
    try {
      const result = await runDocker([
        'run', '--rm', '--pull', 'never', '--name', name,
        '--label', 'cloud-harness.role=package-helper', '--label', 'cloud-harness.ephemeral=true',
        '--label', `cloud-harness.instance=${this.options.instanceId}`,
        '--network', 'none', '--user', '0:0', '--read-only', '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
        '--mount', `type=bind,source=${directory},target=/job`,
        '--entrypoint', '/bin/sh', this.options.executorImage, '-c', command
      ], { timeoutMs: HELPER_TIMEOUT_MS, maxBytes: 8_192 });
      if (result.exitCode !== 0) {
        throw new HarnessError('UNAVAILABLE', `package directory preparation failed: ${tail(result.stderr || result.stdout, 500)}`, 503, true);
      }
    } finally {
      await removeContainer(name).catch(() => undefined);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

