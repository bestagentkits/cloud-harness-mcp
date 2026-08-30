import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerOperation, RunnerResponse } from '@cloud-harness/contracts';
import { buildLocalEnvironment } from './local-environment.js';

function findWorkerScript(): string {
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : fileURLToPath(new URL('.', import.meta.url));

  const candidates = [
    resolve(currentDir, '../../../../worker/harness-worker.mjs'),
    resolve(currentDir, '../../../worker/harness-worker.mjs'),
    resolve(currentDir, '../../worker/harness-worker.mjs'),
    resolve(process.cwd(), 'worker/harness-worker.mjs')
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolve(process.cwd(), 'worker/harness-worker.mjs');
}

export class LocalWorkerClient {
  private readonly workerScript: string;

  constructor(
    private readonly canonicalRoot: string,
    workerScriptPath?: string
  ) {
    this.workerScript = workerScriptPath ?? findWorkerScript();
  }

  async call(
    operation: RunnerOperation,
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RunnerResponse> {
    if (signal?.aborted) {
      return {
        ok: false,
        message: 'operation aborted',
        error: { code: 'INVALID_INPUT', message: 'operation aborted', retryable: false },
        truncated: false
      };
    }

    return await new Promise<RunnerResponse>((resolvePromise) => {
      const env = {
        ...buildLocalEnvironment(),
        HARNESS_WORKSPACE_ROOT: this.canonicalRoot,
        ...(process.env.CH_OWNER_SKILLS_ROOT ? { CH_OWNER_SKILLS_ROOT: process.env.CH_OWNER_SKILLS_ROOT } : {}),
        ...(process.env.CH_BUILTIN_SKILLS_ROOT ? { CH_BUILTIN_SKILLS_ROOT: process.env.CH_BUILTIN_SKILLS_ROOT } : {})
      };

      const child = spawn(process.execPath, [this.workerScript], {
        cwd: this.canonicalRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
      });

      const onAbort = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000).unref();
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('close', (exitCode) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }

        if (signal?.aborted) {
          resolvePromise({
            ok: false,
            message: 'operation aborted',
            error: { code: 'INVALID_INPUT', message: 'operation aborted', retryable: false },
            truncated: false
          });
          return;
        }

        if (exitCode !== 0 && stdout.length === 0) {
          const errText = stderr.toString('utf8').trim() || `worker exited with code ${exitCode}`;
          resolvePromise({
            ok: false,
            message: errText,
            error: { code: 'INVALID_INPUT', message: errText, retryable: false },
            truncated: false
          });
          return;
        }

        try {
          const text = stdout.toString('utf8').trim();
          const parsed = JSON.parse(text) as RunnerResponse;
          resolvePromise(parsed);
        } catch (parseError: unknown) {
          const msg = parseError instanceof Error ? parseError.message : 'failed to parse worker response';
          resolvePromise({
            ok: false,
            message: msg,
            error: { code: 'INVALID_INPUT', message: msg, retryable: false },
            truncated: false
          });
        }
      });

      child.on('error', (err) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolvePromise({
          ok: false,
          message: err.message,
          error: { code: 'INVALID_INPUT', message: err.message, retryable: false },
          truncated: false
        });
      });

      child.stdin.end(JSON.stringify({ operation, input }));
    });
  }
}
