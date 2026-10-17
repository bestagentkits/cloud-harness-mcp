import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAutomationWorkflow, createAutomationConnection, createAutomationRule, deleteAutomationConnection, deleteAutomationRule,
  listAutomationDeliveries, listAutomationRules, listAutomationWorkflows, previewAutomationRule, rotateAutomationConnectionSecret,
  updateAutomationConnection, updateAutomationRule
} from '../dashboard/dashboard-api.js';
import {
  AUTOMATIONS_DISABLED_COPY, automationBlockedState, automationResourceHref, automationSectionForPath, automationWebhookUrl,
  automationWorkflowIsTerminal, renderAutomationBlocked, renderAutomationConnections, renderAutomationDeliveries,
  renderAutomationPreviewDialog, renderAutomationPreviewResult, renderAutomationRuleDialog, renderAutomationRules, renderAutomationRunDetail,
  renderAutomationRuns, renderAutomationSecretPanel, renderAutomationTabs
} from '../dashboard/dashboard-render.js';
import { automationPreviewSample, automationRuleInput, automationRuleUpdateInput, bindAutomationSecretReveal } from '../dashboard/dashboard.js';
import { DASHBOARD_PAGES, navGroups } from '../dashboard/dashboard-pages.js';
import { FakeElement } from './dashboard-test-dom.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
const id = (prefix: string, character: string) => `${prefix}_${character.repeat(32)}`;
const connectionId = id('whc', 'a');
const ruleId = id('arl', 'b');
const workflowId = id('wfl', 'c');
const deliveryId = id('dlv', 'd');
const workspaceId = `ws_${'e'.repeat(24)}`;
const agentId = `agent_${'f'.repeat(24)}`;

const connection = {
  id: connectionId, provider: 'github', name: 'acme GitHub', enabled: true, generation: 3,
  webhookPath: `/hooks/github/${connectionId}`, secretRotatedAt: '2026-10-01T10:00:00.000Z', lastDeliveryAt: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z'
};

const rule = {
  id: ruleId, connectionId, name: 'Triage bugs', enabled: true, generation: 4,
  match: { repository: 'acme/widgets', events: ['issues'], label: 'agent:triage', ignoreBots: true },
  action: {
    profileId: 'coding-fast', instructions: 'Triage the issue.', proxyOperations: ['files_list', 'files_read'],
    budget: { ttlSeconds: 900, maxInputTokens: 200000, maxOutputTokens: 32000, maxCostMicros: 2000000 },
    publishComment: true, cooldownSeconds: 300, maxConcurrent: 1
  },
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z'
};

const workflow = {
  id: workflowId, ruleId, ruleGeneration: 4, connectionId, deliveryId, eventType: 'github.issue.label_added',
  repository: 'acme/widgets', resourceNumber: 42, resourceUrl: 'https://github.com/acme/widgets/issues/42', label: 'agent:triage',
  state: 'RUNNING', workspaceId, agentId, agentStatus: 'RUNNING', errorCode: null, publishState: 'PENDING',
  usage: { inputTokens: 1200, outputTokens: 300, costMicros: 4500 },
  createdAt: '2026-10-03T10:00:00.000Z', updatedAt: '2026-10-03T10:01:00.000Z', terminalAt: null
};

const delivery = {
  id: deliveryId, connectionId, providerDeliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958', providerEvent: 'issues',
  eventType: 'github.issue.label_added', repository: 'acme/widgets', resourceNumber: 42, label: 'agent:triage',
  state: 'PROCESSED', outcome: 'matched', workflowsCreated: 1, receivedAt: '2026-10-03T10:00:00.000Z'
};

const profiles = [{ id: 'coding-fast', displayName: 'Fast Coding', status: 'ACTIVE' }];

const expectCspSafe = (html: string) => {
  expect(html).not.toContain('style=');
  expect(html).not.toContain('<script');
};

/** A complete, valid rule form, as the browser would submit it. */
function ruleForm(overrides: Record<string, string | string[] | undefined> = {}) {
  const fields: Record<string, string | string[] | undefined> = {
    name: 'Triage bugs', connectionId, repository: 'acme/widgets', events: ['issues', 'pull_request'], label: 'agent:triage',
    ignoreBots: 'on', actorAllowlist: 'octocat, hubot', ref: '', profileId: 'coding-fast', instructions: 'Triage the issue.',
    proxyOperations: ['files_list', 'files_read'], ttlSeconds: '900', maxInputTokens: '200000', maxOutputTokens: '32000',
    maxCostUsd: '2.5', cooldownSeconds: '300', maxConcurrent: '1', ...overrides
  };
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) values.append(key, item);
  }
  return values;
}

describe('automations page registry and routing', () => {
  it('registers a top-level Automations page in the Operate group', () => {
    const page = DASHBOARD_PAGES.find((candidate) => candidate.id === 'automations');
    expect(page).toMatchObject({ route: '/dashboard/automations', label: 'Automations', group: 'operate', nav: true, palette: true });
    expect(navGroups().find((group) => group.id === 'operate')?.pages.map((entry) => entry.id)).toContain('automations');
  });

  it('resolves each section path and the run detail, and rejects other paths', () => {
    expect(automationSectionForPath('/dashboard/automations')).toBe('runs');
    expect(automationSectionForPath('/dashboard/automations/')).toBe('runs');
    expect(automationSectionForPath('/dashboard/automations/rules')).toBe('rules');
    expect(automationSectionForPath('/dashboard/automations/connections')).toBe('connections');
    expect(automationSectionForPath('/dashboard/automations/deliveries')).toBe('deliveries');
    expect(automationSectionForPath(`/dashboard/automations/runs/${workflowId}`)).toBe('runs');
    expect(automationSectionForPath('/dashboard/automations/runs/wfl_nothex')).toBeUndefined();
    expect(automationSectionForPath('/dashboard/automations/other')).toBeUndefined();
  });

  it('routes the client through the page loader and a run detail matcher', () => {
    const client = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(client).toContain('automations: () => loadAutomations(),');
    expect(client).toContain('/^\\/dashboard\\/automations\\/runs\\/(wfl_[a-f0-9]{32})$/');
  });

  it('renders section links with the current section marked', () => {
    const tabs = renderAutomationTabs('rules');
    expect(tabs).toContain('<a href="/dashboard/automations">Runs</a>');
    expect(tabs).toContain('<a href="/dashboard/automations/rules" aria-current="page">Rules</a>');
    expect(tabs).toContain('href="/dashboard/automations/connections"');
    expect(tabs).toContain('href="/dashboard/automations/deliveries"');
  });
});

describe('automations blocked states', () => {
  it('distinguishes disabled, permission denied, unavailable, and ordinary errors', () => {
    expect(automationBlockedState({ status: 503, message: 'Automations are disabled on this instance.' })).toBe('disabled');
    expect(automationBlockedState({ status: 503, message: 'Automations are not available.' })).toBe('disabled');
    expect(automationBlockedState({ status: 503, message: 'Automations are temporarily unavailable.' })).toBe('unavailable');
    expect(automationBlockedState({ status: 403, message: 'You cannot manage this automation.' })).toBe('denied');
    expect(automationBlockedState({ status: 404, message: 'Not found' })).toBeUndefined();
    expect(automationBlockedState(undefined)).toBeUndefined();
  });

  it('explains how to enable automations and offers a retry only when the runner is unavailable', () => {
    const disabled = renderAutomationBlocked('disabled');
    expect(AUTOMATIONS_DISABLED_COPY).toBe('Automations are disabled on this instance (set AUTOMATIONS_ENABLED=true on api and runner).');
    expect(disabled).toContain(AUTOMATIONS_DISABLED_COPY);
    expect(disabled).toContain('<code>AUTOMATIONS_ENABLED=true</code>');
    expect(disabled).toContain('role="status"');
    expect(disabled).not.toContain('data-automation-retry');
    expect(renderAutomationBlocked('denied')).toContain('You cannot manage automations');
    expect(renderAutomationBlocked('unavailable')).toContain('<button type="button" data-automation-retry>Try again</button>');
  });
});

describe('automation runs', () => {
  it('renders the runs table with state, resource link, workspace links, publish state, and usage', () => {
    const html = renderAutomationRuns({ workflows: [workflow], rules: [rule], filters: {} });
    expect(html).toContain(`href="/dashboard/automations/runs/${workflowId}"`);
    expect(html).toContain('<span class="status running">Running</span>');
    expect(html).toContain('href="https://github.com/acme/widgets/issues/42" target="_blank" rel="noopener noreferrer">acme/widgets#42</a>');
    expect(html).toContain('Triage bugs');
    expect(html).toContain(`href="/dashboard/workspaces/${workspaceId}/agents"`);
    expect(html).toContain(`aria-label="Open agent ${agentId}"`);
    expect(html).toContain('<span class="status pending">Publishing</span>');
    expect(html).toContain('1200 in · 300 out · $0.0045');
    expect(html).toContain('<caption>1 automation runs</caption>');
    expect(html).toContain('<label for="automation-runs-state">State</label>');
    expect(html).toContain(`<option value="${ruleId}">Triage bugs</option>`);
    expect(html).toContain('class="mobile-list"');
    expectCspSafe(html);
  });

  it('keeps the selected filters and shows an empty state', () => {
    const html = renderAutomationRuns({ workflows: [], rules: [rule], filters: { state: 'FAILED', ruleId } });
    expect(html).toContain('<option value="FAILED" selected>Failed</option>');
    expect(html).toContain(`<option value="${ruleId}" selected>`);
    expect(html).toContain('<tr><td colspan="10">No automation runs yet.</td></tr>');
    expect(html).toContain('A run starts when a labeled GitHub delivery matches an enabled rule.');
  });

  it('escapes every provider-derived string and never links a non-https resource URL', () => {
    const hostile = {
      ...workflow, repository: HOSTILE, label: HOSTILE, errorCode: HOSTILE, agentStatus: HOSTILE,
      resourceUrl: 'javascript:alert(1)', workspaceId: null, agentId: null
    };
    const html = renderAutomationRuns({ workflows: [hostile], rules: [{ ...rule, name: HOSTILE }] });
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Not opened');
    expect(automationResourceHref('http://github.com/a/b/issues/1')).toBeUndefined();
    expect(automationResourceHref('https://github.com/a/b/issues/1')).toBe('https://github.com/a/b/issues/1');
    expect(automationResourceHref(undefined)).toBeUndefined();
  });
});

describe('automation run detail', () => {
  const transitions = [
    { fromState: null, toState: 'QUEUED', actor: 'system', code: null, at: '2026-10-03T10:00:00.000Z' },
    { fromState: 'QUEUED', toState: 'RUNNING', actor: 'system', code: 'agent_started', at: '2026-10-03T10:00:30.000Z' }
  ];

  it('renders facts, the transitions timeline, and a Cancel button for a non-terminal run', () => {
    const html = renderAutomationRunDetail({ workflow, result: null, transitions, ruleName: 'Triage bugs' });
    expect(html).toContain('<nav aria-label="Breadcrumb"><a href="/dashboard/automations">Automations</a>');
    expect(html).toContain(`data-automation-cancel="${workflowId}"`);
    expect(html).toContain('>Cancel run</button>');
    expect(html).toContain('Queued → Running');
    expect(html).toContain('agent_started');
    expect(html).toContain('Triage bugs <span class="mono">(generation 4)</span>');
    expect(html).toContain('The result appears here when the agent finishes.');
    expect(html).toContain(`data-copy="${workflowId}"`);
    expectCspSafe(html);
  });

  it('renders the result as escaped preformatted text and offers no cancel once terminal', () => {
    const result = `Summary\n${HOSTILE}\n<script>alert(2)</script>`;
    const html = renderAutomationRunDetail({ workflow: { ...workflow, state: 'COMPLETED', terminalAt: '2026-10-03T10:05:00.000Z', errorCode: HOSTILE }, result, transitions });
    expect(html).toContain(`<pre class="automation-result"><code>Summary\n${ESCAPED}\n&lt;script&gt;alert(2)&lt;/script&gt;</code></pre>`);
    expect(html).not.toContain(HOSTILE);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('data-automation-cancel');
    for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']) expect(automationWorkflowIsTerminal(state)).toBe(true);
    for (const state of ['QUEUED', 'STARTING', 'RUNNING']) expect(automationWorkflowIsTerminal(state)).toBe(false);
  });

  it('renders a not-found state without a workflow', () => {
    expect(renderAutomationRunDetail({})).toContain('Automation run not found.');
  });
});

describe('automation rules', () => {
  it('lists rules with match, agent, status, and generation-carrying actions', () => {
    const html = renderAutomationRules({ rules: [rule], connections: [connection], profiles });
    expect(html).toContain('acme/widgets');
    expect(html).toContain('<span class="mono">agent:triage</span>');
    expect(html).toContain('Fast Coding');
    expect(html).toContain('Posts a comment');
    expect(html).toContain('<span class="status enabled">Enabled</span>');
    expect(html).toContain(`data-automation-rule-edit="${ruleId}"`);
    expect(html).toContain(`data-automation-rule-toggle="${ruleId}" data-next-enabled="false" data-generation="4"`);
    expect(html).toContain(`data-automation-rule-test="${ruleId}"`);
    expect(html).toContain(`data-automation-rule-delete="${ruleId}" data-generation="4"`);
    expect(html).toContain('<div id="automation-dialog-host"></div>');
    expect(html).not.toContain('Create a connection first.');
    expectCspSafe(html);
  });

  it('guides the operator to a connection and a profile when either is missing', () => {
    const html = renderAutomationRules({ rules: [], connections: [], profiles: [] });
    expect(html).toContain('Create a connection first.');
    expect(html).toContain('href="/dashboard/automations/connections"');
    expect(html).toContain('href="/dashboard/models"');
    expect(html).toContain('<tr><td colspan="7">No rules yet.</td></tr>');
  });

  it('escapes hostile rule names, repositories, and labels', () => {
    const html = renderAutomationRules({ rules: [{ ...rule, name: HOSTILE, match: { ...rule.match, label: HOSTILE } }], connections: [{ ...connection, name: HOSTILE }], profiles });
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain(ESCAPED);
  });

  it('prefills the edit form, fixes the connection, and keeps a missing profile selectable', () => {
    const html = renderAutomationRuleDialog({ rule: { ...rule, action: { ...rule.action, profileId: 'gone-profile' } }, connections: [connection], profiles });
    expect(html).toContain('<dialog id="automation-rule-dialog"');
    expect(html).toContain('>Edit rule</h2>');
    expect(html).toContain(`name="ruleId" value="${ruleId}"`);
    expect(html).toContain('name="expectedGeneration" value="4"');
    expect(html).toContain('name="connectionId" required disabled');
    expect(html).toContain('value="acme/widgets"');
    expect(html).toContain('<option value="gone-profile" selected>gone-profile (not found)</option>');
    expect(html).toContain('name="events" value="issues" checked');
    expect(html).toContain('name="events" value="pull_request">');
    expect(html).toContain('name="proxyOperations" value="files_read" checked');
    expect(html).toContain('name="proxyOperations" value="files_write">');
    expect(html).toContain('name="maxCostUsd" type="number" inputmode="decimal" min="0" max="100" step="0.000001" value="2"');
    expect(html).toContain('name="publishComment" checked');
    expect(html).toContain('name="enabled" checked');
    expect(html).toContain('>Save rule</button>');
    expect(html).toContain('aria-live="polite"');
    expectCspSafe(html);
  });

  it('starts a new rule disabled with the read-only operation default', () => {
    const html = renderAutomationRuleDialog({ connections: [connection], profiles });
    expect(html).toContain('>New rule</h2>');
    expect(html).toContain('name="connectionId" required>');
    expect(html).toContain('name="enabled">');
    expect(html).toContain('name="ignoreBots" checked');
    for (const operation of ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references']) {
      expect(html).toContain(`name="proxyOperations" value="${operation}" checked`);
    }
    expect(html).toContain('name="proxyOperations" value="files_delete">');
  });

  it('builds the rule create body and reports field errors before a round trip', () => {
    const { errors, body } = automationRuleInput(ruleForm());
    expect(errors).toEqual({});
    expect(body).toEqual({
      connectionId, name: 'Triage bugs', enabled: false,
      match: { repository: 'acme/widgets', events: ['issues', 'pull_request'], label: 'agent:triage', ignoreBots: true, actorAllowlist: ['octocat', 'hubot'] },
      action: {
        profileId: 'coding-fast', instructions: 'Triage the issue.', proxyOperations: ['files_list', 'files_read'],
        budget: { ttlSeconds: 900, maxInputTokens: 200000, maxOutputTokens: 32000, maxCostMicros: 2500000 },
        publishComment: false, cooldownSeconds: 300, maxConcurrent: 1
      }
    });
    const enabled = automationRuleInput(ruleForm({ enabled: 'on', ref: 'release/1.2', actorAllowlist: '' }));
    expect(enabled.body?.enabled).toBe(true);
    expect(enabled.body?.action.ref).toBe('release/1.2');
    expect(enabled.body?.match).not.toHaveProperty('actorAllowlist');

    const invalid = automationRuleInput(ruleForm({
      repository: 'acme/widgets.git', events: [], label: '', profileId: '', ref: '../main', instructions: '  ',
      proxyOperations: ['files_nuke'], ttlSeconds: '30', maxConcurrent: '9', maxCostUsd: '101', actorAllowlist: 'bad login!'
    }));
    expect(invalid.body).toBeUndefined();
    expect(Object.keys(invalid.errors).sort()).toEqual([
      'actorAllowlist', 'events', 'instructions', 'label', 'maxConcurrent', 'maxCostUsd', 'profileId', 'proxyOperations', 'ref', 'repository', 'ttlSeconds'
    ]);
    expect(automationRuleInput(ruleForm({ connectionId: 'whc_bad' })).errors.connectionId).toBe('Choose a connection.');
  });

  it('sends the loaded generation with a rule update', () => {
    const { body } = automationRuleInput(ruleForm());
    expect(automationRuleUpdateInput(rule, body)).toEqual({ expectedGeneration: 4, name: body.name, enabled: body.enabled, match: body.match, action: body.action });
  });

  it('renders the Test event form prefilled from the rule and an escaped preview verdict', () => {
    const html = renderAutomationPreviewDialog(rule);
    expect(html).toContain('<dialog id="automation-preview-dialog"');
    expect(html).toContain(`name="ruleId" value="${ruleId}"`);
    expect(html).toContain('id="automation-preview-repository" name="repository" required autocomplete="off" spellcheck="false" value="acme/widgets"');
    expect(html).toContain('value="agent:triage"');
    expect(html).toContain('<option value="issues" selected>Issues</option>');
    expect(html).toContain('id="automation-preview-result" class="automation-preview-result" aria-live="polite"');
    expect(renderAutomationPreviewResult({ matched: true, reason: 'matched' })).toContain('<span class="status succeeded">Would match</span>');
    const miss = renderAutomationPreviewResult({ matched: false, reason: HOSTILE });
    expect(miss).toContain('Would not match');
    expect(miss).toContain(ESCAPED);
    expect(miss).not.toContain(HOSTILE);
  });

  it('validates a preview sample', () => {
    const values = new URLSearchParams({ event: 'pull_request', repository: 'acme/widgets', label: 'agent:triage', senderLogin: 'dependabot[bot]', senderType: 'Bot' });
    expect(automationPreviewSample(values)).toEqual({ errors: {}, sample: { event: 'pull_request', repository: 'acme/widgets', label: 'agent:triage', senderLogin: 'dependabot[bot]', senderType: 'Bot' } });
    const invalid = automationPreviewSample(new URLSearchParams({ event: 'push', repository: 'nope', label: '', senderLogin: 'a b', senderType: 'Robot' }));
    expect(Object.keys(invalid.errors).sort()).toEqual(['event', 'label', 'repository', 'senderLogin', 'senderType']);
  });
});

describe('automation connections', () => {
  const origin = 'https://harness.example.com';

  it('lists connections with the full webhook URL and generation-carrying actions', () => {
    const html = renderAutomationConnections({ connections: [connection], origin });
    expect(html).toContain(`data-copy="https://harness.example.com/hooks/github/${connectionId}"`);
    expect(html).toContain('<span class="status enabled">Enabled</span>');
    expect(html).toContain(`data-automation-connection-toggle="${connectionId}" data-next-enabled="false" data-generation="3"`);
    expect(html).toContain(`data-automation-connection-rotate="${connectionId}" data-generation="3"`);
    expect(html).toContain(`data-automation-connection-delete="${connectionId}" data-generation="3"`);
    expect(html).toContain('<dialog id="automation-connection-dialog"');
    expect(html).toContain('The signing secret is shown once');
    expectCspSafe(html);
  });

  it('renders an empty state and escapes connection names', () => {
    expect(renderAutomationConnections({ connections: [], origin })).toContain('No connections yet.');
    const html = renderAutomationConnections({ connections: [{ ...connection, name: HOSTILE }], origin });
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain(ESCAPED);
  });

  it('builds the webhook URL from the origin only for a relative path', () => {
    expect(automationWebhookUrl(origin, '/hooks/github/x')).toBe('https://harness.example.com/hooks/github/x');
    expect(automationWebhookUrl(origin, '//evil.example/x')).toBe('//evil.example/x');
    expect(automationWebhookUrl(origin, undefined)).toBe('');
  });

  it('reveals the secret once with copy controls, a warning, and no secret in the markup', () => {
    const html = renderAutomationSecretPanel({ connection, origin, rotated: false });
    expect(html).toContain('id="automation-secret-panel"');
    expect(html).toContain('<strong>This secret is shown once.</strong>');
    expect(html).toContain(`id="automation-webhook-url" class="mono" readonly value="https://harness.example.com/hooks/github/${connectionId}"`);
    expect(html).toContain('<input id="automation-webhook-secret" class="mono" readonly autocomplete="off" spellcheck="false">');
    expect(html).toContain('id="copy-automation-webhook-url"');
    expect(html).toContain('id="copy-automation-webhook-secret"');
    expect(html).toContain('id="automation-secret-status" class="form-status" aria-live="polite"');
    expect(html).toContain('<code>application/json</code>');
    expect(renderAutomationSecretPanel({ connection, origin, rotated: true })).toContain('The previous secret no longer verifies deliveries');
  });

  it('writes the secret into the field, copies it, and clears it on dismissal', async () => {
    const secretField = new FakeElement();
    const urlField = Object.assign(new FakeElement(), { value: 'https://harness.example.com/hooks/github/x' });
    const copySecretButton = new FakeElement();
    const copyUrlButton = new FakeElement();
    const dismissButton = new FakeElement();
    const status = new FakeElement();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const onDismiss = vi.fn();
    bindAutomationSecretReveal({ secret: 'whsec_test_value', secretField, urlField, copySecretButton, copyUrlButton, dismissButton, status, clipboard, onDismiss });
    expect(secretField.value).toBe('whsec_test_value');

    copySecretButton.dispatch('click', {});
    await vi.waitFor(() => expect(status.textContent).toBe('Secret copied.'));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('whsec_test_value');
    copyUrlButton.dispatch('click', {});
    await vi.waitFor(() => expect(status.textContent).toBe('Webhook URL copied.'));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://harness.example.com/hooks/github/x');

    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    copySecretButton.dispatch('click', {});
    await vi.waitFor(() => expect(status.textContent).toBe('Secret could not be copied. Select it and copy it manually.'));

    dismissButton.dispatch('click', {});
    expect(secretField.value).toBe('');
    expect(status.textContent).toBe('');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('refuses to reveal an absent secret', () => {
    const element = () => new FakeElement();
    expect(() => bindAutomationSecretReveal({
      secret: '', secretField: element(), urlField: element(), copySecretButton: element(), copyUrlButton: element(),
      dismissButton: element(), status: element(), clipboard: { writeText: vi.fn() }
    })).toThrow('Rotate the secret');
  });
});

describe('automation deliveries', () => {
  it('renders recent deliveries with state, outcome, and the connection filter', () => {
    const html = renderAutomationDeliveries({ deliveries: [delivery], connections: [connection], filters: { connectionId } });
    expect(html).toContain('acme GitHub');
    expect(html).toContain('acme/widgets#42');
    expect(html).toContain('<span class="status succeeded">Processed</span>');
    expect(html).toContain('github.issue.label_added');
    expect(html).toContain('72d3162e-cc78-11e3-81ab-4c9367dc0958');
    expect(html).toContain(`<option value="${connectionId}" selected>acme GitHub</option>`);
    expectCspSafe(html);
  });

  it('escapes provider fields and renders an empty state', () => {
    const html = renderAutomationDeliveries({
      deliveries: [{ ...delivery, repository: HOSTILE, label: HOSTILE, outcome: HOSTILE, providerEvent: HOSTILE, providerDeliveryId: HOSTILE, state: 'QUARANTINED' }],
      connections: []
    });
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain(ESCAPED);
    expect(html).toContain('<span class="status failed">Quarantined</span>');
    expect(renderAutomationDeliveries({ deliveries: [] })).toContain('No deliveries received yet.');
  });
});

describe('automation API helpers', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body = url === '/dashboard/api/v1/session' ? { csrfToken: 'csrf-token-1' } : { data: {} };
      return { ok: true, status: 200, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }
  const mutation = (calls: Array<{ url: string; init: RequestInit }>, url: string) => calls.find((call) => call.url === url && call.init.method !== undefined && call.init.method !== 'GET');
  const headers = (init: RequestInit) => init.headers as Record<string, string>;

  it('sends CSRF and expectedGeneration with every generation-guarded mutation', async () => {
    const calls = stubFetch();
    await deleteAutomationConnection(connectionId, 3);
    await updateAutomationConnection(connectionId, { expectedGeneration: 3, enabled: false });
    await rotateAutomationConnectionSecret(connectionId, 3);
    await updateAutomationRule(ruleId, { expectedGeneration: 4, enabled: true });
    await deleteAutomationRule(ruleId, 4);

    const base = '/dashboard/api/v1/automations';
    const expected = [
      [`${base}/connections/${connectionId}`, 'DELETE', { expectedGeneration: 3 }],
      [`${base}/connections/${connectionId}`, 'PATCH', { expectedGeneration: 3, enabled: false }],
      [`${base}/connections/${connectionId}/rotate-secret`, 'POST', { expectedGeneration: 3 }],
      [`${base}/rules/${ruleId}`, 'PATCH', { expectedGeneration: 4, enabled: true }],
      [`${base}/rules/${ruleId}`, 'DELETE', { expectedGeneration: 4 }]
    ] as const;
    for (const [url, method, body] of expected) {
      const call = calls.find((entry) => entry.url === url && entry.init.method === method);
      expect(call, `${method} ${url}`).toBeDefined();
      expect(headers(call!.init)['x-csrf-token']).toBe('csrf-token-1');
      expect(headers(call!.init)['content-type']).toBe('application/json');
      expect(JSON.parse(String(call!.init.body))).toEqual(body);
    }
  });

  it('creates connections and rules, previews, and cancels through CSRF-protected posts', async () => {
    const calls = stubFetch();
    await createAutomationConnection('acme GitHub');
    await createAutomationRule({ name: 'x' });
    await previewAutomationRule(ruleId, { event: 'issues' });
    await cancelAutomationWorkflow(workflowId);
    await cancelAutomationWorkflow(workflowId, 'not needed');
    const base = '/dashboard/api/v1/automations';
    expect(JSON.parse(String(mutation(calls, `${base}/connections`)!.init.body))).toEqual({ provider: 'github', name: 'acme GitHub' });
    expect(JSON.parse(String(mutation(calls, `${base}/rules/${ruleId}/preview`)!.init.body))).toEqual({ sample: { event: 'issues' } });
    const cancels = calls.filter((call) => call.url === `${base}/workflows/${workflowId}/cancel`);
    expect(cancels.map((call) => JSON.parse(String(call.init.body)))).toEqual([{}, { reason: 'not needed' }]);
    for (const call of calls.filter((entry) => entry.init.method === 'POST')) expect(headers(call.init)['x-csrf-token']).toBe('csrf-token-1');
  });

  it('reads lists with only the filters that are set and no CSRF header', async () => {
    const calls = stubFetch();
    await listAutomationWorkflows({ state: 'FAILED', ruleId: '', limit: 100 });
    await listAutomationRules();
    await listAutomationDeliveries({ connectionId, limit: 50 });
    const urls = calls.map((call) => call.url);
    expect(urls).toContain('/dashboard/api/v1/automations/workflows?state=FAILED&limit=100');
    expect(urls).toContain('/dashboard/api/v1/automations/rules');
    expect(urls).toContain(`/dashboard/api/v1/automations/deliveries?connectionId=${connectionId}&limit=50`);
    for (const call of calls.filter((entry) => entry.url.includes('/automations/'))) expect(headers(call.init)['x-csrf-token']).toBeUndefined();
  });

  it('surfaces the BFF status and message so the page can choose its blocked state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable', message: 'Automations are disabled on this instance.' }) })));
    const error = await listAutomationRules().catch((caught: unknown) => caught as { status: number; message: string });
    expect(error).toMatchObject({ status: 503 });
    expect(automationBlockedState(error)).toBe('disabled');
  });
});
