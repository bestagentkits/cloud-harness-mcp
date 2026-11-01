/**
 * A host-side stand-in for `apps/runner/src/docker-engine.ts`, used only by the multi-repository
 * benchmark on hosts without Docker.
 *
 * Instead of starting containers it runs the same trusted helpers the containers would run, on the
 * host, with each bind mount translated to its host path:
 * - `clone-helper.sh` (open and repository add clones) runs as-is with the runner's arguments.
 * - The repository-cache mirror helper runs its own `bash -c` script with `/cache` mapped.
 * - `worker-runner.sh` calls run `worker/harness-worker.mjs` in a fresh Node process rooted at the
 *   mapped `/workspace` (or scoped `CH_WORKSPACE_ROOT`), and container paths in its output are mapped
 *   back so the runner's path handling sees what it would see in production.
 * - `du` size probes run the real `du` against the mapped paths.
 * Every other Docker call (executor create/start/pause, network, inspect, cleanup) succeeds as a no-op,
 * so the measured numbers exclude container start, `docker exec`, and cgroup/seccomp overhead.
 *
 * Repository URLs are mapped to local bare fixtures through `shim.fixtureUrls`; the workspace keeps
 * the credential-free HTTPS URL it was opened with.
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { CommandResult } from '../../../apps/runner/src/docker-engine.js';

const workerDirectory = fileURLToPath(new URL('../../../worker/', import.meta.url));

export type ShimCounters = { clones: number; referenceClones: number; cacheMirrors: number; workers: number; sizeProbes: number; noops: number };

export const shim = {
  /** HTTPS repository URL the workspace was opened with -> `file://` URL of its local bare fixture. */
  fixtureUrls: new Map<string, string>(),
  /** Executor container name -> host path of the workspace tree mounted at `/workspace`. */
  containers: new Map<string, string>(),
  /** A private HOME for helper Git processes, so the host user's Git configuration never applies. */
  gitHome: '',
  counters: { clones: 0, referenceClones: 0, cacheMirrors: 0, workers: 0, sizeProbes: 0, noops: 0 } as ShimCounters,
  /** Wall time of each clone-helper and cache-mirror run since the last reset, in milliseconds. */
  helperMs: { clone: [] as number[], cacheMirror: [] as number[] },
  resetCounters(): void {
    for (const key of Object.keys(this.counters) as Array<keyof ShimCounters>) this.counters[key] = 0;
    this.helperMs.clone = [];
    this.helperMs.cacheMirror = [];
  }
};

type Mount = { host: string; container: string };

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) if (args[index] === option) values.push(args[index + 1]!);
  return values;
}

function mountsOf(args: readonly string[]): Mount[] {
  return optionValues(args, '--volume').map((value) => {
    // `<host>:<container>[:mode]`; the host side is an absolute POSIX path on the hosts this runs on.
    const [host, container] = value.split(':');
    if (!host || !container) throw new Error(`unsupported volume ${value}`);
    return { host, container };
  });
}

/** Maps a container path through the longest matching mount; throws for a path no mount covers. */
function toHost(path: string, mounts: readonly Mount[]): string {
  const match = mounts
    .filter((mount) => path === mount.container || path.startsWith(`${mount.container}/`))
    .sort((left, right) => right.container.length - left.container.length)[0];
  if (!match) throw new Error(`no mount covers ${path}`);
  return `${match.host}${path.slice(match.container.length)}`;
}

function fixtureUrl(url: string): string {
  const mapped = shim.fixtureUrls.get(url);
  if (!mapped) throw new Error(`no local fixture for ${url}`);
  return mapped;
}

function helperEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: shim.gitHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra
  };
}

function run(command: string, args: readonly string[], options: { stdin?: string | undefined; cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1, truncated: false });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
}

async function cloneHelper(args: readonly string[], stdin: string | undefined): Promise<CommandResult> {
  const index = args.indexOf('/opt/harness/clone-helper.sh');
  // `--entrypoint <script> <image> <url> <destination> <ref> <cache> <history>`
  const [url, destination, ref, cache, history] = args.slice(index + 2);
  const mounts = mountsOf(args);
  shim.counters.clones += 1;
  if (cache) shim.counters.referenceClones += 1;
  const start = performance.now();
  const result = await run('bash', [
    `${workerDirectory}clone-helper.sh`, fixtureUrl(url!), toHost(destination!, mounts), ref ?? '', cache ? toHost(cache, mounts) : '', history ?? ''
  ], { stdin, env: helperEnvironment() });
  shim.helperMs.clone.push(performance.now() - start);
  return result;
}

async function cacheMirrorHelper(args: readonly string[], stdin: string | undefined): Promise<CommandResult> {
  const script = args[args.indexOf('-c') + 1]!;
  const [, url, hash] = args.slice(args.indexOf('-c') + 2);
  const cacheMount = mountsOf(args).find((mount) => mount.container === '/cache');
  if (!cacheMount || !script.includes('"/cache/$2.git"')) throw new Error('unexpected cache helper shape');
  shim.counters.cacheMirrors += 1;
  const start = performance.now();
  const result = await run('bash', ['-c', script.replace('"/cache/$2.git"', `"${cacheMount.host}/$2.git"`), 'cache-helper', fixtureUrl(url!), hash!], { stdin, env: helperEnvironment() });
  shim.helperMs.cacheMirror.push(performance.now() - start);
  return result;
}

/** The `/workspace` mount of an executor exec or a helper run. */
function workspaceMounts(args: readonly string[]): Mount[] {
  if (args[0] === 'exec') {
    const container = args.find((value) => shim.containers.has(value));
    if (!container) throw new Error('exec targets an unknown executor');
    return [{ host: shim.containers.get(container)!, container: '/workspace' }];
  }
  return mountsOf(args);
}

async function workerRunner(args: readonly string[], stdin: string | undefined): Promise<CommandResult> {
  const mounts = workspaceMounts(args);
  const tree = mounts.find((mount) => mount.container === '/workspace');
  if (!tree) throw new Error('worker call without a /workspace mount');
  const scopedRoot = optionValues(args, '--env').find((value) => value.startsWith('CH_WORKSPACE_ROOT='))?.slice('CH_WORKSPACE_ROOT='.length) ?? '/workspace';
  const root = toHost(scopedRoot, mounts);
  shim.counters.workers += 1;
  const environment: NodeJS.ProcessEnv = { ...process.env, HARNESS_WORKSPACE_ROOT: root, CH_WORKSPACE_ROOT: root, HOME: shim.gitHome };
  // The worker only runs its CLI entry point outside vitest.
  delete environment.VITEST;
  const result = await run(process.execPath, [`${workerDirectory}harness-worker.mjs`], { stdin, cwd: root, env: environment });
  return { ...result, stdout: result.stdout.split(tree.host).join('/workspace') };
}

async function sizeProbe(args: readonly string[]): Promise<CommandResult> {
  const mounts = args[0] === 'exec' ? workspaceMounts(args) : mountsOf(args);
  const paths = args.slice(args.indexOf('/usr/bin/du') + 1).filter((value) => value.startsWith('/'))
    .filter((value) => mounts.some((mount) => value === mount.container || value.startsWith(`${mount.container}/`)));
  shim.counters.sizeProbes += 1;
  return await run('du', ['-sb', '--apparent-size', ...paths.map((path) => toHost(path, mounts))], { env: helperEnvironment() });
}

export async function runDocker(args: string[], options: { stdin?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; abortKillGraceMs?: number } = {}): Promise<CommandResult> {
  if (args.includes('/opt/harness/clone-helper.sh')) return await cloneHelper(args, options.stdin);
  if (args.includes('/opt/harness/worker-runner.sh')) return await workerRunner(args, options.stdin);
  if (args.includes('/usr/bin/du')) return await sizeProbe(args);
  if (args.includes('cache-helper') && args.includes('/bin/bash')) return await cacheMirrorHelper(args, options.stdin);
  if (args[0] === 'create') {
    const name = optionValues(args, '--name')[0];
    const tree = mountsOf(args).find((mount) => mount.container === '/workspace');
    if (name && tree) shim.containers.set(name, tree.host);
    return { stdout: `${name ?? 'executor'}\n`, stderr: '', exitCode: 0, truncated: false };
  }
  shim.counters.noops += 1;
  return { stdout: '', stderr: '', exitCode: 0, truncated: false };
}

export function spawnDocker(): never {
  throw new Error('interactive Docker sessions are outside the multi-repository benchmark');
}

export async function terminateContainerProcessGroup(): Promise<void> {}
export async function removeContainer(): Promise<void> {}
export async function inspectContainer(): Promise<Record<string, unknown> | undefined> { return undefined; }
export async function inspectNetwork(): Promise<Record<string, unknown> | undefined> { return undefined; }
