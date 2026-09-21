import { describe, expect, it, vi } from 'vitest';
import {
  apiKeyCreateInput, conflictRecovery, createApiKeyRevealController, createAsyncDialogController, createModalController, githubCallbackParameters,
  parseDotEnv, renderWorkspaceDrawer, resetWriteOnlyFields, submitPatchEdit, submitPatchForm, validateSecretClient,
  THEME_ORDER, nextTheme, themeActionLabel,
  PALETTE_BATCH_SIZE, chunkPaletteRequests, isPaletteHotkey, buildPaletteIndex, rankPaletteMatches,
  createPaletteIndexLoader, backdropHit, dismissOnBackdrop
} from '../dashboard/dashboard.js';
import { renderApiKeyIndex, renderGitHub, renderGitHubActions, renderGlobalSecrets, renderOverview, renderPaletteResults, renderProfile, renderProjectDetail, renderSettings, renderWorkspaceDetail, profileDisplayName } from '../dashboard/dashboard-render.js';
import { FakeElement } from './dashboard-test-dom.js';

describe('dashboard UI behavior', () => {
  it('cycles the three theme states in order and names the next action', () => {
    expect(THEME_ORDER).toEqual(['system', 'light', 'dark']);
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    // An unknown or absent current state is treated as system, so the first press moves to light.
    expect(nextTheme(undefined)).toBe('light');
    expect(nextTheme('neon')).toBe('light');
    expect(themeActionLabel('dark')).toBe('Theme: dark. Activate to switch to system.');
    expect(themeActionLabel(undefined)).toBe('Theme: system. Activate to switch to light.');
  });

  it('detects the palette hotkey across platforms and ignores partial matches', () => {
    expect(isPaletteHotkey({ metaKey: true, key: 'k' })).toBe(true);
    expect(isPaletteHotkey({ ctrlKey: true, key: 'K' })).toBe(true);
    expect(isPaletteHotkey({ key: 'k' })).toBe(false);
    expect(isPaletteHotkey({ metaKey: true, altKey: true, key: 'k' })).toBe(false);
    expect(isPaletteHotkey({ ctrlKey: true, key: 'j' })).toBe(false);
    expect(isPaletteHotkey({})).toBe(false);
    expect(isPaletteHotkey(undefined)).toBe(false);
    expect(isPaletteHotkey(null)).toBe(false);
  });

  it('batches palette requests below the concurrent principal limit', () => {
    const requests = Array.from({ length: 7 }, (_, index) => ({ key: `s${index}` }));
    const batches = chunkPaletteRequests(requests);
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(PALETTE_BATCH_SIZE);
    expect(batches.flat().map((request) => request.key)).toEqual(requests.map((request) => request.key));
    expect(chunkPaletteRequests([])).toEqual([]);
  });

  it('indexes page commands plus allowlisted resource projections only', () => {
    const workspaceId = `ws_${'a'.repeat(24)}`;
    const projectId = `prj_${'b'.repeat(24)}`;
    const index = buildPaletteIndex({
      workspaces: [{ workspaceId, repositoryUrl: 'https://github.com/org/repo.git', status: 'ACTIVE' }],
      projects: [{ id: projectId, name: 'Alpha', generation: 2 }],
      secrets: [{ name: 'OPENAI_KEY', description: 'leaked-note-marker' }],
      apiKeys: [{ id: 'apk_abcdefghijklmnopqrst', name: 'laptop', state: 'ACTIVE', generation: 3 }],
      credentials: [{ id: `cred_${'d'.repeat(24)}`, label: 'Prod OpenAI', provider: 'openai', activeVersion: 4 }],
      profiles: [{ id: 'coding-fast', displayName: 'Fast Coding', status: 'ACTIVE' }],
      artifacts: [{ artifactId: `art_${'c'.repeat(24)}`, logicalName: 'build.log' }],
      // Not an indexed source: must be ignored entirely.
      knowledge: [{ id: 'kn_abc', title: 'Memory', content: 'secret-content-marker' }]
    });

    const hrefs = index.map((entry) => entry.href);
    expect(hrefs).toContain('/dashboard');
    expect(hrefs).toContain(`/dashboard/workspaces/${workspaceId}`);
    expect(hrefs).toContain(`/dashboard/projects/${projectId}`);
    expect(hrefs).toContain('/dashboard/secrets');
    expect(hrefs).toContain('/dashboard/api-keys');
    expect(hrefs).toContain('/dashboard/models');
    expect(hrefs).toContain('/dashboard/artifacts');

    const workspace = index.find((entry) => entry.group === 'Workspaces');
    expect(workspace.label).toBe('org/repo');
    expect(workspace.hint).toBe(workspaceId);
    const secret = index.find((entry) => entry.group === 'Secrets');
    expect(secret.label).toBe('OPENAI_KEY');
    expect(secret.hint).toBe('Global secret');

    // Free text the palette must never carry into its index.
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain('leaked-note-marker');
    expect(serialized).not.toContain('secret-content-marker');
  });

  it('tolerates a missing source and caps per-source and rendered counts', () => {
    const index = buildPaletteIndex({ workspaces: undefined, knowledge: undefined });
    expect(index.every((entry) => entry.group === 'Pages')).toBe(true);

    const workspaces = Array.from({ length: 250 }, (_, position) => ({
      workspaceId: `ws_${String(position).padStart(24, '0')}`,
      repositoryUrl: `https://github.com/org/repo-${position}.git`
    }));
    const capped = buildPaletteIndex({ workspaces });
    expect(capped.filter((entry) => entry.group === 'Workspaces')).toHaveLength(200);
    expect(rankPaletteMatches(capped, '').length).toBe(50);
  });

  it('ranks prefix matches above word-start matches and bounds the result set', () => {
    const index = buildPaletteIndex({
      projects: [{ id: `prj_${'1'.repeat(24)}`, name: 'zebra-alpha' }, { id: `prj_${'2'.repeat(24)}`, name: 'alpha-zebra' }]
    });
    const labels = rankPaletteMatches(index, 'alpha').map((entry) => entry.label);
    expect(labels).toContain('alpha-zebra');
    expect(labels).toContain('zebra-alpha');
    expect(labels.indexOf('alpha-zebra')).toBeLessThan(labels.indexOf('zebra-alpha'));
    expect(rankPaletteMatches(index, 'nothing-matches-this').length).toBe(0);
  });

  const paletteRequests = (count = 5) => Array.from({ length: count }, (_, index) => ({ key: `s${index}`, path: `/s${index}`, rows: 'rows' }));

  it('fetches the palette index in sequential batches and shares one load between callers', async () => {
    const requests = paletteRequests();
    const seen: string[] = [];
    const gate = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const loader = createPaletteIndexLoader({
      requests,
      fetchRows: async (request) => {
        seen.push(request.key);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return [];
      },
      buildIndex: () => [],
      now: () => 0
    });

    const first = loader.ensure();
    const second = loader.ensure();
    // A batch invokes its members synchronously, so the in-flight count is observable
    // before anything settles. A whole-fan-out implementation would show all five.
    expect(peak).toBe(PALETTE_BATCH_SIZE);
    gate.resolve();
    const [firstIndex, secondIndex] = await Promise.all([first, second]);

    expect(peak).toBe(PALETTE_BATCH_SIZE);
    // Concurrent callers share the single in-flight load.
    expect(seen).toHaveLength(requests.length);
    expect(firstIndex).toBe(secondIndex);
  });

  it('refetches every source once the palette snapshot outlives its TTL', async () => {
    const requests = paletteRequests();
    const seen: string[] = [];
    const rows: Record<string, unknown[]> = { s0: [{ id: 'before' }] };
    let clock = 0;
    const loader = createPaletteIndexLoader({
      requests,
      fetchRows: async (request) => { seen.push(request.key); return rows[request.key] ?? []; },
      buildIndex: (sources) => sources.s0 ?? [],
      now: () => clock
    });

    expect(await loader.ensure()).toEqual([{ id: 'before' }]);
    expect(seen).toHaveLength(requests.length);

    // Inside the window the cached snapshot is served without touching the network.
    await loader.ensure();
    expect(seen).toHaveLength(requests.length);

    clock = 61_000;
    rows.s0 = [{ id: 'after' }];
    expect(await loader.ensure()).toEqual([{ id: 'after' }]);
    expect(seen).toHaveLength(requests.length * 2);
  });

  it('retries only the failed sources and keeps the successful ones', async () => {
    const requests = paletteRequests();
    const seen: string[] = [];
    let throttleProjects = true;
    const loader = createPaletteIndexLoader({
      requests,
      fetchRows: async (request) => {
        seen.push(request.key);
        if (request.key === 's1' && throttleProjects) {
          throttleProjects = false;
          throw new Error('rate_limited');
        }
        return [{ key: request.key }];
      },
      buildIndex: (sources) => Object.values(sources).flat(),
      now: () => 0
    });

    const first = await loader.ensure();
    // The throttled source is absent but never cached as an empty list.
    const firstKeys = first.map((row: { key: string }) => row.key);
    expect(firstKeys).not.toContain('s1');
    expect(firstKeys).toContain('s0');
    expect(seen.filter((key) => key === 's1')).toHaveLength(1);

    const second = await loader.ensure();
    // Only the pending source is retried; the successful ones are not refetched.
    expect(seen.filter((key) => key === 's1')).toHaveLength(2);
    expect(seen.filter((key) => key === 's0')).toHaveLength(1);
    expect(second.map((row: { key: string }) => row.key)).toContain('s1');
  });

  it('converges on the current generation through repeated supersession', async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let call = 0;
    const loader = createPaletteIndexLoader({
      requests: paletteRequests(1),
      fetchRows: async () => {
        call += 1;
        const issued = call;
        await gates[issued - 1]?.promise;
        return [{ id: issued }];
      },
      buildIndex: (sources) => sources.s0 ?? [],
      now: () => 0
    });
    // Microtask yield only: no wall-clock wait, and it terminates as soon as the
    // expected pass starts.
    const untilCall = async (expected: number) => {
      for (let spin = 0; spin < 200 && call < expected; spin += 1) await Promise.resolve();
      expect(call).toBeGreaterThanOrEqual(expected);
    };

    const inFlight = loader.ensure();
    // The first fetch starts synchronously, so no yield is needed before invalidating.
    expect(call).toBe(1);

    // Supersede the first pass, then supersede its replacement as well. A loader with
    // a fixed replacement budget would give up here and resolve with stale data.
    loader.invalidate();
    loader.invalidate();
    gates[0].resolve();
    await untilCall(2);

    loader.invalidate();
    gates[1].resolve();
    await untilCall(3);

    gates[2].resolve();
    expect(await inFlight).toEqual([{ id: 3 }]);
  });

  it('escapes palette labels and marks exactly one active option', () => {
    const markup = renderPaletteResults([
      { id: 'a', group: 'Secrets', label: '<img src=x onerror=alert(1)>', hint: 'Global secret', href: '/dashboard/secrets' },
      { id: 'b', group: 'Projects', label: 'Alpha', hint: 'prj_1', href: '/dashboard/projects/prj_1' }
    ], 1);
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect((markup.match(/aria-selected="true"/g) ?? [])).toHaveLength(1);
    expect((markup.match(/aria-selected="false"/g) ?? [])).toHaveLength(1);
    expect((markup.match(/role="option"/g) ?? [])).toHaveLength(2);
  });

  it('closes the command palette on a backdrop tap or click and ignores everything else', () => {
    const dialog = new FakeElement();
    dialog.bounds = { top: 100, bottom: 240, left: 50, right: 450 };
    const dismiss = vi.fn();
    dismissOnBackdrop(dialog, dismiss);
    const inside = { target: dialog, clientX: 200, clientY: 150 };
    const outside = { target: dialog, clientX: 10, clientY: 10 };
    const inner = { target: { tagName: 'INPUT' }, clientX: 200, clientY: 150 };

    expect(backdropHit(inside, dialog.bounds)).toBe(false);
    expect(backdropHit(outside, dialog.bounds)).toBe(true);
    expect(backdropHit(outside, undefined)).toBe(true);

    // A click inside the dialog box is content, not backdrop.
    dialog.dispatch('pointerdown', inside); dialog.dispatch('click', inside);
    expect(dismiss).not.toHaveBeenCalled();

    // A drag that starts inside the palette and ends outside it stays open.
    dialog.dispatch('pointerdown', inside); dialog.dispatch('click', outside);
    expect(dismiss).not.toHaveBeenCalled();

    // A backdrop tap dismisses on the matching click.
    dialog.dispatch('pointerdown', outside); dialog.dispatch('click', outside);
    expect(dismiss).toHaveBeenCalledOnce();

    // A stray click with no matching pointerdown never dismisses.
    dialog.dispatch('click', outside);
    expect(dismiss).toHaveBeenCalledOnce();

    // Clicks that land on the palette's own children never dismiss.
    dialog.dispatch('pointerdown', inner); dialog.dispatch('click', inner);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('exposes the settings page to the command palette with its label and href', () => {
    const index = buildPaletteIndex({});
    const entry = index.find((item: { id: string }) => item.id === 'page:settings');
    expect(entry).toMatchObject({
      id: 'page:settings', group: 'Pages', label: 'Settings',
      hint: 'Instance defaults for workspaces and network egress', href: '/dashboard/settings'
    });

    // Selecting the entry navigates through the href the palette renders as data-href.
    expect(rankPaletteMatches(index, 'settings').map((item: { href: string }) => item.href)).toContain('/dashboard/settings');
    const markup = renderPaletteResults([entry], 0);
    expect(markup).toContain('>Settings<');
    expect(markup).toContain('data-href="/dashboard/settings"');
    expect(markup).toContain('role="option"');
  });

  it('marks the stored default network profile selected and falls back to the runner default', () => {
    const stored = renderSettings({ defaultNetworkProfile: { value: 'network-none', source: 'setting' } });
    expect(stored).toContain('id="settings-network-profile"');
    expect(stored).toMatch(/<option value="network-none" selected>/);
    expect(stored).not.toMatch(/<option value="dependency-access" selected>/);
    expect(stored).not.toMatch(/<option value="" selected>/);
    expect(stored).toContain('Set in this dashboard');
    expect(stored).toContain('No network');
    expect(stored).toContain('id="settings-status"');

    const runnerDefault = renderSettings({ defaultNetworkProfile: { value: 'dependency-access', source: 'environment' } });
    expect(runnerDefault).toMatch(/<option value="" selected>/);
    expect(runnerDefault).not.toMatch(/<option value="dependency-access" selected>/);
    expect(runnerDefault).toContain('Runner default (WORKSPACE_NETWORK_PROFILE or built-in)');
    expect(runnerDefault).toContain('Dependency access');
    expect(runnerDefault).toContain('Use runner default');
  });

  it('states the credential-exfiltration tradeoff and escapes the readiness reason', () => {
    const html = renderSettings(
      { defaultNetworkProfile: { value: 'dependency-access', source: 'setting' } },
      { ready: false, reason: '<script>egress</script>' }
    );
    expect(html).toContain('exfiltrate');
    expect(html).toContain('GH_TOKEN');
    expect(html).toContain('A fine-grained token');
    expect(html).toContain('Not ready:');
    expect(html).not.toContain('<script>egress</script>');
    expect(html).toContain('&lt;script&gt;egress&lt;/script&gt;');

    // No readiness line is rendered until the check has run.
    expect(renderSettings({ defaultNetworkProfile: { value: 'dependency-access', source: 'setting' } })).not.toContain('Egress readiness');
    expect(renderSettings({ defaultNetworkProfile: { value: 'dependency-access', source: 'setting' } }, { ready: true, reason: null })).toContain('Ready');
  });

  it('warns about executor network access only for the dependency-access profile', () => {
    const workspace = {
      workspaceId: `ws_${'a'.repeat(24)}`, repositoryUrl: 'https://github.com/org/repo.git', status: 'ACTIVE',
      createdAt: '2026-08-17T00:00:00.000Z', lastActivityAt: '2026-08-17T00:01:00.000Z', expiresAt: '2026-08-17T01:00:00.000Z', version: 3
    };
    expect(renderWorkspaceDetail({ ...workspace, networkProfile: 'dependency-access' })).toContain('Executor network access is enabled');
    expect(renderWorkspaceDetail({ ...workspace, networkProfile: 'network-none' })).not.toContain('Executor network access is enabled');
    // A legacy record still carrying the retired field no longer implies egress.
    expect(renderWorkspaceDetail({ ...workspace, networkMode: 'bridge' })).not.toContain('Executor network access is enabled');
    expect(renderWorkspaceDetail({ ...workspace, networkMode: 'bridge' })).toContain('Network');
  });

  it('prefers an operator display name over the verified sign-on name', () => {
    const identity = { name: 'Op Erator', email: 'op@example.com' };
    expect(profileDisplayName({ identity, preferences: { displayName: 'Ops Lead' } })).toBe('Ops Lead');
    expect(profileDisplayName({ identity, preferences: { displayName: '  ' } })).toBe('Op Erator');
    expect(profileDisplayName({ identity })).toBe('Op Erator');
    expect(profileDisplayName({ identity: { email: 'op@example.com' } })).toBe('op@example.com');
    expect(profileDisplayName({})).toBe('Signed in');
  });

  it('offers an editable display name while keeping the verified assertion read-only', () => {
    const html = renderProfile({
      identity: { name: 'Op Erator', email: 'op@example.com', subject: 'operator', issuer: 'https://team.cloudflareaccess.com' },
      preferences: { displayName: 'Ops Lead' },
      scopes: [], sessionExpiresAt: null
    });
    expect(html).toContain('id="profile-name-form"');
    expect(html).toContain('id="save-display-name"');
    expect(html).toContain('id="clear-display-name"');
    expect(html).toContain('value="Ops Lead"');
    expect(html).toContain('Use sign-on name');
    expect(html).toContain('op@example.com');
    expect(html).toContain('Identity provider');
    expect(renderProfile({ preferences: { displayName: '"><script>alert(1)</script>' } })).not.toContain('<script>');
  });

  it('traps modal focus, inerts the background, and restores its invoking control', () => {
    const panel = new FakeElement(); const first = new FakeElement(); const last = new FakeElement();
    const background = new FakeElement(); const trigger = new FakeElement(); panel.items = [first, last];
    const modal = createModalController({ panel, backgrounds: [background], trigger, initialFocus: () => first });

    modal.open();
    expect(background.inert).toBe(true);
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(first.focus).toHaveBeenCalledOnce();

    const tab = { key: 'Tab', shiftKey: false, target: last, preventDefault: vi.fn() };
    panel.dispatch('keydown', tab);
    expect(tab.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledTimes(2);

    panel.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });
    expect(background.inert).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('keeps confirmation open and non-dismissible until the mutation settles', async () => {
    const dialog = new FakeElement(); const cancel = new FakeElement(); const action = new FakeElement();
    const status = new FakeElement(); const invoker = new FakeElement();
    let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
    const controller = createAsyncDialogController({ dialog, cancelButton: cancel, actionButton: action, status, reportError: vi.fn() });
    controller.open({ label: 'Close workspace', pendingLabel: 'Closing…', action: () => pending }, invoker);

    const submission = controller.submit();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(cancel.disabled).toBe(true);
    expect(action.disabled).toBe(true);
    expect(action.textContent).toBe('Closing…');
    controller.cancel();
    expect(dialog.open).toBe(true);

    finish(); await submission;
    expect(dialog.open).toBe(false);
    expect(controller.submitting).toBe(false);
  });

  it('restores focus after a failed destructive mutation', async () => {
    const dialog = new FakeElement(); const cancel = new FakeElement(); const action = new FakeElement();
    const status = new FakeElement(); const invoker = new FakeElement(); const reportError = vi.fn();
    const controller = createAsyncDialogController({ dialog, cancelButton: cancel, actionButton: action, status, reportError });
    const failure = new Error('conflict');
    controller.open({ label: 'Delete file', pendingLabel: 'Deleting…', action: async () => { throw failure; } }, invoker);
    await controller.submit();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(invoker.focus).toHaveBeenCalledOnce();
  });

  it('preserves the exact local edit for conflict copy and waits for an explicit recovery choice', async () => {
    const actions = { reviewLatest: vi.fn(), copyChanges: vi.fn(), cancel: vi.fn() };
    const recovery = conflictRecovery('unsaved\nlocal\ncontent', actions);
    expect(actions.copyChanges).not.toHaveBeenCalled();
    await recovery.copyChanges();
    expect(actions.copyChanges).toHaveBeenCalledWith('unsaved\nlocal\ncontent');
    recovery.reviewLatest(); recovery.cancel();
    expect(actions.reviewLatest).toHaveBeenCalledOnce();
    expect(actions.cancel).toHaveBeenCalledOnce();
  });

  it('routes a PATCH 409 with both unsaved fields into conflict recovery', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('changed'), { status: 409 }));
    const onSaved = vi.fn(); const onConflict = vi.fn(); const onError = vi.fn();
    await submitPatchEdit({
      workspaceId: `ws_${'a'.repeat(24)}`,
      file: { path: 'README.md', sha256: 'b'.repeat(64) },
      oldText: 'original target', newText: 'unsaved replacement', request, onSaved, onConflict, onError
    });

    expect(request).toHaveBeenCalledWith(`/workspaces/ws_${'a'.repeat(24)}/files/content`, {
      method: 'PATCH',
      body: JSON.stringify({ path: 'README.md', oldText: 'original target', newText: 'unsaved replacement', expectedSha256: 'b'.repeat(64) })
    });
    expect(onConflict).toHaveBeenCalledWith({
      oldText: 'original target', newText: 'unsaved replacement',
      copyText: 'Text to replace:\noriginal target\n\nReplacement text:\nunsaved replacement'
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the PATCH form and focus target across an async conflict response', async () => {
    const invoker = new FakeElement();
    const form = { querySelector: vi.fn().mockReturnValue(invoker) };
    const event = { currentTarget: form as typeof form | null };
    class FakeFormData {
      get(name: string) { return name === 'oldText' ? 'target kept' : 'replacement kept'; }
    }
    vi.stubGlobal('FormData', FakeFormData);
    let rejectRequest!: (error: Error) => void;
    const request = vi.fn(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const onConflict = vi.fn();
    try {
      const submission = submitPatchForm({
        form: event.currentTarget, workspaceId: `ws_${'a'.repeat(24)}`,
        file: { path: 'README.md', sha256: 'b'.repeat(64) }, request,
        onSaved: vi.fn(), onConflict, onError: vi.fn()
      });
      event.currentTarget = null;
      rejectRequest(Object.assign(new Error('changed'), { status: 409 }));
      await submission;
    } finally { vi.unstubAllGlobals(); }

    expect(event.currentTarget).toBeNull();
    expect(onConflict).toHaveBeenCalledWith({
      oldText: 'target kept', newText: 'replacement kept',
      copyText: 'Text to replace:\ntarget kept\n\nReplacement text:\nreplacement kept'
    }, invoker);
  });

  it('keeps the clicked link across an async drawer fetch and renders its required heading', async () => {
    const heading = new FakeElement();
    const detail = Object.assign(new FakeElement(), {
      querySelector: (selector: string) => selector === '#workspace-detail-title' && detail.innerHTML.includes('workspace-detail-title') ? heading : null
    });
    const trigger = Object.assign(new FakeElement(), { href: `https://dashboard.example/dashboard/workspaces/ws_${'a'.repeat(24)}` });
    const event = { currentTarget: trigger as FakeElement | null };
    const content = { querySelector: vi.fn().mockReturnValue(null) };
    const fetchWorkspace = vi.fn(async () => {
      event.currentTarget = null;
      return {
        workspaceId: `ws_${'a'.repeat(24)}`, repositoryUrl: 'https://github.com/acme/control-plane.git', status: 'ACTIVE',
        networkProfile: 'network-none', createdAt: '2026-08-17T00:00:00Z', lastActivityAt: '2026-08-17T00:01:00Z', expiresAt: '2026-08-17T01:00:00Z', version: 3
      };
    });

    const result = await renderWorkspaceDrawer({ trigger: event.currentTarget, detail, content, fetchWorkspace, modal: true });
    expect(event.currentTarget).toBeNull();
    expect(trigger.getAttribute('aria-current')).toBe('true');
    expect(result.heading).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(detail.innerHTML).toContain('acme/control-plane');
  });

  it('parses only a complete GitHub App callback pair', () => {
    expect(githubCallbackParameters('?state=state-value&installation_id=12345')).toEqual({ state: 'state-value', installationId: '12345' });
    expect(githubCallbackParameters('?state=state-value')).toBeUndefined();
    expect(githubCallbackParameters('?installation_id=12345')).toBeUndefined();
  });

  it('renders multiple GitHub installations with per-installation action controls', () => {
    const status = {
      configured: true,
      installations: [
        { appId: '1', installationId: '101', accountId: '201', accountLogin: 'mrgoonie', status: 'active', checkedAt: 1_700_000_000_000 },
        { appId: '1', installationId: '102', accountId: '202', accountLogin: 'bestagentkits', status: 'active', checkedAt: 1_700_000_000_000 }
      ],
      repositories: [
        { installationId: '101', owner: 'mrgoonie', repository: 'repo1', contents: 'write', status: 'granted' },
        { installationId: '102', owner: 'bestagentkits', repository: 'repo2', contents: 'read', status: 'granted' }
      ]
    };
    const html = renderGitHub(status);
    expect(html).toContain('mrgoonie');
    expect(html).toContain('bestagentkits');
    expect(html).toContain('data-installation-id="101"');
    expect(html).toContain('data-installation-id="102"');
    expect(html).toContain('class="reconcile-installation"');
    expect(html).toContain('class="danger disconnect-installation"');
    // The reconcile action moved to the page's action slot with the rest of the
    // shared resource-page layout, so its label is asserted where it renders.
    expect(renderGitHubActions({ installations: [{ installationId: '101' }, { installationId: '102' }] })).toContain('Reconcile all installations');
    expect(html).toContain('repo1');
    expect(html).toContain('repo2');
  });

  it('renders a friendly placeholder when no GitHub installations are bound', () => {
    const html = renderGitHub({ configured: true, installations: [], repositories: [] });
    expect(html).toContain('No GitHub App installation is bound to this identity.');
    expect(renderGitHubActions({})).toContain('disabled');
  });

  it('clears write-only inputs after secret submission', () => {
    const secret = { value: 'submitted-secret' };
    const ordinary = { value: 'visible-name' };
    const form = { querySelectorAll: (selector: string) => selector === 'input[data-write-only]' ? [secret] : [] };
    resetWriteOnlyFields(form);
    expect(secret.value).toBe('');
    expect(ordinary.value).toBe('visible-name');
  });

  it('never renders secret values returned by a hostile response', () => {
    const html = renderProjectDetail(
      { id: `prj_${'a'.repeat(24)}`, name: 'Application', generation: 2 },
      [{
        id: `env_${'b'.repeat(24)}`, projectId: `prj_${'a'.repeat(24)}`, name: 'Production', generation: 3,
        secrets: [{ name: 'DEPLOY_TOKEN', state: 'active', generation: 4, value: 'must-not-render' }]
      }]
    );
    expect(html).toContain('DEPLOY_TOKEN');
    expect(html).toContain('Write-only');
    expect(html).not.toContain('must-not-render');
    expect(html).not.toContain('value="DEPLOY_TOKEN"');
  });

  it('validates and normalizes API-key creation input without retaining it', () => {
    class FakeFormData {
      constructor(private readonly form: Record<string, unknown>) {}
      get(name: string) {
        if (this.form && typeof this.form[name] === 'string') return this.form[name];
        return name === 'name' ? '  CI client  ' : '30';
      }
    }
    vi.stubGlobal('FormData', FakeFormData);
    try {
      expect(apiKeyCreateInput({})).toEqual({ name: 'CI client', expiresInDays: 30 });
      expect(apiKeyCreateInput({ name: 'Long Lived', expiryDays: '3650' })).toEqual({ name: 'Long Lived', expiresInDays: 3650 });
      expect(() => apiKeyCreateInput({ name: 'Too Long', expiryDays: '3651' })).toThrow('Enter a key name and an expiry from 1 to 3650 whole days.');
      expect(() => apiKeyCreateInput({ name: 'Zero', expiryDays: '0' })).toThrow('Enter a key name and an expiry from 1 to 3650 whole days.');
      expect(() => apiKeyCreateInput({ name: 'Fractional', expiryDays: '30.5' })).toThrow('Enter a key name and an expiry from 1 to 3650 whole days.');
    } finally { vi.unstubAllGlobals(); }
  });
  it('renders API key creation form with max 3650 days', () => {
    const html = renderApiKeyIndex({ keys: [] });
    expect(html).toContain('max="3650"');
    expect(html).toContain('id="api-key-expiry"');
  });


  it('reveals an API key once, copies it, then clears DOM and JS state on acknowledgement', async () => {
    const dialog = new FakeElement(); const secretField = new FakeElement(); const copyButton = new FakeElement();
    const acknowledgeButton = new FakeElement(); const status = new FakeElement(); const invoker = new FakeElement();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }; const reportError = vi.fn();
    const reveal = createApiKeyRevealController({ dialog, secretField, copyButton, acknowledgeButton, status, clipboard, reportError });
    const key = `chm_key_apk_${'a'.repeat(24)}.${'b'.repeat(43)}`;

    expect(() => reveal.open('not-an-api-key', invoker)).toThrow('unavailable');
    expect(secretField.value).toBe('');
    reveal.open(key, invoker); await reveal.copy();
    expect(secretField.value).toBe(key);
    expect(clipboard.writeText).toHaveBeenCalledWith(key);
    expect(status.textContent).toContain('copied');
    acknowledgeButton.dispatch('click', {});
    expect(secretField.value).toBe('');
    expect(dialog.open).toBe(false);
    expect(invoker.focus).toHaveBeenCalledOnce();
    await reveal.copy();
    expect(clipboard.writeText).toHaveBeenCalledOnce();
    reveal.open(key, invoker); reveal.clear();
    expect(secretField.value).toBe('');
    expect(dialog.open).toBe(false);
  });

  it('clears the only API-key copy after clipboard failure and reports no secret', async () => {
    const dialog = new FakeElement(); const secretField = new FakeElement(); const copyButton = new FakeElement();
    const acknowledgeButton = new FakeElement(); const status = new FakeElement(); const invoker = new FakeElement();
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) }; const reportError = vi.fn();
    const reveal = createApiKeyRevealController({ dialog, secretField, copyButton, acknowledgeButton, status, clipboard, reportError });
    const key = `chm_key_apk_${'c'.repeat(24)}.${'d'.repeat(43)}`;

    reveal.open(key, invoker); await reveal.copy();
    expect(secretField.value).toBe('');
    expect(dialog.open).toBe(false);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0][0].message).not.toContain(key);
    await reveal.copy();
    expect(clipboard.writeText).toHaveBeenCalledOnce();
  });

  it('renders only safe API-key metadata and a generation-fenced revoke action', () => {
    const raw = `chm_key_apk_${'e'.repeat(24)}.${'f'.repeat(43)}`;
    const html = renderApiKeyIndex({ publicUrl: 'https://api.example/mcp', keys: [{
      id: `apk_${'e'.repeat(24)}`, name: 'Automation', displayPrefix: 'chm_key_apk_eeee…', state: 'ACTIVE', generation: 3,
      createdAt: 1_786_000_000_000, expiresAt: 1_787_000_000_000, lastUsedAt: null, revokedAt: null,
      apiKey: raw, secretHash: 'must-not-render'
    }] });
    expect(html).toContain('Automation');
    expect(html).toContain('https://api.example/mcp');
    expect(html).toContain('chm_key_apk_eeee…');
    expect(html).toContain('data-generation="3"');
    expect(html).not.toContain(raw);
    expect(html).not.toContain('must-not-render');
  });

  it('escapes attacker-influenceable identity fields and renders scopes and expiry', () => {
    const html = renderProfile({
      identity: { issuer: 'https://team.cloudflareaccess.com', subject: 'operator', email: 'op@example.com', name: '<img src=x onerror=alert(1)>' },
      scopes: ['workspace:read', 'workspace:execute'],
      sessionExpiresAt: '2027-01-15T09:00:00.000Z'
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('op@example.com');
    expect(html).toContain('workspace:execute');
    expect(html).toContain('datetime="2027-01-15T09:00:00.000Z"');
  });

  it('reports missing optional identity fields and no session expiry', () => {
    const html = renderProfile({ identity: { issuer: 'https://team.cloudflareaccess.com', subject: 'operator' }, scopes: [], sessionExpiresAt: null });
    expect(html).toContain('Not provided');
    expect(html).toContain('No scopes reported.');
    expect(html).toContain('Never');
  });

  it('escapes attacker-influenceable overview fields and renders a copy affordance', () => {
    const html = renderOverview({
      metrics: [{ label: 'GitHub', value: '<img src=x onerror=alert(1)>', small: true, note: '<b>x</b>' }],
      activity: [{ action: '<script>a</script>', subjectType: 'workspace', subjectId: '<script>b</script>', createdAt: '2026-01-01T00:00:00.000Z' }],
      access: { name: '<script>n</script>', email: 'op@example.com', sessionExpiresAt: undefined, endpoint: 'https://api.example.com/mcp"><script>' }
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('data-copy="https://api.example.com/mcp&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('Never');
  });
  it('parses .env files with comment-to-description extraction and quote handling', () => {
    const sample = `
# Database connection for staging
# Account: infra-team
DATABASE_URL="postgresql://user:pass@db:5432/app"

# Unrelated section header

API_KEY='sk_live_12345'
export STRIPE_SECRET=whsec_abc
`;
    const parsed = parseDotEnv(sample);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      name: 'DATABASE_URL',
      value: 'postgresql://user:pass@db:5432/app',
      description: 'Database connection for staging / Account: infra-team'
    });
    expect(parsed[1]).toEqual({
      name: 'API_KEY',
      value: 'sk_live_12345',
      description: null
    });
    expect(parsed[2]).toEqual({
      name: 'STRIPE_SECRET',
      value: 'whsec_abc',
      description: null
    });
  });

  it('validates secret names and values client-side against reserved identifiers', () => {
    expect(validateSecretClient('VALID_KEY', 'valid_value')).toBeNull();
    expect(validateSecretClient('PATH', 'valid_val')).toContain('reserved');
    expect(validateSecretClient('HARNESS_TOKEN', 'valid_val')).toContain('reserved prefix');
    expect(validateSecretClient('123_INVALID', 'valid_val')).toContain('identifier');
    expect(validateSecretClient('SHORT_VAL', 'abc')).toContain('at least 4');
    expect(validateSecretClient('NEWLINE_VAL', 'val\n123')).toContain('null or newline');
  });

  it('renders secret descriptions, bulk import and export affordances in project detail', () => {
    const project = { id: 'prj_123', name: 'Core Project', generation: 1 };
    const environments = [{
      id: 'env_456',
      name: 'Staging',
      generation: 2,
      secrets: [{
        id: 'sec_789',
        name: 'SUPABASE_KEY',
        description: 'Supabase API key',
        state: 'ACTIVE',
        version: 1,
        generation: 1
      }]
    }];
    const html = renderProjectDetail(project, environments);
    expect(html).toContain('SUPABASE_KEY');
    expect(html).toContain('Supabase API key');
    expect(html).toContain('Bulk import .env');
    expect(html).toContain('Export .env.example');
    expect(html).toContain('class="update-secret-desc-form');
  });

  it('renders global secrets list, description, rotate, bulk import, and export affordances', () => {
    const secrets = [{
      id: 'gsec_001',
      name: 'GLOBAL_API_KEY',
      description: 'Shared across all workspaces',
      state: 'ACTIVE',
      version: 1,
      generation: 1
    }];
    const html = renderGlobalSecrets(secrets, { ready: true });
    // The page heading is owned by the page registry; the renderer owns the section
    // heading, the filter row and the create dialog.
    expect(html).toContain('Secret references');
    expect(html).toContain('GLOBAL_API_KEY');
    expect(html).toContain('Shared across all workspaces');
    expect(html).toContain('Bulk import .env');
    expect(html).toContain('Export .env.example');
    expect(html).toContain('id="create-global-secret-form"');
    expect(html).toContain('class="rotate-global-secret-form');
    expect(html).toContain('class="update-global-secret-desc-form');
  });
});
