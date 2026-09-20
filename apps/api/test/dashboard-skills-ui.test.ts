import { describe, expect, it } from 'vitest';
import {
  launchBlockedByConflicts,
  renderSkillConflicts,
  renderSkillsLibraryRows,
  renderSkillsRegistryRows
} from '../dashboard/dashboard-render.js';
import { FakeElement } from './dashboard-test-dom.js';

describe('skills library rendering', () => {
  it('renders a row per skill with the state and a selectable checkbox', () => {
    const html = renderSkillsLibraryRows([
      { id: 'sk_one', slug: 'tdd', displayName: 'TDD', kind: 'owner', provider: 'custom', state: 'enabled' }
    ]);

    expect(html).toContain('data-skill-id="sk_one"');
    expect(html).toContain('>TDD</button>');
    expect(html).toContain('data-skill-select="sk_one"');
    expect(html).toContain('custom');
  });

  it('escapes a name a provider could have chosen, so imported content cannot inject markup', () => {
    const html = renderSkillsLibraryRows([
      { id: 'sk_x', slug: 'x', displayName: '<img src=x onerror="alert(1)">', kind: 'owner', provider: 'skills-sh', state: 'enabled' }
    ]);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img');
  });

  it('explains an empty library instead of rendering an empty table', () => {
    const html = renderSkillsLibraryRows([]);
    expect(html).toContain('No skills yet');
    expect(html).toContain('colspan="5"');
  });

  it('survives a payload that is not an array', () => {
    expect(renderSkillsLibraryRows(undefined)).toContain('No skills yet');
    expect(renderSkillsRegistryRows(undefined)).toContain('No registry entries');
  });
});

describe('skills registry rendering', () => {
  it('shows cache state, pinned commit, skill count, and lock state', () => {
    const html = renderSkillsRegistryRows([
      { displayName: 'mattpocock/skills', cacheState: 'READY', pinnedCommit: 'a'.repeat(40), skillCount: 3, lockState: 'locked' }
    ]);

    expect(html).toContain('mattpocock/skills');
    expect(html).toContain('READY');
    expect(html).toContain('a'.repeat(40));
    expect(html).toContain('>3<');
    expect(html).toContain('locked');
  });

  it('falls back to placeholder values rather than printing undefined', () => {
    const html = renderSkillsRegistryRows([{ slug: 'orphan' }]);
    expect(html).not.toContain('undefined');
    expect(html).toContain('orphan');
  });
});

describe('launch conflict resolution', () => {
  const conflicts = [{
    name: 'tdd',
    candidates: [
      { tier: 'owner', revisionId: 'skrev_one' },
      { tier: 'workspace', revisionId: 'skrev_two' }
    ]
  }];

  it('blocks launch while a conflict has no override and unblocks it once one is chosen', () => {
    expect(launchBlockedByConflicts(conflicts, {})).toBe(true);
    expect(launchBlockedByConflicts(conflicts, { tdd: 'skrev_one' })).toBe(false);
    // A conflict-free launch is never blocked.
    expect(launchBlockedByConflicts([], {})).toBe(false);
  });

  it('renders one radio group per conflict and marks the chosen override', () => {
    const selected = renderSkillConflicts(conflicts, { tdd: 'skrev_two' });
    expect(selected).toContain('data-conflict-name="tdd"');
    expect(selected).toContain('name="conflict-tdd"');
    expect(selected).toContain('value="skrev_two" checked');

    const unchecked = renderSkillConflicts(conflicts, {});
    expect(unchecked).not.toContain('checked');
  });

  it('escapes the conflict name, which comes from the skill inventory', () => {
    const html = renderSkillConflicts([{ name: '"><script>alert(1)</script>', candidates: [] }], {});
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('shared dashboard element double', () => {
  it('tracks attributes and dispatches to registered listeners', () => {
    const element = new FakeElement();
    element.setAttribute('aria-selected', 'true');
    expect(element.getAttribute('aria-selected')).toBe('true');
    element.removeAttribute('aria-selected');
    expect(element.getAttribute('aria-selected')).toBeUndefined();

    let seen: unknown;
    const listener = (event: unknown) => { seen = event; };
    element.addEventListener('click', listener);
    element.dispatch('click', { type: 'click' });
    expect(seen).toEqual({ type: 'click' });

    element.removeEventListener('click', listener);
    element.dispatch('click', { type: 'click' });
    expect(seen).toEqual({ type: 'click' });
  });
});
