import { describe, expect, it } from 'vitest';
import { COCKPIT_TABS, validateCockpitSearch } from './cockpit-tab-registry';

describe('cockpit tab search params', () => {
  it('merges every tab-declared validator into the route search', () => {
    expect(validateCockpitSearch({ path: 'src', file: 'src/a.ts', staged: 'true', task: `task_${'a'.repeat(12)}` })).toMatchObject({
      path: 'src', file: 'src/a.ts', staged: true, task: `task_${'a'.repeat(12)}`
    });
  });

  it('names every declared key, so an invalid raw value cannot survive the router merge', () => {
    const search = validateCockpitSearch({ task: '../etc', staged: 'nope', unknown: 'x' });
    expect(Object.keys(search).sort()).toEqual(['file', 'path', 'staged', 'task']);
    expect(search).toEqual({ path: undefined, file: undefined, staged: undefined, task: undefined });
  });

  it('declares search only on tabs that deep-link', () => {
    const declaring = Object.values(COCKPIT_TABS).filter((entry) => entry.validateSearch).map((entry) => entry.id).sort();
    expect(declaring).toEqual(['files', 'git', 'runtime']);
  });
});
