import { describe, expect, it, vi } from 'vitest';
import {
  isTerminalImportState,
  launchBlockedByConflicts,
  renderImportJobGuidance,
  renderRevisionDiff,
  renderSkillConflicts,
  renderSkillsLibraryCards,
  renderSkillsLibraryRows,
  renderSkillsRegistryRows,
  renderSkillsSkeleton
} from '../dashboard/dashboard-render.js';
import {
  buildSkillImportRequest,
  buildSkillSetBody,
  createImportPollingController,
  createLaunchSkillSetController,
  createSkillEditorController,
  createSkillsLibraryController,
  createSkillsTabsController,
  groupBulkRequests,
  skillsLibraryState,
  validateSkillInstructions
} from '../dashboard/dashboard.js';
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
    expect(html).toContain('colspan="6"');
  });

  it('survives a payload that is not an array', () => {
    expect(renderSkillsLibraryRows(undefined)).toContain('No skills yet');
    expect(renderSkillsRegistryRows(undefined)).toContain('No registry entries');
    expect(renderSkillsLibraryCards(undefined)).toContain('No skills yet');
  });

  it('renders the same rows as escaped cards for narrow screens', () => {
    const html = renderSkillsLibraryCards([
      { id: 'sk_a', slug: 'tdd', displayName: '<b>not markup</b>', state: 'enabled', provider: 'custom' }
    ]);

    expect(html).toContain('data-skill-select="sk_a"');
    expect(html).toContain('data-skill-detail="sk_a"');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('marks the wide table for hiding on a phone and ships the card list as the same rows', () => {
    const skeleton = renderSkillsSkeleton();
    expect(skeleton).toContain('id="skills-library-table" class="data-table desktop-table"');
    expect(skeleton).toContain('id="skills-library-cards"');
  });

  it('groups each library filter into its own labelled field', () => {
    const skeleton = renderSkillsSkeleton();
    // The dashboard's global `form` rule lays form children out as one wrapping flex row, which is what
    // put every label and control on a single crowded line. Each filter is asserted as one wrapper that
    // encloses both its label and its control, which is what makes the bar a labelled grid instead.
    for (const id of [
      'skills-library-search', 'skills-library-provider', 'skills-library-state',
      'skills-library-tag', 'skills-library-sort'
    ]) {
      const label = skeleton.indexOf(`<label for="${id}">`);
      expect(label, `${id} has a label`).toBeGreaterThan(-1);
      const wrapperStart = skeleton.lastIndexOf('<div class="skills-field', label);
      const wrapperEnd = skeleton.indexOf('</div>', label);
      expect(wrapperStart, `${id} sits inside a field wrapper`).toBeGreaterThan(-1);
      expect(wrapperEnd, `${id} has a closing wrapper`).toBeGreaterThan(label);
      expect(skeleton.slice(wrapperStart, wrapperEnd), id).toContain(`id="${id}"`);
    }
  });

  it('names the open skill, offers a close control, and renders the diff where the drawer is', () => {
    const skeleton = renderSkillsSkeleton();
    expect(skeleton).toContain('id="skill-detail-title"');
    expect(skeleton).toContain('id="skill-detail-close"');
    expect(skeleton).toContain('id="skill-editor-title"');
    // The diff used to live in the Discover panel, which is hidden whenever the Library tab is open, so
    // pressing Diff wrote the result into a container the operator could never see.
    expect(skeleton.indexOf('id="skill-revision-diff"')).toBeLessThan(skeleton.indexOf('id="skills-panel-discover"'));
  });

  it('renders one empty block rather than a message in both the table and the card list', () => {
    const skeleton = renderSkillsSkeleton();
    expect(skeleton).toContain('id="skills-library-empty"');
    expect(skeleton).toContain('id="skills-library-empty-message"');
    expect(skeleton).toContain('id="skills-library-empty-action"');
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

describe('skills library states', () => {
  it('tells an empty library apart from a filter that matches nothing', () => {
    const empty = skillsLibraryState({ total: 0, visible: 0 });
    expect(empty.kind).toBe('empty');
    expect(empty.message).toContain('No skills yet');
    expect(empty.action).toBe('discover');
    expect(empty.actionLabel).toBe('Discover skills');

    const noMatch = skillsLibraryState({ total: 12, visible: 0 });
    expect(noMatch.kind).toBe('no-match');
    expect(noMatch.message).toContain('No skills match');
    expect(noMatch.action).toBe('clear');
    expect(noMatch.actionLabel).toBe('Clear filters');
    expect(noMatch.count).toBe('0 of 12 skills');
    // One shared string was what made the old page's single message ambiguous between the two facts.
    expect(noMatch.message).not.toBe(empty.message);
  });

  it('states the count in every state, so a filter is never mistaken for an empty library', () => {
    expect(skillsLibraryState({ total: 0, visible: 0 }).count).toBe('No skills yet');
    expect(skillsLibraryState({ total: 1, visible: 1 }).count).toBe('1 skill');
    expect(skillsLibraryState({ total: 12, visible: 12 }).count).toBe('12 skills');
    expect(skillsLibraryState({ total: 12, visible: 3 }).count).toBe('3 of 12 skills');
  });

  it('keeps the rows state free of an empty message and an action', () => {
    const rows = skillsLibraryState({ total: 2, visible: 2 });
    expect(rows.kind).toBe('rows');
    expect(rows.message).toBe('');
    expect(rows.action).toBeNull();
    expect(rows.actionLabel).toBe('');
  });

  it('treats a payload that carries no usable count as an empty library', () => {
    expect(skillsLibraryState({}).kind).toBe('empty');
    expect(skillsLibraryState({ total: undefined, visible: undefined }).kind).toBe('empty');
    expect(skillsLibraryState({ total: -3, visible: -1 }).kind).toBe('empty');
    expect(skillsLibraryState({ total: Number.NaN, visible: Number.NaN }).kind).toBe('empty');
  });
});

describe('skills library controller', () => {
  it('debounces search to a single request inside the window', () => {
    vi.useFakeTimers();
    try {
      const onSearch = vi.fn();
      const controller = createSkillsLibraryController({ onSearch, onBulk: vi.fn() });
      controller.search('t');
      controller.search('td');
      controller.search('tdd');
      expect(onSearch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(299);
      expect(onSearch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenCalledWith('tdd');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drives the bulk bar from row selection', () => {
    const bulkBar = new FakeElement();
    const bulkCount = new FakeElement();
    bulkBar.hidden = true;
    const controller = createSkillsLibraryController({ bulkBar, bulkCount, onSearch: vi.fn(), onBulk: vi.fn() });

    controller.toggle('sk_one', true);
    expect(bulkBar.hidden).toBe(false);
    expect(bulkCount.textContent).toBe('1 selected');

    controller.toggle('sk_one', false);
    expect(bulkBar.hidden).toBe(true);
    expect(bulkCount.textContent).toBe('0 selected');
  });

  it('keeps a per-item failure selected with its blocker after a bulk call', async () => {
    const bulkBar = new FakeElement();
    const bulkCount = new FakeElement();
    const onBulk = vi.fn(async () => [
      { skillId: 'sk_one', ok: true },
      { skillId: 'sk_two', ok: false, error: 'CONFLICT' }
    ]);
    const controller = createSkillsLibraryController({ bulkBar, bulkCount, onSearch: vi.fn(), onBulk });
    controller.toggle('sk_one', true);
    controller.toggle('sk_two', true);

    const blockers = await controller.runBulk('archive');

    expect(onBulk).toHaveBeenCalledWith('archive', ['sk_one', 'sk_two']);
    expect(controller.selectedIds()).toEqual(['sk_two']);
    expect(blockers).toEqual([{ skillId: 'sk_two', blocker: 'CONFLICT' }]);
    expect(bulkBar.hidden).toBe(false);
    expect(bulkCount.textContent).toBe('1 selected');
  });

  it('does not call the server when nothing is selected', async () => {
    const onBulk = vi.fn();
    const controller = createSkillsLibraryController({ onSearch: vi.fn(), onBulk });
    await expect(controller.runBulk('archive')).resolves.toEqual([]);
    expect(onBulk).not.toHaveBeenCalled();
  });
});

describe('skill instructions validation', () => {
  it('rejects what the runner would refuse and accepts ordinary frontmatter', () => {
    expect(validateSkillInstructions('')).toMatch(/cannot be empty/i);
    expect(validateSkillInstructions('   \n ')).toMatch(/cannot be empty/i);
    expect(validateSkillInstructions('a\0b')).toMatch(/null bytes/i);
    expect(validateSkillInstructions('---\nname: tdd\n')).toMatch(/never closes/i);
    expect(validateSkillInstructions('---\nname: tdd\n---\nBody')).toBeNull();
    expect(validateSkillInstructions('# Plain instructions')).toBeNull();
  });
});

describe('revision diff rendering', () => {
  it('marks added, removed, and metadata lines and carries a text alternative', () => {
    const diff = '--- a/SKILL.md\n+++ b/SKILL.md\n context\n-removed line\n+added line\n';
    const { html, text } = renderRevisionDiff(diff);

    expect(html).toContain('diff-line diff-add');
    expect(html).toContain('diff-line diff-remove');
    expect(html).toContain('diff-line diff-meta');
    // The header lines must not be counted as content changes.
    expect(text).toBe('1 line added, 1 line removed');
  });

  it('escapes diff content, which came from a provider', () => {
    const { html } = renderRevisionDiff('+<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles an empty diff without claiming changes', () => {
    expect(renderRevisionDiff(undefined).text).toBe('0 lines added, 0 lines removed');
  });
});

describe('import job polling', () => {
  it('polls until a terminal state and then stops', async () => {
    vi.useFakeTimers();
    try {
      const jobs = [{ state: 'running' }, { state: 'running' }, { state: 'succeeded' }];
      const fetchJob = vi.fn(async () => jobs.shift() ?? { state: 'succeeded' });
      const states: string[] = [];
      const controller = createImportPollingController({
        fetchJob,
        onState: (job) => states.push(job.state),
        isTerminal: (job) => ['succeeded', 'failed', 'cancelled'].includes(job.state),
        intervalMs: 1_000
      });

      await controller.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(states).toEqual(['running', 'running', 'succeeded']);
      expect(controller.running()).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchJob).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops once its attempt budget runs out, so a dead runner cannot poll forever', async () => {
    const fetchJob = vi.fn(async () => ({ state: 'running' }));
    const controller = createImportPollingController({
      fetchJob, onState: vi.fn(), isTerminal: () => false, maxAttempts: 1
    });

    await controller.start();

    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(controller.running()).toBe(false);
  });

  it('stops on cancel while a job is still running', async () => {
    const fetchJob = vi.fn(async () => ({ state: 'running' }));
    const controller = createImportPollingController({ fetchJob, onState: vi.fn(), isTerminal: () => false });

    await controller.start();
    expect(controller.running()).toBe(true);

    controller.stop();
    expect(controller.running()).toBe(false);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });
});

describe('skills tab controller', () => {
  it('keeps aria-selected and the visible panel in step and enters each tab once', () => {
    const library = new FakeElement();
    const registry = new FakeElement();
    const libraryPanel = new FakeElement();
    const registryPanel = new FakeElement();
    const onEnter = vi.fn();
    const controller = createSkillsTabsController({
      tabs: [{ name: 'library', element: library }, { name: 'registry', element: registry }],
      panels: [{ name: 'library', element: libraryPanel }, { name: 'registry', element: registryPanel }],
      onEnter
    });

    controller.select('library');
    expect(library.getAttribute('aria-selected')).toBe('true');
    expect(registry.getAttribute('aria-selected')).toBe('false');
    expect(library.getAttribute('tabindex')).toBe('0');
    expect(registry.getAttribute('tabindex')).toBe('-1');
    expect(libraryPanel.hidden).toBe(false);
    expect(registryPanel.hidden).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith('library');

    controller.select('registry');
    expect(onEnter).toHaveBeenCalledTimes(2);

    // Returning to a tab that was already entered must not re-request its data.
    controller.select('library');
    expect(onEnter).toHaveBeenCalledTimes(2);
    expect(controller.enteredTabs()).toEqual(['library', 'registry']);
  });
});

describe('skill editor submit', () => {
  it('refuses invalid input without calling the server or clearing the draft', async () => {
    const instructions = new FakeElement();
    instructions.value = 'a\0b';
    const save = vi.fn();
    const controller = createSkillEditorController({ instructions, save });

    const result = await controller.submit();

    expect(result).toMatchObject({ ok: false, reason: 'invalid', keepDraft: true });
    expect(save).not.toHaveBeenCalled();
    expect(instructions.value).toBe('a\0b');
  });

  it('keeps the draft and explains the conflict when the slug is already taken', async () => {
    const instructions = new FakeElement();
    instructions.value = '# Instructions';
    const save = vi.fn(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
    const controller = createSkillEditorController({ instructions, save });

    const result = await controller.submit();

    expect(result).toMatchObject({ ok: false, reason: 'conflict', keepDraft: true });
    expect(result.message).toMatch(/slug already exists/i);
    expect(instructions.value).toBe('# Instructions');
  });

  it('reports a non-conflict failure as an error and still keeps the draft', async () => {
    const instructions = new FakeElement();
    instructions.value = '# Instructions';
    const controller = createSkillEditorController({
      instructions,
      save: async () => { throw Object.assign(new Error('runner is unavailable'), { status: 503 }); }
    });

    const result = await controller.submit();

    expect(result).toMatchObject({ ok: false, reason: 'error', keepDraft: true });
    expect(result.message).toBe('runner is unavailable');
  });

  it('saves a valid draft and reports success', async () => {
    const instructions = new FakeElement();
    instructions.value = '# Instructions';
    const save = vi.fn(async () => ({ id: 'sk_one' }));
    const controller = createSkillEditorController({ instructions, save });

    const result = await controller.submit();

    expect(result).toMatchObject({ ok: true, keepDraft: false });
    expect(save).toHaveBeenCalledWith({ slug: '', displayName: '', instructions: '# Instructions', expectedGeneration: 0 });
  });

  it('builds the create body from the slug and display name fields', async () => {
    const slug = new FakeElement();
    const displayName = new FakeElement();
    const instructions = new FakeElement();
    slug.value = 'my-skill';
    displayName.value = 'My Skill';
    instructions.value = '# Instructions';
    const save = vi.fn(async () => ({ sourceId: 'sk_one' }));

    const result = await createSkillEditorController({ slug, displayName, instructions, save }).submit();

    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledWith({ slug: 'my-skill', displayName: 'My Skill', instructions: '# Instructions', expectedGeneration: 0 });
  });

  it('refuses a slug the contract would reject before calling the server', async () => {
    const slug = new FakeElement();
    const instructions = new FakeElement();
    slug.value = 'not a slug';
    instructions.value = '# Instructions';
    const save = vi.fn();

    const result = await createSkillEditorController({ slug, instructions, save }).submit();

    expect(result).toMatchObject({ ok: false, reason: 'invalid', keepDraft: true });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('skill import wizard', () => {
  it('rejects a source that is empty or not owner/repository', () => {
    expect(buildSkillImportRequest({ sourceRef: '' })).toMatchObject({ ok: false });
    expect(buildSkillImportRequest({ sourceRef: 'just-a-name' })).toMatchObject({ ok: false });
    expect(buildSkillImportRequest({ sourceRef: 'owner/repo' })).toMatchObject({ ok: true });
  });

  it('accepts a bare slug for skillx, which is not owner/repository shaped', () => {
    const result = buildSkillImportRequest({ sourceKind: 'skillx', sourceRef: 'test-driven-development' });
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ sourceKind: 'skillx', sourceRef: 'test-driven-development', expectedGeneration: 0 });
  });

  it('refuses a ref the operation would refuse, rather than letting the runner discover it', () => {
    const branchName = buildSkillImportRequest({ sourceRef: 'owner/repo', ref: 'main' });
    expect(branchName).toMatchObject({ ok: false });
    expect(branchName.message).toMatch(/commit id/i);

    const pinned = buildSkillImportRequest({ sourceRef: 'owner/repo', ref: 'a'.repeat(40) });
    expect(pinned.body).toMatchObject({ ref: 'a'.repeat(40) });
  });

  it('names the cache miss remedy and treats only terminal states as final', () => {
    const missing = renderImportJobGuidance({ state: 'failed', errorCode: 'CACHE_MISS' });
    expect(missing).toContain('CACHE_MISS');
    expect(missing).toMatch(/retry/i);

    expect(renderImportJobGuidance({ state: 'failed', errorCode: 'UNAVAILABLE' })).toContain('UNAVAILABLE');
    expect(renderImportJobGuidance({ state: 'running', progress: { percent: 40 } })).toContain('(40%)');
    expect(renderImportJobGuidance({ state: 'succeeded' })).toMatch(/finished/i);
    expect(renderImportJobGuidance(undefined)).toMatch(/queued/i);

    expect(isTerminalImportState({ state: 'succeeded' })).toBe(true);
    expect(isTerminalImportState({ state: 'cancelled' })).toBe(true);
    expect(isTerminalImportState({ state: 'failed' })).toBe(true);
    expect(isTerminalImportState({ state: 'running' })).toBe(false);
    expect(isTerminalImportState(undefined)).toBe(false);
  });
});

describe('launch skill-set selection', () => {
  const sets = [{ id: 'skset_core', name: 'core', generation: 3 }, { id: 'skset_extra', name: 'extra', generation: 1 }];

  it('leaves submit available when no set is selected, without asking the preview', async () => {
    const submit = new FakeElement();
    const preview = vi.fn();
    const controller = createLaunchSkillSetController({ submit, loadSets: async () => sets, preview });
    await controller.load();

    const result = await controller.refresh();

    expect(preview).not.toHaveBeenCalled();
    expect(submit.disabled).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('disables submit while a conflict is unresolved and enables it once every one has an override', async () => {
    const submit = new FakeElement();
    const conflict = { name: 'tdd', candidates: [{ tier: 'owner', revisionId: 'skrev_one' }, { tier: 'workspace', revisionId: 'skrev_two' }] };
    const preview = vi.fn(async () => ({ resolved: [], excluded: [], conflicts: [conflict] }));
    const controller = createLaunchSkillSetController({ submit, loadSets: async () => sets, preview });
    await controller.load();
    controller.choose(['skset_core']);

    const blocked = await controller.refresh();
    expect(blocked.blocked).toBe(true);
    expect(submit.disabled).toBe(true);

    const resolved = await controller.resolve('tdd', 'skrev_two');
    expect(resolved.blocked).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(controller.body()).toEqual({
      skillSets: [{ skillSetId: 'skset_core', expectedGeneration: 3 }],
      skillOverrides: { tdd: 'skrev_two' }
    });
  });

  it('sends the generation the set was loaded at, so a stale selection is refused by the server', async () => {
    const preview = vi.fn(async () => ({ resolved: [], excluded: [], conflicts: [] }));
    const controller = createLaunchSkillSetController({ submit: new FakeElement(), loadSets: async () => sets, preview });
    await controller.load();
    controller.choose(['skset_extra']);

    await controller.refresh();

    expect(preview).toHaveBeenCalledWith([{ skillSetId: 'skset_extra', expectedGeneration: 1 }], {});
  });

  it('survives a preview that reports no conflicts field at all', async () => {
    const preview = vi.fn(async () => ({}));
    const controller = createLaunchSkillSetController({ submit: new FakeElement(), loadSets: async () => sets, preview });
    await controller.load();
    controller.choose(['skset_core']);

    await expect(controller.refresh()).resolves.toMatchObject({ blocked: false });
    expect(controller.conflictList()).toEqual([]);
  });
});

describe('bulk batching', () => {
  const skills = [
    { id: 'sk_a', generation: 2 },
    { id: 'sk_b', generation: 2 },
    { id: 'sk_c', generation: 5 }
  ];

  it('groups selected rows by generation so one stale row cannot fail its whole batch', () => {
    const groups = groupBulkRequests(skills, ['sk_a', 'sk_b', 'sk_c']);

    expect(groups).toEqual([
      { generation: 2, skillIds: ['sk_a', 'sk_b'] },
      { generation: 5, skillIds: ['sk_c'] }
    ]);
  });

  it('keeps a row whose generation is unknown in its own batch instead of guessing one', () => {
    expect(groupBulkRequests(skills, ['sk_missing'])).toEqual([{ generation: undefined, skillIds: ['sk_missing'] }]);
  });

  it('returns nothing for an empty selection, so no request is sent', () => {
    expect(groupBulkRequests(skills, [])).toEqual([]);
    expect(groupBulkRequests(undefined, undefined)).toEqual([]);
  });
});

describe('skill set builder', () => {
  const skills = [
    { id: 'sk_a', slug: 'tdd', displayName: 'TDD', currentRevisionId: 'skrev_a' },
    { id: 'sk_b', slug: 'review', displayName: 'Review', currentRevisionId: 'skrev_b' }
  ];

  it('pins each member to the revision that is current when the set is built', () => {
    const result = buildSkillSetBody({ name: 'core', description: 'daily work', skills, selectedIds: ['sk_a', 'sk_b'] });

    expect(result.ok).toBe(true);
    expect(result.body).toEqual({
      name: 'core',
      description: 'daily work',
      items: [
        { skillSourceId: 'sk_a', revisionId: 'skrev_a', name: 'tdd' },
        { skillSourceId: 'sk_b', revisionId: 'skrev_b', name: 'review' }
      ],
      expectedGeneration: 0
    });
  });

  it('refuses an empty name or an empty selection before calling the server', () => {
    expect(buildSkillSetBody({ name: '   ', skills, selectedIds: ['sk_a'] })).toMatchObject({ ok: false });
    expect(buildSkillSetBody({ name: 'core', skills, selectedIds: [] })).toMatchObject({ ok: false });
  });

  it('refuses a member whose skill has no revision, rather than creating a set that fails later', () => {
    const revisionless = [{ id: 'sk_c', slug: 'draft', displayName: 'Draft', currentRevisionId: null }];
    const result = buildSkillSetBody({ name: 'core', skills: revisionless, selectedIds: ['sk_c'] });

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/revision/i);
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
