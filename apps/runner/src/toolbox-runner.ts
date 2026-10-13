import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import { removeContainer } from './docker-engine.js';

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

/** PATH matching the executor's, minus the checkout-local `node_modules/.bin` the toolbox does not have. */
export const TOOLBOX_PATH = '/opt/user-tools/bin:/opt/user-tools/pnpm/bin:/opt/user-tools/pnpm:/opt/user-tools/bun/bin:/tmp/cloud-harness-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

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

function mountArgs(mount: ToolboxMount): string[] {
  for (const path of [mount.source, mount.target]) {
    // `--mount` is comma-separated, so a comma, quote, or control character could inject options.
    if (!isAbsolute(path) || hasUnsafeMountCharacter(path) || path.split('/').includes('..')) {
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
 * Builds the `docker run` argv for one toolbox command. The container has the executor hardening, no
 * network, no workspace checkout, no secrets, and no Docker socket; only `spec.mounts` are added, read-only.
 */
export function buildToolboxRunArgs(spec: ToolboxRunSpec): string[] {
  if (!CONTAINER_NAME.test(spec.name)) throw new HarnessError('INTERNAL_ERROR', 'toolbox container name is invalid', 500, false);
  if (!INSTANCE_ID.test(spec.instanceId)) throw new HarnessError('INTERNAL_ERROR', 'toolbox instance label is invalid', 500, false);
  return [
    'run', '--rm', '--pull', 'never', '--name', spec.name,
    '--label', 'cloud-harness.role=toolbox', '--label', 'cloud-harness.ephemeral=true',
    '--label', `cloud-harness.instance=${spec.instanceId}`,
    ...EXECUTOR_HARDENING_ARGS,
    '--network', 'none',
    '--workdir', '/tmp',
    ...(spec.mounts ?? []).flatMap(mountArgs),
    '--env', 'HOME=/tmp/cloud-harness-home',
    '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'XDG_CONFIG_HOME=/tmp/cloud-harness-home/.config',
    '--env', 'XDG_CACHE_HOME=/tmp/cloud-harness-home/.cache',
    '--env', `PATH=${TOOLBOX_PATH}`,
    spec.image,
    '/bin/bash', '-c', spec.command
  ];
}

/**
 * Runs one toolbox command and always removes its container by exact name. stdout and stderr share one
 * bounded buffer, as in the workspace executor. Reaching the output bound or the timeout stops the
 * container; an abort stops it and rejects with `CANCELLED`.
 */
export async function runToolboxCommand(
  spec: ToolboxRunSpec,
  limits: { timeoutMs: number; maxOutputBytes: number },
  signal?: AbortSignal
): Promise<ToolboxRunResult> {
  const args = buildToolboxRunArgs(spec);
  if (signal?.aborted) throw new HarnessError('CANCELLED', 'request cancelled', 499, false);
  try {
    return await new Promise<ToolboxRunResult>((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= removeContainer(spec.name).catch(() => undefined).finally(() => { child.kill(); });
      };
      const append = (chunk: Buffer) => {
        const remaining = Math.max(0, limits.maxOutputBytes - output.length);
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)]);
        if (truncated) stop();
      };
      const onAbort = () => { aborted = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, limits.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new HarnessError('UNAVAILABLE', `toolbox could not start: ${error.message}`.slice(0, 2_000), 503, true));
      });
      child.on('close', (code, closeSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        void (stopping ?? Promise.resolve()).then(() => {
          if (aborted) {
            reject(new HarnessError('CANCELLED', 'request cancelled', 499, false));
            return;
          }
          resolve({
            output: output.toString('utf8'),
            exitCode: timedOut ? null : code,
            signal: closeSignal,
            truncated,
            timedOut
          });
        });
      });
    });
  } finally {
    await removeContainer(spec.name).catch(() => undefined);
  }
}
