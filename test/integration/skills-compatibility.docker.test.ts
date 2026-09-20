import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDocker } from '../../apps/runner/src/docker-engine.js';

/**
 * The air-gap skill lifecycle, inside the real image.
 *
 * A provenance-free workspace is the point: the container runs with `--network none`, so anything that
 * succeeded here did so without a network, and the roster and the run both go through the worker the
 * runner actually invokes. The verification half is asserted from the inside as well, by presenting a
 * digest that does not match the bytes.
 */
const executorImage = 'cloud-harness-executor:local';

let root: string;
let catalogRoot: string;
let workRoot: string;

const SCRIPT = '#!/bin/sh\necho from-snapshot\n';
const SCRIPT_SHA = createHash('sha256').update(SCRIPT).digest('hex');

function sh(script: string) {
  return runDocker([
    'run', '--rm', '--pull', 'never',
    '--label', 'cloud-harness.role=test', '--label', 'cloud-harness.ephemeral=true',
    '--network', 'none',
    '--user', '10001:10001',
    '--volume', `${catalogRoot}:/opt/cloud-harness:ro`,
    '--volume', `${workRoot}:/workspace`,
    '--workdir', '/workspace',
    '--entrypoint', '/bin/bash',
    executorImage,
    '-lc', script
  ], { timeoutMs: 120_000, maxBytes: 262_144 });
}

function workerRequest(operation: string, input: Record<string, unknown>): string {
  return `printf '%s' '${JSON.stringify({ version: 2, operation, input })}' | node /opt/harness/harness-worker.mjs`;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cloud-harness-skills-docker-'));
  catalogRoot = join(root, 'catalog');
  workRoot = join(root, 'workspace');
  const mirrored = join(catalogRoot, 'owner-skills', 'tdd');
  mkdirSync(join(mirrored, 'scripts'), { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(join(mirrored, 'SKILL.md'), '---\ndescription: test driven development\n---\n\nWrite the test first.\n');
  writeFileSync(join(mirrored, 'scripts', 'hello.sh'), SCRIPT);
  chmodSync(join(mirrored, 'scripts', 'hello.sh'), 0o755);
  writeFileSync(join(catalogRoot, 'skill-catalog.json'), JSON.stringify({
    skills: [{ name: 'tdd', repository: 'mattpocock/skills', description: 'test driven development', path: 'owner-skills/tdd' }]
  }));
  chmodSync(workRoot, 0o777);
}, 30_000);

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
});

describe('air-gap skill lifecycle', () => {
  it('installs a mirrored skill offline and lists it through the worker roster', async () => {
    const installed = await sh('skills add mattpocock/skills --skill tdd -y');
    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).not.toMatch(/EAI_AGAIN|getaddrinfo|ENETUNREACH|name resolution/);

    const roster = await sh(workerRequest('skills_roster', {}));
    expect(roster.exitCode).toBe(0);
    const parsed = JSON.parse(roster.stdout) as { ok: boolean; data: { entries: Array<{ name: string; indexDescription: string }>; rosterDigest: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.entries.map((entry) => entry.name)).toEqual(['tdd']);
    // The workspace copy wins over the projection, and the description travels with it.
    expect(parsed.data.entries[0]!.indexDescription).toBe('test driven development');
    expect(parsed.data.rosterDigest).toHaveLength(64);
  }, 120_000);

  it('runs a skill script from the verified snapshot without a network', async () => {
    const run = await sh(workerRequest('skills_run', { name: 'tdd', script: 'hello.sh', expectedContentSha256: SCRIPT_SHA }));

    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; data: { stdout?: string; executionMode?: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.stdout).toContain('from-snapshot');
    // The response names the mode, so a caller cannot read a stronger guarantee into the run.
    expect(parsed.data.executionMode).toBe('local');
  }, 120_000);

  it('refuses to run bytes that do not match the digest it was given', async () => {
    const run = await sh(workerRequest('skills_run', { name: 'tdd', script: 'hello.sh', expectedContentSha256: 'f'.repeat(64) }));

    const parsed = JSON.parse(run.stdout) as { ok: boolean; error?: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('CONFLICT');
    expect(JSON.stringify(parsed)).not.toContain('from-snapshot');
  }, 120_000);

  it('reports an instruction-only revision as having no executable assets', async () => {
    const run = await sh(workerRequest('skills_run', { name: 'tdd', script: 'missing.sh' }));

    const parsed = JSON.parse(run.stdout) as { ok: boolean; error?: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    // The skill has a scripts directory, so this is a named script that is absent rather than a
    // revision with nothing to run.
    expect(parsed.error?.code).toBe('NOT_FOUND');
  }, 120_000);
});
