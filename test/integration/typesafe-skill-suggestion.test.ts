import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderSkillRelevance } from '../../apps/runner/src/typesafe-skill-suggester.js';

/**
 * The prompt-submit surfaces. The `<skill_relevance>` block is the one channel that reaches every
 * turn's context, and the plugin hook is what injects it, so both are asserted here rather than left
 * to a manual check.
 */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginRoot = join(repositoryRoot, 'plugins', 'cloud-harness');

describe('plugin prompt-submit surfaces', () => {
  it('registers a UserPromptSubmit handler that calls the suggestion tool with an explicit timeout', () => {
    const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')) as {
      UserPromptSubmit?: Array<{ hooks?: Array<{ type?: string; server?: string; tool?: string; timeout?: number }> }>;
    };

    const handlers = (hooks.UserPromptSubmit ?? []).flatMap((entry) => entry.hooks ?? []);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({ type: 'mcp_tool', tool: 'skill_suggest' });
    // UserPromptSubmit lowers the default timeout to 30 seconds, so the handler names a short one.
    expect(handlers[0]!.timeout).toBeGreaterThan(0);
    expect(handlers[0]!.timeout!).toBeLessThan(30);
    expect(handlers[0]!.server).toContain('cloud-harness');
  });

  it('declares the bundled server against the operator endpoint and stores no credential', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    const server = manifest.mcpServers?.['cloud-harness'];
    expect(server).toBeDefined();
    expect(server!.url).toContain('userConfig');

    // The plugin reuses the operator's existing endpoint and authentication; a token or a second
    // credential path in this file would be a new secret surface.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/token|secret|apiKey|Bearer/i);
  });
});

describe('skill relevance block', () => {
  it('names one roster skill and states that the block is data to ignore', () => {
    const block = renderSkillRelevance({ suggested: { name: 'tdd' }, rosterNames: ['tdd', 'review'], mode: 'suggest' });

    expect(block).toContain('<skill_relevance>');
    expect(block).toContain('tdd');
    expect(block).toMatch(/ignore it/i);
    // Only the identifier appears: no description, no excerpt, no model prose.
    expect(block).not.toContain('review');
  });

  it('says no skill is relevant rather than emitting nothing', () => {
    const block = renderSkillRelevance({ suggested: null, rosterNames: ['tdd'], mode: 'suggest' });

    expect(block).toContain('<skill_relevance>');
    expect(block).toMatch(/no skill appears relevant/i);
  });

  it('refuses to interpolate a name outside the roster or outside the charset', () => {
    expect(renderSkillRelevance({ suggested: { name: 'not-in-roster' }, rosterNames: ['tdd'], mode: 'suggest' })).toBeUndefined();
    expect(renderSkillRelevance({ suggested: { name: 'a<b>&</skill_relevance>' }, rosterNames: ['a<b>&</skill_relevance>'], mode: 'suggest' })).toBeUndefined();
    expect(renderSkillRelevance({ suggested: { name: 'x'.repeat(81) }, rosterNames: ['x'.repeat(81)], mode: 'suggest' })).toBeUndefined();
  });

  it('refuses a name outside the charset, which is also why markup cannot reach the block', () => {
    // The charset rule already excludes markup characters. Escaping is defence in depth for the day
    // that rule loosens, so this asserts the rule that actually closes the channel today.
    expect(renderSkillRelevance({ suggested: { name: 'a&b' }, rosterNames: ['a&b'], mode: 'suggest' })).toBeUndefined();
    expect(renderSkillRelevance({ suggested: { name: 'a<b>' }, rosterNames: ['a<b>'], mode: 'suggest' })).toBeUndefined();
    expect(renderSkillRelevance({ suggested: { name: 'plain-name_1' }, rosterNames: ['plain-name_1'], mode: 'suggest' })).toContain('plain-name_1');
  });
});
