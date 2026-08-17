import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RunnerOperationSchema, TOOL_SCHEMA_BY_NAME, TOOL_SPECS } from '../src/index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillRoot = join(repositoryRoot, '.agents', 'skills', 'cloudharness');
const pluginSkillRoot = join(repositoryRoot, 'plugins', 'cloud-harness', 'skills', 'cloudharness');

function sorted(values: string[]) {
  return [...values].sort();
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? await filesBelow(path) : [path];
  }));
  return nested.flat().sort();
}

function toolsFrom(markdown: string) {
  return [...markdown.matchAll(/<!-- cloudharness-tool:([a-z_]+) -->/g)].map((entry) => entry[1]);
}

function examplesFrom(markdown: string) {
  return [...markdown.matchAll(/<!-- cloudharness-example:([a-z_]+)\n([\s\S]*?)\n-->/g)].map((entry) => ({
    operation: entry[1],
    input: JSON.parse(entry[2]) as unknown
  }));
}

describe('cloudharness skill contract', () => {
  it('documents every registered operation exactly once', async () => {
    const markdownFiles = (await filesBelow(skillRoot)).filter((path) => path.endsWith('.md'));
    const toolNames = (await Promise.all(markdownFiles.map(async (path) => toolsFrom(await readFile(path, 'utf8'))))).flat();
    const schemaOperations = RunnerOperationSchema.options;
    const registeredOperations = TOOL_SPECS.map((spec) => spec.name);

    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(sorted(toolNames)).toEqual(sorted(schemaOperations));
    expect(sorted(registeredOperations)).toEqual(sorted(schemaOperations));
  });

  it('keeps every marked example valid against its public input schema', async () => {
    const markdownFiles = (await filesBelow(skillRoot)).filter((path) => path.endsWith('.md'));
    const examples = (await Promise.all(markdownFiles.map(async (path) => examplesFrom(await readFile(path, 'utf8'))))).flat();

    expect(examples.length).toBeGreaterThanOrEqual(8);
    for (const { operation, input } of examples) {
      const parsedOperation = RunnerOperationSchema.parse(operation);
      expect(() => TOOL_SCHEMA_BY_NAME[parsedOperation].parse(input)).not.toThrow();
    }
  });

  it('is portable, bounded, and internally linked', async () => {
    const markdownFiles = (await filesBelow(skillRoot)).filter((path) => path.endsWith('.md'));
    const forbiddenSourcePath = /(?:^|[\s`'(])(?:docs|packages|apps|worker|test|scripts)\//m;

    for (const path of markdownFiles) {
      const markdown = await readFile(path, 'utf8');
      expect(markdown.split('\n').length, relative(skillRoot, path)).toBeLessThanOrEqual(300);
      expect(markdown, relative(skillRoot, path)).not.toMatch(forbiddenSourcePath);

      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split('#', 1)[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resolvedTarget = resolve(dirname(path), target);
        expect(resolvedTarget.startsWith(`${skillRoot}/`), `${path} -> ${target}`).toBe(true);
        await expect(stat(resolvedTarget), `${path} -> ${target}`).resolves.toMatchObject({});
      }
    }
  });

  it('packages a byte-identical skill with version-aligned plugin manifests', async () => {
    const sourceFiles = await filesBelow(skillRoot);
    const pluginFiles = await filesBelow(pluginSkillRoot);
    const sourceNames = sourceFiles.map((path) => relative(skillRoot, path));
    const pluginNames = pluginFiles.map((path) => relative(pluginSkillRoot, path));

    expect(pluginNames).toEqual(sourceNames);
    for (const name of sourceNames) {
      expect(await readFile(join(pluginSkillRoot, name))).toEqual(await readFile(join(skillRoot, name)));
    }

    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string };
    const claudeManifest = JSON.parse(await readFile(join(repositoryRoot, 'plugins/cloud-harness/.claude-plugin/plugin.json'), 'utf8')) as { version: string };
    const codexManifest = JSON.parse(await readFile(join(repositoryRoot, 'plugins/cloud-harness/.codex-plugin/plugin.json'), 'utf8')) as { version: string; apps?: unknown; mcpServers?: unknown };
    const claudeMarketplace = JSON.parse(await readFile(join(repositoryRoot, '.claude-plugin/marketplace.json'), 'utf8')) as { plugins: Array<{ version: string }> };
    const codexMarketplace = JSON.parse(await readFile(join(repositoryRoot, '.agents/plugins/marketplace.json'), 'utf8')) as { plugins: Array<{ source: { path: string } }> };
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8');

    expect(claudeManifest.version).toBe(packageJson.version);
    expect(codexManifest.version).toBe(packageJson.version);
    expect(claudeMarketplace.plugins[0]?.version).toBe(packageJson.version);
    expect(codexMarketplace.plugins[0]?.source.path).toBe('./plugins/cloud-harness');
    expect(codexManifest.apps).toBeUndefined();
    expect(codexManifest.mcpServers).toBeUndefined();
    expect(readme).toContain('npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness');
  });

  it('ships marketplace review cases for intended and unintended triggers', async () => {
    const evals = JSON.parse(await readFile(join(skillRoot, 'evals/evals.json'), 'utf8')) as Array<{
      name: string;
      prompt: string;
      assertions: string[];
    }>;

    expect(evals.filter(({ name }) => name.startsWith('positive_'))).toHaveLength(5);
    expect(evals.filter(({ name }) => name.startsWith('negative_'))).toHaveLength(3);
    for (const testCase of evals) {
      expect(testCase.prompt.length).toBeGreaterThan(20);
      expect(testCase.assertions.length).toBeGreaterThanOrEqual(2);
    }
  });
});
