import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { COMMAND_MAX_TIMEOUT_MS, HarnessError } from '@cloud-harness/contracts';
import { removeContainer, runDocker } from './docker-engine.js';

/**
 * Executor hardening shared by every workspace executor and every toolbox container. Keeping one list
 * means the toolbox cannot drift from the executor sandbox: unprivileged UID, read-only root, private
 * tmpfs scratch, no capabilities, no privilege escalation, and fixed pid, memory, CPU, and fd limits.
 */
export const EXECUTOR_HARDENING_ARGS: readonly string[] = Object.freeze([
  '--user', '10001:10001', '--read-only',
  '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=128m', '--tmpfs', '/run:rw,nosuid,nodev,size=8m',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
  '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--ulimit', 'nofile=1024:1024'
]);

/**
 * The executor's `--env PATH`, minus the checkout-local `node_modules/.bin` the toolbox does not have. The
 * command runs in a login shell (`bash -lc`, as `exec_run` does), so the image's `/etc/profile.d/harness.sh`
 * then puts `/opt/harness/bin`, the user-tools directories, and the managed release directories first, exactly
 * as in a workspace.
 */
export const TOOLBOX_PATH = '/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Seconds the in-container deadline allows beyond the caller's timeout, so the runner's own timer fires first. */
const DEADLINE_MARGIN_SECONDS = 2;
/** Seconds coreutils `timeout` waits after SIGTERM before it sends SIGKILL. */
const DEADLINE_KILL_AFTER_SECONDS = 5;
const CREATE_TIMEOUT_MS = 30_000;
/** Bound on verifying that a toolbox container is gone; whatever survives it is left to the periodic sweep. */
const REMOVAL_VERIFY_MS = 10_000;

/**
 * A host directory exposed read-only inside the toolbox. This is the extension point for managed
 * package releases: the caller supplies verified release paths, and they are always mounted read-only.
 */
export type ToolboxMount = { source: string; target: string };

export type ToolboxRunSpec = {
  name: string;
  image: string;
  instanceId: string;
  command: string;
  mounts?: readonly ToolboxMount[];
  /**
   * Managed release `bin` directories to put on PATH. Each one must be `<target>/bin` of a mount in
   * `mounts`, so PATH can only ever name a directory from a read-only release the caller supplied.
   */
  binDirs?: readonly string[];
};

export type ToolboxRunResult = {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
  timedOut: boolean;
};

const CONTAINER_NAME = /^chm-toolbox-[a-f0-9]{16}$/;
const INSTANCE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function toolboxContainerName(): string {
  return `chm-toolbox-${randomBytes(8).toString('hex')}`;
}

function hasUnsafeMountCharacter(path: string): boolean {
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (character === ',' || character === '"' || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `path` can be used as one side of a `--mount` bind: absolute, free of `..`, and free of the
 * comma, quote, and control characters that could inject options into the comma-separated `--mount` value.
 */
export function isSafeBindPath(path: string): boolean {
  return isAbsolute(path) && !hasUnsafeMountCharacter(path) && !path.split('/').includes('..');
}

/** First image PATH entry managed release `bin` directories precede; everything before it still wins. */
const MANAGED_BINS_BEFORE = '/usr/local/sbin';

/**
 * Inserts managed release `bin` directories into `basePath` right before `/usr/local/sbin`, so they come
 * after the workspace-local and user-tool directories (local installs still win) and before the image's
 * own tool directories (managed releases win over image tools). An empty list returns `basePath` unchanged.
 */
export function withManagedBins(basePath: string, binDirs: readonly string[]): string {
  if (binDirs.length === 0) return basePath;
  for (const directory of binDirs) {
    // A colon would split one entry into two PATH entries; the other checks keep it a plain absolute path.
    if (!isSafeBindPath(directory) || directory.includes(':')) {
      throw new HarnessError('INTERNAL_ERROR', 'managed bin directory is invalid', 500, false);
    }
  }
  const entries = basePath.split(':');
  const index = entries.indexOf(MANAGED_BINS_BEFORE);
  if (index < 0) throw new HarnessError('INTERNAL_ERROR', `PATH has no ${MANAGED_BINS_BEFORE} entry to anchor managed bin directories`, 500, false);
  return [...entries.slice(0, index), ...binDirs, ...entries.slice(index)].join(':');
}

/**
 * A login shell (`bash -lc`, used by the toolbox and `exec_run`) runs Debian's /etc/profile, which replaces
 * PATH for a non-root user. The image's /etc/profile.d/harness.sh puts these managed release `bin` directories
 * back, after the user-tool directories and before the image's own, so precedence matches the `--env PATH`.
 */
export function managedPathEnvArgs(binDirs: readonly string[]): string[] {
  return binDirs.length === 0 ? [] : ['--env', `CLOUD_HARNESS_MANAGED_PATH=${binDirs.join(':')}`];
}

function mountArgs(mount: ToolboxMount): string[] {
  for (const path of [mount.source, mount.target]) {
    // `--mount` is comma-separated, so a comma, quote, or control character could inject options.
    if (!isSafeBindPath(path)) {
      throw new HarnessError('INTERNAL_ERROR', 'toolbox mount path is invalid', 500, false);
    }
  }
  // A mount over the root or the private scratch tmpfs would replace the sandbox's own writable space.
  if (mount.target === '/' || mount.target === '/tmp' || mount.target.startsWith('/tmp/')) {
    throw new HarnessError('INTERNAL_ERROR', 'toolbox mount target is invalid', 500, false);
  }
  return ['--mount', `type=bind,source=${mount.source},target=${mount.target},readonly`];
}

/**
 * The in-container deadline in seconds. It backs up the runner's timer: if the runner dies mid-call, the
 * command still ends instead of running until the next startup reconcile or periodic sweep.
 */
export function toolboxDeadlineSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1_000) + DEADLINE_MARGIN_SECONDS;
}

/**
 * Builds the `docker create` argv for one toolbox command. The container has the executor hardening, no
 * network, no workspace checkout, no secrets, and no Docker socket; only `spec.mounts` are added, read-only.
 * It is created without `--rm` so the runner can read its final state, and it is always removed by name.
 */
export function buildToolboxCreateArgs(spec: ToolboxRunSpec, timeoutMs: number): string[] {
  if (!CONTAINER_NAME.test(spec.name)) throw new HarnessError('INTERNAL_ERROR', 'toolbox container name is invalid', 500, false);
  if (!INSTANCE_ID.test(spec.instanceId)) throw new HarnessError('INTERNAL_ERROR', 'toolbox instance label is invalid', 500, false);
  const mounts = spec.mounts ?? [];
  const binDirs = spec.binDirs ?? [];
  for (const directory of binDirs) {
    if (!mounts.some((mount) => directory === `${mount.target}/bin`)) {
      throw new HarnessError('INTERNAL_ERROR', 'toolbox bin directory is not the bin directory of a provided mount', 500, false);
    }
  }
  return [
    'create', '--pull', 'never', '--name', spec.name,
    '--label', 'cloud-harness.role=toolbox', '--label', 'cloud-harness.ephemeral=true',
    '--label', `cloud-harness.instance=${spec.instanceId}`,
    ...EXECUTOR_HARDENING_ARGS,
    '--network', 'none',
    '--workdir', '/tmp',
    ...mounts.flatMap(mountArgs),
    '--env', 'HOME=/tmp/cloud-harness-home',
    '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'XDG_CONFIG_HOME=/tmp/cloud-harness-home/.config',
    '--env', 'XDG_CACHE_HOME=/tmp/cloud-harness-home/.cache',
    '--env', `PATH=${withManagedBins(TOOLBOX_PATH, binDirs)}`,
    ...managedPathEnvArgs(binDirs),
    spec.image,
    '/usr/bin/timeout', '-k', `${DEADLINE_KILL_AFTER_SECONDS}s`, `${toolboxDeadlineSeconds(timeoutMs)}s`,
    '/bin/bash', '-lc', spec.command
  ];
}

const cancelled = () => new HarnessError('CANCELLED', 'request cancelled', 499, false);
const unavailable = (message: string, detail: string) =>
  new HarnessError('UNAVAILABLE', `${message}${detail.trim() ? `: ${detail.trim()}` : ''}`.slice(0, 2_000), 503, true);

/** True only when Docker positively reports that the container does not exist. */
async function containerAbsent(name: string): Promise<boolean> {
  const result = await runDocker(['inspect', '--type', 'container', '--format', '{{.Id}}', name], { timeoutMs: 10_000, maxBytes: 8_192 });
  return result.exitCode !== 0 && /no such (object|container)/i.test(result.stderr);
}

/**
 * Removes the container by exact name and retries with a short backoff until Docker reports it gone. The
 * retry covers a daemon that finishes a create after an earlier removal attempt. Resolves true only once
 * Docker positively reports the container absent; false when it survives the bound. The toolbox leaves such
 * a container to the periodic sweep rather than failing the caller's result.
 */
export async function removeContainerUntilGone(name: string): Promise<boolean> {
  const deadline = Date.now() + REMOVAL_VERIFY_MS;
  let delay = 50;
  for (;;) {
    await removeContainer(name).catch(() => undefined);
    if (await containerAbsent(name).catch(() => false)) return true;
    if (Date.now() + delay > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1_000);
  }
}

type ContainerState = { started: boolean; exitCode: number };

async function containerState(name: string): Promise<ContainerState | undefined> {
  const result = await runDocker(['inspect', '--type', 'container', '--format', '{{.State.StartedAt}}\t{{.State.ExitCode}}', name], { timeoutMs: 10_000, maxBytes: 8_192 })
    .catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  const [startedAt = '', exitCode = ''] = result.stdout.trim().split('\t');
  const code = Number(exitCode);
  if (!startedAt || !Number.isInteger(code)) return undefined;
  // Docker reports a container that never started with the zero time.
  return { started: !startedAt.startsWith('0001-01-01'), exitCode: code };
}

/**
 * Runs one toolbox command. The container is created first and only then started and attached, so it
 * exists by name before any stop decision; whatever happens, it is then removed by that exact name and the
 * removal is verified. stdout and stderr share one bounded buffer, as in the workspace executor. Reaching
 * the output bound or the timeout stops the container (SIGKILL through `docker rm -f`); an abort stops it
 * and rejects with `CANCELLED`. A create or start the daemon refuses is `UNAVAILABLE`, never an exit code.
 */
export async function runToolboxCommand(
  spec: ToolboxRunSpec,
  limits: { timeoutMs: number; maxOutputBytes: number },
  signal?: AbortSignal
): Promise<ToolboxRunResult> {
  const createArgs = buildToolboxCreateArgs(spec, limits.timeoutMs);
  if (signal?.aborted) throw cancelled();
  let aborted = false;
  let timedOut = false;
  let truncated = false;
  let requestStop: (() => void) | undefined;
  const onAbort = () => { aborted = true; requestStop?.(); };
  const timer = setTimeout(() => { timedOut = true; requestStop?.(); }, limits.timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // The create is not interrupted: once it returns, the container either exists by name or was never made,
    // so an abort during it cannot leave a container the removal below has already missed.
    const created = await runDocker(createArgs, { timeoutMs: CREATE_TIMEOUT_MS, maxBytes: 65_536 }).catch((error: unknown) => {
      throw unavailable('toolbox container could not be created', error instanceof Error ? error.message : '');
    });
    if (created.exitCode !== 0) throw unavailable('toolbox container could not be created', created.stderr);
    if (aborted) throw cancelled();
    if (timedOut) return { output: '', exitCode: null, signal: null, truncated: false, timedOut: true };

    const attached = await new Promise<{ output: Buffer; code: number | null; stopped: boolean }>((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', spec.name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = Buffer.alloc(0);
      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= removeContainer(spec.name).catch(() => undefined).finally(() => { child.kill(); });
      };
      requestStop = stop;
      const append = (chunk: Buffer) => {
        const remaining = Math.max(0, limits.maxOutputBytes - output.length);
        if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)]);
        if (chunk.length > remaining) {
          truncated = true;
          stop();
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (error) => {
        requestStop = undefined;
        reject(unavailable('toolbox container could not start', error.message));
      });
      child.on('close', (code) => {
        // The command has ended: a deadline that passes from here on must not report it as timed out.
        clearTimeout(timer);
        requestStop = undefined;
        void (stopping ?? Promise.resolve()).then(() => resolve({ output, code, stopped: stopping !== undefined }));
      });
    });

    if (aborted) throw cancelled();
    const output = attached.output.toString('utf8');
    // The harness stopped the container with `docker rm -f`, which delivers SIGKILL: report that, not an exit code.
    if (attached.stopped) return { output, exitCode: null, signal: 'SIGKILL', truncated, timedOut };
    const state = await containerState(spec.name);
    // A start the daemon refused never ran the command, so its CLI status is not the command's exit code. When
    // the state cannot be read, the CLI status cannot be told apart from a refusal either, so it is not reported.
    if (!state || !state.started) throw unavailable('toolbox container could not start', output.slice(0, 500));
    return { output, exitCode: state.exitCode, signal: null, truncated, timedOut };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await removeContainerUntilGone(spec.name);
  }
}

/**
 * Age past which a toolbox container cannot belong to a live call: the longest allowed command plus its
 * create, in-container kill grace, and removal time.
 */
export const TOOLBOX_STALE_AFTER_MS = COMMAND_MAX_TIMEOUT_MS + 60_000;

/**
 * Removes this runner instance's toolbox containers that are older than `TOOLBOX_STALE_AFTER_MS` and not
 * tracked as live. It matches the exact role, ephemeral, and instance labels the toolbox sets, so it never
 * touches another instance's or another role's containers. Returns the names it removed.
 */
export async function reapStaleToolboxContainers(instanceId: string, live: ReadonlySet<string>, now = Date.now()): Promise<string[]> {
  if (!INSTANCE_ID.test(instanceId)) throw new HarnessError('INTERNAL_ERROR', 'toolbox instance label is invalid', 500, false);
  const listed = await runDocker([
    'ps', '-a', '--filter', 'label=cloud-harness.role=toolbox', '--filter', 'label=cloud-harness.ephemeral=true',
    '--filter', `label=cloud-harness.instance=${instanceId}`, '--format', '{{.Names}}'
  ], { timeoutMs: 30_000, maxBytes: 1_048_576 });
  if (listed.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'Docker toolbox inventory failed', 503, true);
  const names = listed.stdout.split('\n').map((name) => name.trim()).filter((name) => CONTAINER_NAME.test(name) && !live.has(name));
  if (names.length === 0) return [];
  // A container removed between the listing and this inspect makes the exit status non-zero, but the
  // remaining containers are still printed, so the output is parsed regardless.
  const inspected = await runDocker(['inspect', '--type', 'container', '--format', '{{.Name}}\t{{.Created}}', ...names], { timeoutMs: 30_000, maxBytes: 1_048_576 });
  const removed: string[] = [];
  for (const line of inspected.stdout.split('\n')) {
    const [rawName = '', created = ''] = line.trim().split('\t');
    const name = rawName.replace(/^\//, '');
    const createdAt = Date.parse(created);
    if (!names.includes(name) || !Number.isFinite(createdAt) || now - createdAt < TOOLBOX_STALE_AFTER_MS) continue;
    // One container Docker will not remove must not block the sweep of the others; the next pass retries it.
    try {
      await removeContainer(name);
      removed.push(name);
    } catch { /* retried on the next sweep */ }
  }
  return removed;
}
