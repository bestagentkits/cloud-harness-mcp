import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_SCHEMA_BY_NAME } from '@cloud-harness/contracts';
import {
  SPAWN_DEFAULTS, buildSpawnRequest, createAgentRefresh, createRunAgentDialog, draftForProfile, gatewayReadiness, listWorkspaces,
  presetWithin, profileEligibility, renderRunAgentForm, renderRunPreview, spawnRefused, tokenCapEstimateMicros, validateRunDraft,
  workspaceEligibility
} from '../dashboard/dashboard-agent-run.js';
import { TreeElement } from './dashboard-tree-dom.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const otherWorkspaceId = `ws_${'c'.repeat(24)}`;
const workspace = (overrides: Record<string, unknown> = {}) => ({
  workspaceId, status: 'ACTIVE', networkProfile: 'network-none', repositoryUrl: 'https://github.com/acme/app.git', ...overrides
});
const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'coding-fast',
  displayName: 'Coding fast',
  status: 'ACTIVE',
  activeRevisionId: 'rev_1',
  activeRevision: {
    id: 'rev_1', model: 'gpt-5-mini', apiMode: 'responses',
    pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000 },
    limits: { maxInputTokens: 100_000, maxOutputTokens: 16_000, maxCostMicros: 2_000_000 },
    maxProxyOperations: ['files_list', 'files_read', 'grep_search', 'files_write', 'files_apply_patch']
  },
  ...overrides
});
const ready = (overrides: Record<string, unknown> = {}) => ({
  ...draftForProfile(profile(), { workspaceId }), prompt: 'Summarise the README.', ...overrides
});

describe('Run Pi agent rules', () => {
  it('accepts only an active, network-disabled workspace and an active profile with a revision', () => {
    expect(workspaceEligibility(workspace())).toEqual({ eligible: true, reason: '' });
    expect(workspaceEligibility(workspace({ networkProfile: 'dependency-access' }))).toEqual({ eligible: false, reason: 'needs the No network profile' });
    expect(workspaceEligibility(workspace({ status: 'EXPIRED' }))).toEqual({ eligible: false, reason: 'not active' });
    expect(profileEligibility(profile()).eligible).toBe(true);
    expect(profileEligibility(profile({ status: 'SYNC_FAILED' }))).toEqual({ eligible: false, reason: 'sync failed' });
    expect(profileEligibility(profile({ activeRevision: null }))).toEqual({ eligible: false, reason: 'no active revision' });
  });

  it('starts read-only and caps every schema default by the profile', () => {
    const draft = draftForProfile(profile(), { workspaceId });
    expect(draft.operations).toEqual(['files_list', 'files_read', 'grep_search']);
    expect(draft).toMatchObject({ ttlMinutes: SPAWN_DEFAULTS.ttlSeconds / 60, maxInputTokens: 100_000, maxOutputTokens: 16_000, maxCostUsd: 2 });
    // The code preset narrows to what the profile allows instead of asking for more.
    expect(presetWithin('code', profile().activeRevision.maxProxyOperations)).toEqual(['files_list', 'files_read', 'files_write', 'files_apply_patch', 'grep_search']);
  });

  it('refuses before sending what the runner would refuse', () => {
    const context = { workspace: workspace(), profile: profile() };
    expect(validateRunDraft(ready(), context)).toEqual({});
    expect(validateRunDraft(ready(), { ...context, workspace: workspace({ networkProfile: 'dependency-access' }) })).toHaveProperty('workspaceId');
    expect(validateRunDraft(ready(), { ...context, profile: profile({ status: 'DISABLED' }) }).profileId).toContain('disabled');
    expect(validateRunDraft(ready({ prompt: '  ' }), context)).toHaveProperty('prompt');
    expect(validateRunDraft(ready({ prompt: 'é'.repeat(65_537) }), context).prompt).toContain('131072');
    expect(validateRunDraft(ready({ operations: [] }), context)).toHaveProperty('operations');
    expect(validateRunDraft(ready({ operations: ['files_delete'] }), context).operations).toContain('not allowed');
    expect(validateRunDraft(ready({ ttlMinutes: 0 }), context)).toHaveProperty('ttlMinutes');
    expect(validateRunDraft(ready({ ttlMinutes: 1_441 }), context)).toHaveProperty('ttlMinutes');
    expect(validateRunDraft(ready({ maxInputTokens: 100_001 }), context)).toHaveProperty('maxInputTokens');
    expect(validateRunDraft(ready({ maxOutputTokens: Number.NaN }), context)).toHaveProperty('maxOutputTokens');
    expect(validateRunDraft(ready({ maxCostUsd: 2.01 }), context)).toHaveProperty('maxCostUsd');
  });

  it('builds a request the agent_spawn contract accepts, with no network or credential field', () => {
    const request = buildSpawnRequest(ready({ ttlMinutes: 30, maxCostUsd: 1.5, repositoryContext: 'claude' }));
    expect(request).toEqual({
      prompt: 'Summarise the README.', profileId: 'coding-fast', proxyOperations: ['files_list', 'files_read', 'grep_search'],
      ttlSeconds: 1_800, maxOutputBytes: SPAWN_DEFAULTS.maxOutputBytes, maxInputTokens: 100_000, maxOutputTokens: 16_000,
      maxCostMicros: 1_500_000, repositoryContext: 'claude'
    });
    expect(TOOL_SCHEMA_BY_NAME.agent_spawn.safeParse({ ...request, workspaceId, idempotencyKey: 'dashboard-run-1' }).success).toBe(true);
    expect(buildSpawnRequest(ready())).not.toHaveProperty('repositoryContext');
  });

  it('previews what the run may do, its gateway readiness, and an honest cost estimate', () => {
    expect(tokenCapEstimateMicros(profile(), ready())).toBe(57_000);
    expect(tokenCapEstimateMicros(profile({ activeRevision: { ...profile().activeRevision, pricing: {} } }), ready())).toBeNull();
    expect(gatewayReadiness(null).ready).toBe(false);
    expect(gatewayReadiness({ gatewaySynced: false, error: 'boot mismatch' }).label).toContain('boot mismatch');
    const preview = renderRunPreview({ draft: ready({ operations: ['files_read', 'files_write'] }), profile: profile(), configStatus: { gatewaySynced: true } });
    expect(preview).toContain('Bounded run');
    expect(preview).toContain('no session survives it');
    expect(preview).toContain('rev_1');
    expect(preview).toContain('Model gateway synced.');
    expect(preview).toContain('Can change files: files_write.');
    const capped = renderRunPreview({ draft: ready({ maxCostUsd: 0.01 }), profile: profile(), configStatus: null });
    expect(capped).toContain('cost cap ends the run first');
    expect(capped).toContain('Gateway status unavailable');
  });

  it('lists ineligible choices disabled with their reason, and escapes every value', () => {
    const markup = renderRunAgentForm({
      draft: ready(),
      workspaces: [workspace(), workspace({ workspaceId: otherWorkspaceId, networkProfile: 'dependency-access', repositoryUrl: 'https://github.com/acme/<b>.git' })],
      profiles: [profile(), profile({ id: 'off', displayName: 'Off', status: 'DISABLED' })]
    });
    expect(markup).toContain(`<option value="${otherWorkspaceId}" disabled>`);
    expect(markup).toContain('(needs the No network profile)');
    expect(markup).toContain('<option value="off" disabled>Off · gpt-5-mini (disabled)</option>');
    expect(markup).toContain('acme/&lt;b&gt;');
    expect(markup).not.toContain('<b>');
    expect(markup).toContain('value="files_delete" disabled');
    expect(markup).not.toMatch(/style=|on[a-z]+=/i);
  });
});

describe('Run Pi agent dialog', () => {
  function mount(overrides: { spawn?: () => Promise<unknown>; workspaces?: unknown[]; profiles?: unknown[] } = {}) {
    const shell = /<dialog id="run-agent-dialog"[\s\S]*?<\/dialog>/.exec(readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8'));
    if (!shell) throw new Error('the run agent dialog is missing from the shell');
    const root = new TreeElement('#root');
    root.render(shell[0]);
    const dialog = root.querySelector('#run-agent-dialog')!;
    const spawn = vi.fn(overrides.spawn ?? (async () => ({ data: { agentId: `agent_${'b'.repeat(24)}`, status: 'RUNNING', generation: 1, replayed: false } })));
    const api = vi.fn(async (path: string, options?: { method?: string; body?: string }) => {
      if (options?.method === 'POST') return spawn(path, JSON.parse(options.body ?? '{}'));
      if (path === '/workspaces') return { data: { workspaces: overrides.workspaces ?? [workspace({ workspaceId: otherWorkspaceId, networkProfile: 'dependency-access' }), workspace()] } };
      if (path === '/agent-model-profiles') return { data: { profiles: overrides.profiles ?? [profile({ id: 'off', status: 'DISABLED' }), profile()] } };
      if (path === '/agent-model-config-status') return { data: { status: { gatewaySynced: true } } };
      throw new Error(`unexpected ${path}`);
    });
    const announce = vi.fn();
    const onSpawned = vi.fn(async () => {});
    let keys = 0;
    const controller = createRunAgentDialog({
      dialog, api, announce, onSpawned, newKey: () => `key-${++keys}`,
      insert: (element: TreeElement, markup: string) => element.render(markup)
    });
    const form = dialog.querySelector('#run-agent-form')!;
    const q = (selector: string) => dialog.querySelector(selector)!;
    const submit = async () => { form.dispatch('submit', { preventDefault: vi.fn() }); await vi.waitFor(() => expect(form.getAttribute('aria-busy')).toBeNull()); };
    /** The double does not derive control values from markup, so a test sets what a browser would. */
    const fill = (values: Record<string, string>) => { for (const [id, value] of Object.entries(values)) q(`#${id}`).value = value; };
    const fillDefaults = () => {
      fill({ 'run-agent-workspace': workspaceId, 'run-agent-profile': 'coding-fast', 'run-agent-prompt': 'Summarise the README.', 'run-agent-context': 'codex' });
      for (const id of ['run-agent-ttl', 'run-agent-max-cost', 'run-agent-max-input', 'run-agent-max-output']) q(`#${id}`).value = q(`#${id}`).getAttribute('value') ?? '';
    };
    return { controller, dialog, form, api, spawn, announce, onSpawned, q, submit, fill, fillDefaults };
  }

  it('opens on the eligible workspace and profile, then spawns in the routed workspace', async () => {
    const view = mount();
    const trigger = { focus: vi.fn() };
    await view.controller.open({ workspaceId: otherWorkspaceId, trigger });
    expect(view.dialog.open).toBe(true);
    // The requested workspace uses dependency access, so the first eligible one is chosen instead.
    expect(view.q(`option[value="${workspaceId}"]`).hasAttribute('selected')).toBe(true);
    expect(view.q('option[value="coding-fast"]').hasAttribute('selected')).toBe(true);
    expect(view.q('#run-agent-prompt').focus).toHaveBeenCalled();

    view.fillDefaults();
    await view.submit();
    expect(view.spawn).toHaveBeenCalledTimes(1);
    const [path, body] = view.spawn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe(`/workspaces/${workspaceId}/agents`);
    expect(body).toMatchObject({ prompt: 'Summarise the README.', profileId: 'coding-fast', proxyOperations: ['files_list', 'files_read', 'grep_search'], idempotencyKey: 'key-1', ttlSeconds: 900 });
    expect(body).not.toHaveProperty('workspaceId');
    expect(view.dialog.open).toBe(false);
    expect(trigger.focus).toHaveBeenCalled();
    expect(view.announce).toHaveBeenCalledWith('Agent started.');
    expect(view.onSpawned).toHaveBeenCalledWith({ agentId: `agent_${'b'.repeat(24)}`, workspaceId });
  });

  it('shows field errors without sending, and reuses one key only for an unchanged retry', async () => {
    let failures = 1;
    const view = mount({ spawn: async () => { if (failures-- > 0) throw new Error('network lost'); return { data: { agentId: `agent_${'d'.repeat(24)}`, replayed: true } }; } });
    await view.controller.open({ workspaceId });
    view.fillDefaults();
    view.fill({ 'run-agent-prompt': '' });
    await view.submit();
    expect(view.spawn).not.toHaveBeenCalled();
    expect(view.q('#run-agent-status').textContent).toBe('Fix the highlighted fields.');
    expect(view.q('#run-agent-prompt-error').textContent).toBe('Describe the task.');

    view.fillDefaults();
    await view.submit();
    expect(view.q('#run-agent-status').textContent).toBe('network lost');
    expect(view.dialog.open).toBe(true);
    await view.submit();
    const keys = view.spawn.mock.calls.map((call) => (call as unknown as [string, { idempotencyKey: string }])[1].idempotencyKey);
    expect(keys).toEqual(['key-1', 'key-1']);
    expect(view.announce).toHaveBeenCalledWith('This run was already started; opening it.');

    // A changed body after a failure gets a new key rather than a CONFLICT on the old one.
    failures = 1;
    await view.controller.open({ workspaceId });
    view.fillDefaults();
    await view.submit();
    view.fill({ 'run-agent-prompt': 'Something else.' });
    await view.submit();
    const later = view.spawn.mock.calls.slice(2).map((call) => (call as unknown as [string, { idempotencyKey: string }])[1].idempotencyKey);
    expect(later).toEqual(['key-2', 'key-3']);
  });

  it('keeps an unconfirmed start across closing and reopening, so the retry replays it', async () => {
    let failures = 1;
    const view = mount({ spawn: async () => { if (failures-- > 0) throw new Error('The connection was lost.'); return { data: { agentId: `agent_${'d'.repeat(24)}`, replayed: true } }; } });
    await view.controller.open({ workspaceId });
    view.fillDefaults();
    view.fill({ 'run-agent-prompt': 'Fix the flaky test.' });
    await view.submit();
    view.q('#cancel-run-agent').dispatch('click', {});
    expect(view.dialog.open).toBe(false);

    await view.controller.open({ workspaceId });
    expect(view.q('#run-agent-status').textContent).toContain('The last start was not confirmed');
    expect(view.q('#run-agent-prompt').textContent).toBe('Fix the flaky test.');
    expect(view.q('#submit-run-agent').focus).toHaveBeenCalled();
    view.fillDefaults();
    view.fill({ 'run-agent-prompt': 'Fix the flaky test.' });
    await view.submit();
    const keys = view.spawn.mock.calls.map((call) => (call as unknown as [string, { idempotencyKey: string }])[1].idempotencyKey);
    expect(keys).toEqual(['key-1', 'key-1']);

    // Confirmed, so the next opening starts fresh.
    await view.controller.open({ workspaceId });
    expect(view.q('#run-agent-status').textContent).toBe('');
  });

  it('drops the key after a refusal, which created nothing', async () => {
    let refusals = 1;
    const view = mount({ spawn: async () => { if (refusals-- > 0) throw Object.assign(new Error('agent model profile is DISABLED'), { status: 400 }); return { data: { agentId: `agent_${'d'.repeat(24)}` } }; } });
    await view.controller.open({ workspaceId });
    view.fillDefaults();
    await view.submit();
    expect(view.q('#run-agent-status').textContent).toBe('agent model profile is DISABLED');
    await view.submit();
    const keys = view.spawn.mock.calls.map((call) => (call as unknown as [string, { idempotencyKey: string }])[1].idempotencyKey);
    expect(keys).toEqual(['key-1', 'key-2']);
    expect(spawnRefused({ status: 409 })).toBe(true);
    expect(spawnRefused({ status: 408 })).toBe(false);
    expect(spawnRefused({ status: 502 })).toBe(false);
    expect(spawnRefused(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('cannot submit what the previous opening showed while fresh choices load', async () => {
    const view = mount();
    await view.controller.open({ workspaceId });
    view.fillDefaults();
    let release: () => void = () => {};
    view.api.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ data: { workspaces: [workspace()] } }); }));
    const opening = view.controller.open({ workspaceId });
    expect(view.q('#submit-run-agent').disabled).toBe(true);
    expect(view.dialog.querySelector('#run-agent-prompt')).toBeNull();
    view.form.dispatch('submit', { preventDefault: vi.fn() });
    release();
    await opening;
    expect(view.spawn).not.toHaveBeenCalled();
    expect(view.q('#submit-run-agent').disabled).toBe(false);
  });

  it('follows the workspace page cursor', async () => {
    const pages: Record<string, unknown> = {
      '/workspaces': { data: { workspaces: [workspace({ workspaceId: otherWorkspaceId })] }, cursor: '100' },
      '/workspaces?cursor=100': { data: { workspaces: [workspace()] } }
    };
    const api = vi.fn(async (path: string) => pages[path]);
    expect((await listWorkspaces(api)).map((entry) => entry.workspaceId)).toEqual([otherWorkspaceId, workspaceId]);
    const endless = vi.fn(async () => ({ data: { workspaces: [] }, cursor: 'again' }));
    await listWorkspaces(endless, 3);
    expect(endless).toHaveBeenCalledTimes(3);
  });

  it('says how to proceed when no workspace can run agents', async () => {
    const view = mount({ workspaces: [workspace({ networkProfile: 'dependency-access' })] });
    await view.controller.open({});
    expect(view.q('#run-agent-workspace').focus).toHaveBeenCalled();
    expect(view.dialog.querySelector('#run-agent-body')!.textContent).toContain('Open one with Network profile “No network” first.');
    view.fill({ 'run-agent-prompt': 'x', 'run-agent-workspace': '' });
    await view.submit();
    expect(view.spawn).not.toHaveBeenCalled();
    expect(view.q('#run-agent-workspaceId-error').textContent).toBe('Choose a workspace.');
  });
});

describe('live agent refresh', () => {
  const running = { agent: { status: 'RUNNING' } };
  function harness(overrides: Record<string, unknown> = {}) {
    vi.useFakeTimers();
    const fetchDetail = vi.fn(async () => running);
    const render = vi.fn();
    const onExhausted = vi.fn();
    const refresh = createAgentRefresh({ fetchDetail, render, onExhausted, intervalMs: 1_000, limit: 3, ...overrides });
    return { refresh, fetchDetail, render, onExhausted };
  }
  afterEach(() => { vi.useRealTimers(); });

  it('re-renders on a bounded timer and says when it stops', async () => {
    const { refresh, render, onExhausted } = harness();
    refresh.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(render).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('stops at a terminal status', async () => {
    const { refresh, render, onExhausted } = harness({ fetchDetail: vi.fn(async () => ({ agent: { status: 'SUCCEEDED' } })) });
    refresh.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(render).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('waits while the operator is busy and retries after a failed read', async () => {
    let busy = true;
    const fetchDetail = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(running);
    const { refresh, render } = harness({ shouldDefer: () => busy, fetchDetail, limit: 10 });
    refresh.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchDetail).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('never renders a read that resolves after it was stopped', async () => {
    let resolve: (value: unknown) => void = () => {};
    const fetchDetail = vi.fn(() => new Promise((done) => { resolve = done; }));
    const { refresh, render } = harness({ fetchDetail });
    refresh.start();
    const before = refresh.generation();
    await vi.advanceTimersByTimeAsync(1_000);
    refresh.stop();
    expect(refresh.generation()).not.toBe(before);
    resolve(running);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(render).not.toHaveBeenCalled();
  });
});
