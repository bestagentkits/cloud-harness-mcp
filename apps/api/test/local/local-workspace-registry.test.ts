import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceIdSchema } from '@cloud-harness/contracts';
import { loadLocalWorkspaceRegistry, parseLocalWorkspaceConfig, stableLocalWorkspaceId } from '../../src/local/local-workspace-registry.js';

describe('local workspace registry', () => {
  let base: string;
  let configPath: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ch-registry-')));
    configPath = join(base, 'workspaces.yaml');
    for (const name of ['vault', 'bwe', 'isekai', 'netforge']) await mkdir(join(base, name));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const write = (content: string) => writeFile(configPath, content);

  it('loads named roots from YAML with stable, valid workspace IDs', async () => {
    await write([
      'version: 1',
      'workspaces:',
      `  personalvault:\n    path: ${join(base, 'vault')}`,
      `  bwe:\n    path: ${join(base, 'bwe')}\n    gitNetwork: true`,
      `  isekaizero:\n    path: ${join(base, 'isekai')}`,
      `  netforge:\n    path: ${join(base, 'netforge')}\n    gitPush: true`
    ].join('\n'));
    const first = await loadLocalWorkspaceRegistry(configPath);
    const second = await loadLocalWorkspaceRegistry(configPath);
    expect(first.workspaces.map((w) => w.name)).toEqual(['personalvault', 'bwe', 'isekaizero', 'netforge']);
    expect(second.workspaces.map((w) => w.workspaceId)).toEqual(first.workspaces.map((w) => w.workspaceId));
    for (const workspace of first.workspaces) expect(WorkspaceIdSchema.safeParse(workspace.workspaceId).success).toBe(true);
    expect(new Set(first.workspaces.map((w) => w.workspaceId)).size).toBe(4);
    expect(first.workspaces[1]?.gitNetwork).toBe(true);
    expect(first.workspaces[3]?.gitPush).toBe(true);
    expect(first.http).toEqual({ host: '127.0.0.1', port: 3100, publicHosts: [], allowedOrigins: [] });
  });

  it('accepts JSON and resolves a symlinked path to its canonical root', async () => {
    await symlink(join(base, 'bwe'), join(base, 'bwe-link'));
    await write(JSON.stringify({ version: 1, workspaces: { bwe: { path: join(base, 'bwe-link') } }, http: { port: 4100, publicHosts: ['dev.example.test'] } }));
    const registry = await loadLocalWorkspaceRegistry(configPath);
    expect(registry.workspaces[0]?.canonicalRoot).toBe(join(base, 'bwe'));
    expect(registry.workspaces[0]?.workspaceId).toBe(stableLocalWorkspaceId('bwe', join(base, 'bwe')));
    expect(registry.http.port).toBe(4100);
  });

  it('changes the ID when a name moves to a different root, so stale IDs fail closed', () => {
    expect(stableLocalWorkspaceId('bwe', '/a')).not.toBe(stableLocalWorkspaceId('bwe', '/b'));
    expect(stableLocalWorkspaceId('a', '/r')).not.toBe(stableLocalWorkspaceId('b', '/r'));
  });

  it.each([
    ['unknown top-level field', 'version: 1\nextra: true\nworkspaces:\n  a:\n    path: /tmp'],
    ['unknown workspace field', 'version: 1\nworkspaces:\n  a:\n    path: /tmp\n    command: rm'],
    ['invalid name', 'version: 1\nworkspaces:\n  Bad Name:\n    path: /tmp'],
    ['relative path', 'version: 1\nworkspaces:\n  a:\n    path: relative/dir'],
    ['missing version', 'workspaces:\n  a:\n    path: /tmp'],
    ['no workspaces', 'version: 1\nworkspaces: {}'],
    ['duplicate names', 'version: 1\nworkspaces:\n  a:\n    path: /tmp\n  a:\n    path: /var'],
    ['YAML aliases', 'version: 1\nworkspaces:\n  a: &x\n    path: /tmp\n  b: *x']
  ])('rejects %s', (_label, source) => {
    expect(() => parseLocalWorkspaceConfig(source)).toThrow();
  });

  it('rejects a missing root', async () => {
    await write(`version: 1\nworkspaces:\n  gone:\n    path: ${join(base, 'missing')}`);
    await expect(loadLocalWorkspaceRegistry(configPath)).rejects.toThrow(/workspace "gone" path .* is unavailable/);
  });

  it('rejects a root that is a file', async () => {
    await writeFile(join(base, 'file'), 'x');
    await write(`version: 1\nworkspaces:\n  file:\n    path: ${join(base, 'file')}`);
    await expect(loadLocalWorkspaceRegistry(configPath)).rejects.toThrow(/not a directory/);
  });

  it('rejects duplicate roots, including through a symlink', async () => {
    await symlink(join(base, 'bwe'), join(base, 'alias'));
    await write(`version: 1\nworkspaces:\n  a:\n    path: ${join(base, 'bwe')}\n  b:\n    path: ${join(base, 'alias')}`);
    await expect(loadLocalWorkspaceRegistry(configPath)).rejects.toThrow(/overlaps/);
  });

  it('rejects nested roots in either order', async () => {
    await mkdir(join(base, 'bwe', 'inner'));
    await write(`version: 1\nworkspaces:\n  outer:\n    path: ${join(base, 'bwe')}\n  inner:\n    path: ${join(base, 'bwe', 'inner')}`);
    await expect(loadLocalWorkspaceRegistry(configPath)).rejects.toThrow(/overlaps/);
    await write(`version: 1\nworkspaces:\n  inner:\n    path: ${join(base, 'bwe', 'inner')}\n  outer:\n    path: ${join(base, 'bwe')}`);
    await expect(loadLocalWorkspaceRegistry(configPath)).rejects.toThrow(/overlaps/);
  });

  it('allows sibling roots that share a name prefix', async () => {
    await mkdir(join(base, 'bwe-2'));
    await write(`version: 1\nworkspaces:\n  a:\n    path: ${join(base, 'bwe')}\n  b:\n    path: ${join(base, 'bwe-2')}`);
    await expect(loadLocalWorkspaceRegistry(configPath)).resolves.toMatchObject({ workspaces: [{ name: 'a' }, { name: 'b' }] });
  });
});
