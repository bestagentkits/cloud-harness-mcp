import { describe, expect, it, vi } from 'vitest';
import {
  apiKeyCreateInput, conflictRecovery, createApiKeyRevealController, createAsyncDialogController, createModalController, githubCallbackParameters,
  parseDotEnv, renderWorkspaceDrawer, resetWriteOnlyFields, submitPatchEdit, submitPatchForm, validateSecretClient
} from '../dashboard/dashboard.js';
import { renderApiKeyIndex, renderGitHub, renderOverview, renderProfile, renderProjectDetail } from '../dashboard/dashboard-render.js';

class FakeElement {
  hidden = false;
  inert = false;
  disabled = false;
  open = false;
  textContent = '';
  value = '';
  items: FakeElement[] = [];
  focus = vi.fn();
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll() { return this.items; }
  addEventListener(name: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(name) ?? new Set(); listeners.add(listener); this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string, event: any) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

describe('dashboard UI behavior', () => {
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
      _html: '',
      set innerHTML(value: string) { this._html = value; },
      get innerHTML() { return this._html; },
      querySelector: (selector: string) => selector === '#workspace-detail-title' && detail.innerHTML.includes('workspace-detail-title') ? heading : null
    });
    const trigger = Object.assign(new FakeElement(), { href: `https://dashboard.example/dashboard/workspaces/ws_${'a'.repeat(24)}` });
    const event = { currentTarget: trigger as FakeElement | null };
    const content = { querySelector: vi.fn().mockReturnValue(null) };
    const fetchWorkspace = vi.fn(async () => {
      event.currentTarget = null;
      return {
        workspaceId: `ws_${'a'.repeat(24)}`, repositoryUrl: 'https://github.com/acme/control-plane.git', status: 'ACTIVE',
        networkMode: 'none', createdAt: '2026-08-17T00:00:00Z', lastActivityAt: '2026-08-17T00:01:00Z', expiresAt: '2026-08-17T01:00:00Z', version: 3
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
    expect(html).toContain('Reconcile all installations');
    expect(html).toContain('repo1');
    expect(html).toContain('repo2');
  });

  it('renders a friendly placeholder when no GitHub installations are bound', () => {
    const html = renderGitHub({ configured: true, installations: [], repositories: [] });
    expect(html).toContain('No GitHub App installation is bound to this identity.');
    expect(html).toContain('disabled');
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
    expect(validateSecretClient('PATH', 'val')).toContain('reserved');
    expect(validateSecretClient('HARNESS_TOKEN', 'val')).toContain('reserved prefix');
    expect(validateSecretClient('123_INVALID', 'val')).toContain('identifier');
    expect(validateSecretClient('EMPTY_VAL', '')).toContain('empty');
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
});
