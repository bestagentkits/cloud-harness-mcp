import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RunnerOperationSchema, TOOL_SCHEMA_BY_NAME, TOOL_SPECS } from '../src/index.js';

const skillUrl = new URL('../../../.agents/skills/cloudharness/SKILL.md', import.meta.url);
const inventoryUrl = new URL('../../../.agents/skills/cloudharness/references/canonical-tool-inventory.md', import.meta.url);

function sorted(values: string[]) {
  return [...values].sort();
}

function inventoryFrom(markdown: string) {
  const match = /<!-- cloudharness-tool-inventory:start -->([\s\S]*?)<!-- cloudharness-tool-inventory:end -->/.exec(markdown);
  if (!match) throw new Error('cloudharness tool inventory markers are missing');
  return [...match[1].matchAll(/`([a-z_]+)`/g)].map((entry) => entry[1]);
}

function examplesFrom(markdown: string) {
  return [...markdown.matchAll(/<!-- cloudharness-example:([a-z_]+)\n([\s\S]*?)\n-->/g)].map((entry) => ({
    operation: entry[1],
    input: JSON.parse(entry[2])
  }));
}

describe('cloudharness skill contract', () => {
  it('documents the exact registered public operation inventory', async () => {
    const inventory = inventoryFrom(await readFile(inventoryUrl, 'utf8'));
    const schemaOperations = RunnerOperationSchema.options;
    const registeredOperations = TOOL_SPECS.map((spec) => spec.name);

    expect(new Set(inventory).size).toBe(inventory.length);
    expect(sorted(inventory)).toEqual(sorted(schemaOperations));
    expect(sorted(registeredOperations)).toEqual(sorted(schemaOperations));
  });

  it('keeps marked skill examples valid against public input schemas', async () => {
    const examples = examplesFrom(await readFile(skillUrl, 'utf8'));

    expect(examples.length).toBeGreaterThan(0);
    for (const { operation, input } of examples) {
      expect(RunnerOperationSchema.options).toContain(operation);
      expect(() => TOOL_SCHEMA_BY_NAME[operation].parse(input)).not.toThrow();
    }
  });
});
