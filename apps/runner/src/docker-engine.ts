import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HarnessError } from '@cloud-harness/contracts';

export type CommandResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };

export async function runDocker(args: string[], options: {
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  abortKillGraceMs?: number;
} = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - Buffer.byteLength(current));
      if (chunk.length > remaining) truncated = true;
      return remaining > 0 ? current + chunk.subarray(0, remaining).toString('utf8') : current;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); if (truncated) child.kill(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); if (truncated) child.kill(); });
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => {
      if ((options.abortKillGraceMs ?? 0) > 0) {
        const forcedKill = setTimeout(() => child.kill(), options.abortKillGraceMs);
        forcedKill.unref();
      } else child.kill();
      fail(new HarnessError('CANCELLED', 'Docker operation cancelled', 499, false));
    };
    child.on('error', fail);
    const timer = setTimeout(() => { child.kill(); fail(new HarnessError('TIMEOUT', 'Docker operation timed out', 504, true)); }, timeoutMs);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ stdout, stderr, exitCode: code ?? 1, truncated });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
  });
}

export function spawnDocker(args: string[]): ChildProcessWithoutNullStreams {
  return spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

export async function terminateContainerProcessGroup(container: string, pidFile: string): Promise<void> {
  const result = await runDocker([
    'exec', container, '/bin/bash', '-c',
    'pid_file=$1; for _ in {1..20}; do if test -r "$pid_file"; then mapfile -t pids < "$pid_file"; for ((i=${#pids[@]}-1; i>=0; i--)); do [[ ${pids[$i]} =~ ^[0-9]+$ ]] && kill -TERM -- "-${pids[$i]}" 2>/dev/null || true; done; for _ in {1..20}; do alive=0; for pid in "${pids[@]}"; do [[ $pid =~ ^[0-9]+$ ]] && kill -0 -- "-$pid" 2>/dev/null && alive=1; done; ((alive == 0)) && { rm -f -- "$pid_file"; exit 0; }; sleep 0.05; done; for pid in "${pids[@]}"; do [[ $pid =~ ^[0-9]+$ ]] && kill -KILL -- "-$pid" 2>/dev/null || true; done; for _ in {1..20}; do alive=0; for pid in "${pids[@]}"; do [[ $pid =~ ^[0-9]+$ ]] && kill -0 -- "-$pid" 2>/dev/null && alive=1; done; ((alive == 0)) && { rm -f -- "$pid_file"; exit 0; }; sleep 0.05; done; exit 1; fi; sleep 0.025; done; exit 1',
    'process-cancel', pidFile
  ], { timeoutMs: 10_000, maxBytes: 8_192 });
  if (result.exitCode !== 0) throw new HarnessError('UNAVAILABLE', 'container process group could not be terminated', 503, true);
}

export async function removeContainer(name: string): Promise<void> {
  const result = await runDocker(['rm', '--force', name], { timeoutMs: 30_000 });
  if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
    throw new HarnessError('UNAVAILABLE', 'Docker could not remove the workspace container', 503, true);
  }
}

export async function inspectContainer(name: string): Promise<Record<string, unknown> | undefined> {
  const result = await runDocker(['inspect', name], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return undefined;
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>[];
  return parsed[0];
}

export async function inspectNetwork(name: string): Promise<Record<string, unknown> | undefined> {
  const result = await runDocker(['network', 'inspect', name], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>[];
    return parsed[0];
  } catch {
    return undefined;
  }
}
