import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_TOOL_SPECS, TOOL_SPECS } from '../src/index.js';

/**
 * The directory plugin is the only package meant for public distribution, so it carries the
 * Claude plugin directory's automated rules as tests: installing it must never bring a credential,
 * a default endpoint, or code that runs on the user's machine.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginRoot = join(repositoryRoot, 'plugins', 'cloud-harness-workspaces');
const skillPath = join(pluginRoot, 'skills', 'cloud-harness-workspaces', 'SKILL.md');

type Manifest = {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  author?: { name?: string };
  license?: string;
  icon?: string;
  hooks?: unknown;
  mcpServers?: unknown;
  documentationUrl?: string;
  supportUrl?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  userConfig?: Record<string, { type: string; required?: boolean; sensitive?: boolean }>;
};

const readJson = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;
const manifest = () => readJson<Manifest>(join(pluginRoot, '.claude-plugin', 'plugin.json'));

async function entriesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...await entriesBelow(path)] : [path];
  }));
  return nested.flat().sort();
}

/** Words the directory counts: prose outside fenced code blocks. */
function proseWords(markdown: string): number {
  return markdown.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('Claude directory plugin package', () => {
  it('has a distinctive, version-aligned manifest with listing links', async () => {
    const plugin = await manifest();
    const packageJson = await readJson<{ version: string }>(join(repositoryRoot, 'package.json'));

    expect(plugin.name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(plugin.name).not.toMatch(/(^|-)(claude|anthropic|official)(-|$)/);
    expect(plugin.displayName).toMatch(/^[\x20-\x7e]+$/);
    expect(plugin.author?.name).toMatch(/^[\x20-\x7e]+$/);
    expect(plugin.version).toBe(packageJson.version);
    expect(plugin.description).toBeTruthy();
    expect(plugin.license).toBe('MIT');
    for (const url of [plugin.documentationUrl, plugin.supportUrl, plugin.privacyPolicyUrl, plugin.termsOfServiceUrl]) {
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it('ships a square PNG listing icon within the directory bounds', async () => {
    const plugin = await manifest();
    expect(plugin.icon).toBe('./assets/icon.png');
    const { width, height } = pngSize(await readFile(join(pluginRoot, plugin.icon!)));
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
  });

  it('has a README of at least 40 prose words and a LICENSE file', async () => {
    expect(proseWords(await readFile(join(pluginRoot, 'README.md'), 'utf8'))).toBeGreaterThanOrEqual(40);
    expect(await readFile(join(pluginRoot, 'LICENSE'), 'utf8')).toMatch(/^MIT License/);
  });

  it('runs nothing locally: no hooks, commands, agents, executables, scripts, or package installs', async () => {
    const plugin = await manifest();
    expect(plugin.hooks).toBeUndefined();
    expect(plugin.mcpServers).toBeUndefined();
    const names = (await entriesBelow(pluginRoot)).map((path) => relative(pluginRoot, path).replaceAll('\\', '/'));
    expect(names).toEqual([
      '.claude-plugin',
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'LICENSE',
      'README.md',
      'assets',
      'assets/icon.png',
      'skills',
      'skills/cloud-harness-workspaces',
      'skills/cloud-harness-workspaces/SKILL.md'
    ]);
  });

  it('keeps every entry a regular file or folder under the directory size limit', async () => {
    for (const path of await entriesBelow(pluginRoot)) {
      const info = await lstat(path);
      expect(info.isSymbolicLink(), path).toBe(false);
      if (info.isFile()) expect(info.size, path).toBeLessThan(256 * 1024);
    }
  });

  it('connects only to the user-configured endpoint and stores no credential', async () => {
    const plugin = await manifest();
    const config = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(join(pluginRoot, '.mcp.json'));

    expect(config.mcpServers).toEqual({ 'cloud-harness': { type: 'http', url: '${user_config.mcpUrl}' } });
    // The endpoint has no default, so installing the plugin cannot reach any existing deployment.
    expect(plugin.userConfig).toEqual({
      mcpUrl: expect.objectContaining({ type: 'string', required: true }) as unknown
    });
    expect(plugin.userConfig?.mcpUrl).not.toHaveProperty('default');
    expect(plugin.userConfig?.mcpUrl).not.toHaveProperty('sensitive');

    const serialized = JSON.stringify([plugin, config]);
    expect(serialized).not.toMatch(/headers|headersHelper|Bearer|apiKey|api_key|token|secret|\$\{(?!user_config\.mcpUrl\})/i);
  });

  it('names only real tools in its narrow skill', async () => {
    const skill = await readFile(skillPath, 'utf8');
    const frontMatter = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: "([^"\r\n]+)"\r?\n---\r?\n/.exec(skill);
    expect(frontMatter?.[1]).toBe('cloud-harness-workspaces');
    expect(frontMatter?.[2]?.length).toBeGreaterThan(40);

    const known = new Set<string>([...TOOL_SPECS, ...AUTOMATION_TOOL_SPECS].map((spec) => spec.name));
    const named = [...skill.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it('is listed in the repository marketplace at the plugin version', async () => {
    const plugin = await manifest();
    const marketplace = await readJson<{ plugins: Array<{ name: string; source: string; version: string }> }>(
      join(repositoryRoot, '.claude-plugin', 'marketplace.json')
    );
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({
      name: plugin.name, source: './plugins/cloud-harness-workspaces', version: plugin.version
    }));
  });
});
