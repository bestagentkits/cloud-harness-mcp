import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * A hermetic npm registry, PEP 503 index, and uv Python mirror for the package builder Docker suite. The
 * registry runs from the executor image on an internal Docker network (no route out), so builders that join
 * that network can only ever reach the fixtures, never the public registries or a proxy.
 */
const fixturesDir = fileURLToPath(new URL('./fixtures/packages', import.meta.url));
/** Host cache of the managed Python archive the uv mirror serves; downloaded once, outside the repository tree. */
export const pythonArchiveCache = resolve(process.cwd(), '.cloud-harness-test-fixtures', 'packages', 'python');
export const REGISTRY_ORIGIN = 'http://fake-registry:4873';
const FIXTURE_LABEL = 'cloud-harness.test=package-registry';
const PYTHON_MINOR = '3.12';
const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;

export type PackageRegistryFixture = {
  network: string;
  container: string;
  npmRegistry: string;
  pypiIndex: string;
  pythonMirror: string;
};

const PythonDownloads = z.array(z.object({
  implementation: z.string(),
  version: z.string(),
  variant: z.string().optional(),
  url: z.string().nullable().optional()
}).passthrough());

function docker(args: readonly string[], timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Makes sure the CPython archive `uv python install 3.12` would download is cached on the host, so the
 * fake mirror can serve it. Returns a prerequisite issue string instead of throwing, for `describe.skipIf`
 * and `requireDockerPrerequisites`.
 */
export function pythonArchivePrerequisiteIssue(image: string): string | undefined {
  const listed = docker([
    'run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'uv', image,
    'python', 'list', '--only-downloads', '--output-format', 'json'
  ]);
  if (listed.status !== 0) return 'the executor image cannot list uv Python downloads';
  let downloads: z.infer<typeof PythonDownloads>;
  try {
    downloads = PythonDownloads.parse(JSON.parse(listed.stdout));
  } catch {
    return 'uv python list returned unexpected output';
  }
  // uv lists the newest patch first; `uv python install 3.12` picks that same default-variant build.
  const pick = downloads.find((entry) => entry.implementation === 'cpython'
    && (entry.version === PYTHON_MINOR || entry.version.startsWith(`${PYTHON_MINOR}.`))
    && (entry.variant ?? 'default') === 'default'
    && typeof entry.url === 'string');
  if (!pick?.url) return `uv lists no CPython ${PYTHON_MINOR} download for this platform`;
  const [tag, file] = new URL(pick.url).pathname.split('/').slice(-2).map((segment) => decodeURIComponent(segment));
  if (!tag || !file || !SAFE_SEGMENT.test(tag) || !SAFE_SEGMENT.test(file)) return 'the uv Python download URL has an unexpected shape';
  const target = join(pythonArchiveCache, tag, file);
  if (existsSync(target)) return undefined;
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const fetched = spawnSync('curl', ['-fsSL', '--retry', '3', '--output', partial, pick.url], { stdio: 'ignore', timeout: 300_000 });
  if (fetched.status !== 0) {
    rmSync(partial, { force: true });
    return `the CPython ${PYTHON_MINOR} archive could not be downloaded for the fake Python mirror`;
  }
  renameSync(partial, target);
  return undefined;
}

/** Starts the fake registry on a fresh internal network and waits until it answers. */
export async function startPackageRegistry(image: string): Promise<PackageRegistryFixture> {
  const suffix = randomBytes(6).toString('hex');
  const network = `chm-pkgtest-${suffix}`;
  const container = `chm-pkgregistry-${suffix}`;
  const fixture: PackageRegistryFixture = {
    network,
    container,
    npmRegistry: `${REGISTRY_ORIGIN}/`,
    pypiIndex: `${REGISTRY_ORIGIN}/simple`,
    pythonMirror: `${REGISTRY_ORIGIN}/python`
  };
  try {
    const created = docker(['network', 'create', '--internal', '--label', FIXTURE_LABEL, network]);
    if (created.status !== 0) throw new Error(`could not create the registry network: ${created.stderr.trim()}`);
    const started = docker([
      'run', '--detach', '--pull', 'never', '--name', container, '--label', FIXTURE_LABEL,
      '--network', network, '--network-alias', 'fake-registry',
      '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp:rw,mode=1777',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${fixturesDir},target=/fixtures,readonly`,
      '--mount', `type=bind,source=${pythonArchiveCache},target=/python-archives,readonly`,
      '--env', 'FIXTURES_DIR=/fixtures', '--env', 'PYTHON_ARCHIVES_DIR=/python-archives',
      '--entrypoint', 'node', image, '/fixtures/fake-registry.mjs'
    ]);
    if (started.status !== 0) throw new Error(`could not start the fake registry: ${started.stderr.trim()}`);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ready = docker([
        'exec', container, 'node', '-e',
        "fetch('http://127.0.0.1:4873/-/ping').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      ], 10_000);
      if (ready.status === 0) return fixture;
      const state = docker(['inspect', '--format', '{{.State.Running}}', container], 10_000);
      if (state.stdout.trim() !== 'true') break;
      await delay(250);
    }
    const logs = docker(['logs', '--tail', '50', container], 10_000);
    throw new Error(`the fake registry did not become ready: ${`${logs.stdout}${logs.stderr}`.trim().slice(-2_000)}`);
  } catch (error) {
    stopPackageRegistry(fixture);
    throw error;
  }
}

/** Removes exactly the registry container and network this fixture created. */
export function stopPackageRegistry(fixture: Pick<PackageRegistryFixture, 'network' | 'container'>): void {
  docker(['rm', '--force', fixture.container], 30_000);
  docker(['network', 'rm', fixture.network], 30_000);
}

/**
 * Removes a test directory whose contents the builder wrote as uid 10001, which the host test user may not be
 * able to delete. A root helper with no network removes only the bind-mounted directory's contents.
 */
export function removeTreeAsRoot(image: string, directory: string): void {
  if (!existsSync(directory)) return;
  docker([
    'run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${directory},target=/cleanup`,
    '--entrypoint', 'find', image, '/cleanup', '-mindepth', '1', '-delete'
  ], 120_000);
  rmSync(directory, { recursive: true, force: true });
}

// Polls real container readiness; fake timers cannot drive external Docker state.
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, milliseconds);
  return promise;
}
