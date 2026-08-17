import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { updateReleaseVersion } from '../scripts/update-release-version.mjs';

const directories: string[] = [];

function writeJson(root: string, relativePath: string, value: unknown) {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root: string, relativePath: string) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, any>;
}

function createReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-harness-release-'));
  directories.push(root);
  const rootManifest = { name: 'cloud-harness-mcp', version: '0.2.0' };
  const contractsManifest = { name: '@cloud-harness/contracts', version: '0.2.0' };
  const apiManifest = { name: '@cloud-harness/api', version: '0.2.0', dependencies: { '@cloud-harness/contracts': '0.2.0' } };
  const runnerManifest = { name: '@cloud-harness/runner', version: '0.2.0', dependencies: { '@cloud-harness/contracts': '0.2.0' } };
  writeJson(root, 'package.json', rootManifest);
  writeJson(root, 'packages/contracts/package.json', contractsManifest);
  writeJson(root, 'apps/api/package.json', apiManifest);
  writeJson(root, 'apps/runner/package.json', runnerManifest);
  writeJson(root, 'plugins/cloud-harness/.claude-plugin/plugin.json', { name: 'cloud-harness', version: '0.2.0' });
  writeJson(root, 'plugins/cloud-harness/.codex-plugin/plugin.json', { name: 'cloud-harness', version: '0.2.0' });
  writeJson(root, '.claude-plugin/marketplace.json', { plugins: [{ name: 'cloud-harness', version: '0.2.0' }] });
  writeJson(root, 'package-lock.json', {
    name: rootManifest.name,
    version: rootManifest.version,
    lockfileVersion: 3,
    packages: { '': rootManifest, 'packages/contracts': contractsManifest, 'apps/api': apiManifest, 'apps/runner': runnerManifest }
  });
  mkdirSync(join(root, 'apps/api/src'), { recursive: true });
  writeFileSync(join(root, 'apps/api/src/mcp-server.ts'), "new McpServer({ name: 'cloud-harness-mcp', version: '0.2.0' });\n");
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release version update', () => {
  it('synchronizes stable and beta versions across release metadata', () => {
    const root = createReleaseFixture();

    updateReleaseVersion('0.3.0-beta.2', root);

    expect(readJson(root, 'package.json').version).toBe('0.3.0-beta.2');
    expect(readJson(root, 'apps/api/package.json')).toMatchObject({ version: '0.3.0-beta.2', dependencies: { '@cloud-harness/contracts': '0.3.0-beta.2' } });
    expect(readJson(root, 'apps/runner/package.json')).toMatchObject({ version: '0.3.0-beta.2', dependencies: { '@cloud-harness/contracts': '0.3.0-beta.2' } });
    expect(readJson(root, 'package-lock.json')).toMatchObject({ version: '0.3.0-beta.2', packages: { '': { version: '0.3.0-beta.2' } } });
    expect(readJson(root, 'plugins/cloud-harness/.claude-plugin/plugin.json').version).toBe('0.3.0-beta.2');
    expect(readJson(root, 'plugins/cloud-harness/.codex-plugin/plugin.json').version).toBe('0.3.0-beta.2');
    expect(readJson(root, '.claude-plugin/marketplace.json').plugins[0].version).toBe('0.3.0-beta.2');
    expect(readFileSync(join(root, 'apps/api/src/mcp-server.ts'), 'utf8')).toContain("version: '0.3.0-beta.2'");
  });

  it('rejects a non-SemVer release version', () => {
    expect(() => updateReleaseVersion('beta', createReleaseFixture())).toThrow('Invalid semantic version');
    expect(() => updateReleaseVersion('1.2.3-01', createReleaseFixture())).toThrow('Invalid semantic version');
  });
});
