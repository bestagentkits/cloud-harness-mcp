import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDocker } from '../src/docker-engine.js';

/**
 * Docker lane for the compatibility launchers. These assertions only hold inside the real image: they
 * depend on where the launchers are installed, on PATH coming from the image profile script, and on
 * the workspace genuinely having no network.
 *
 * The profile script is only read by bash as a login shell, so the commands below run through
 * `bash -lc`. A `sh -lc` would silently skip it, because Debian's /bin/sh is dash, and the test would
 * then measure npm's behaviour instead of the dispatcher's.
 */
const executorImage = 'cloud-harness-executor:local';

let root: string;
let catalogRoot: string;
let workRoot: string;

const SKILL_MD = '# TDD\n\nWrite the test first.\n';

function sh(script: string, options: { network?: 'none' } = {}) {
  return runDocker([
    'run', '--rm', '--pull', 'never',
    '--label', 'cloud-harness.role=test', '--label', 'cloud-harness.ephemeral=true',
    '--network', options.network ?? 'none',
    '--user', '10001:10001',
    '--volume', `${catalogRoot}:/opt/cloud-harness:ro`,
    '--volume', `${workRoot}:/workspace`,
    '--workdir', '/workspace',
    '--entrypoint', '/bin/bash',
    executorImage,
    '-lc', script
  ], { timeoutMs: 120_000, maxBytes: 262_144 });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cloud-harness-cli-docker-'));
  catalogRoot = join(root, 'catalog');
  workRoot = join(root, 'workspace');
  mkdirSync(join(catalogRoot, 'owner-skills', 'tdd'), { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(join(catalogRoot, 'owner-skills', 'tdd', 'SKILL.md'), SKILL_MD);
  writeFileSync(join(catalogRoot, 'skill-catalog.json'), JSON.stringify({
    skills: [{ name: 'tdd', repository: 'mattpocock/skills', description: 'test driven development', path: 'owner-skills/tdd' }]
  }));
  // The container runs as the unprivileged workspace user, so the mounted work directory has to be
  // writable by that user rather than by whoever created it on the host.
  chmodSync(workRoot, 0o777);
}, 30_000);

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore cleanup error */ }
});

describe('executor CLI compatibility', () => {
  it('resolves npx to the dispatcher while the real npm stays reachable', async () => {
    const resolved = await sh('command -v npx && ls -l /usr/local/bin/npx');
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stdout).toContain('/opt/harness/bin/npx');
    expect(resolved.stdout).toContain('/usr/local/bin/npx');
  }, 120_000);

  it('installs a mirrored skill with no network and no DNS attempt', async () => {
    const result = await sh('skills add mattpocock/skills --skill tdd -y && cat .cloud-harness/skills/tdd/SKILL.md');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Write the test first');
    expect(result.stderr).not.toMatch(/EAI_AGAIN|getaddrinfo|ENETUNREACH|Temporary failure in name resolution/);
  }, 120_000);

  it('produces identical output through the npx dispatcher and the direct binary', async () => {
    await sh('rm -rf .cloud-harness');
    const direct = await sh('skills add mattpocock/skills --skill tdd -y');
    await sh('rm -rf .cloud-harness');
    const dispatched = await sh('npx skills add mattpocock/skills --skill tdd -y');

    expect(dispatched.exitCode).toBe(direct.exitCode);
    expect(dispatched.stdout).toBe(direct.stdout);
  }, 120_000);

  it('prints the instructions snapshot through skillx', async () => {
    const result = await sh('skillx use tdd --raw');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Write the test first');
  }, 120_000);

  it('reaches the local launcher through the skillx-sh alias', async () => {
    const result = await sh('npx skillx-sh use tdd --raw');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Write the test first');
  }, 120_000);

  it('fails closed with CACHE_MISS for a skill that is not mirrored', async () => {
    const result = await sh('skills add unmirrored/repo -y');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('CACHE_MISS');
    expect(result.stderr).toMatch(/import it from the dashboard skills page/i);
  }, 120_000);

  it('reaches the real npm through delegation for an unrelated command', async () => {
    const result = await sh('npx --version');

    expect(result.exitCode).toBe(0);
    // npm's version string is what the delegated real npx prints, which is what proves the
    // dispatcher forwarded the vector instead of answering for it.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 120_000);
});
