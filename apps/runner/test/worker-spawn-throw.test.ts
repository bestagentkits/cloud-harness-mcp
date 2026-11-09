import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Some exec failures (EMFILE/EAGAIN on any OS, ENOEXEC on macOS) throw synchronously from spawn()
// instead of emitting 'error'. Forcing that here makes the case reproducible on every platform.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
  }
}));

import { executeWorkerRequest, sha256 } from '../../../worker/harness-worker.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.CH_WORKSPACE_ROOT;
  for (const path of temporaryDirectories.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
  }
});

describe('worker command() synchronous spawn failure', () => {
  it('reports a failed run rather than an invalid request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-harness-spawn-throw-'));
    temporaryDirectories.push(root);
    process.env.CH_WORKSPACE_ROOT = root;
    const content = '#!/bin/sh\necho hi\n';
    const scriptsDir = join(root, '.cloud-harness', 'skills', 'tdd', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(root, '.cloud-harness', 'skills', 'tdd', 'SKILL.md'), '# TDD\n');
    writeFileSync(join(scriptsDir, 'run.sh'), content);

    const result = await executeWorkerRequest('skills_run', {
      name: 'tdd', script: 'run.sh', expectedContentSha256: sha256(content)
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_FAILED');
    expect(result.error?.code).not.toBe('INVALID_INPUT');
  });
});
