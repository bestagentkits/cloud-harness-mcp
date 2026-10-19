import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAutomationWorkflow, createAutomationConnection, createAutomationRule, deleteAutomationConnection, deleteAutomationRule,
  listAutomationDeliveries, listAutomationRules, listAutomationWorkflows, previewAutomationRule, rotateAutomationConnectionSecret,
  updateAutomationConnection, updateAutomationRule, replayAutomationDelivery, getAutomationHealth, getAutomationMetrics
} from '../dashboard/dashboard-api.js';
import {
  AUTOMATIONS_DISABLED_COPY, automationBlockedState, automationResourceHref, automationSectionForPath, automationWebhookUrl,
  automationWorkflowIsTerminal, renderAutomationBlocked, renderAutomationConnections, renderAutomationDeliveries,
  renderAutomationPreviewDialog, renderAutomationPreviewResult, renderAutomationRuleDialog, renderAutomationRules, renderAutomationRunDetail,
  renderAutomationRuns, renderAutomationSecretPanel, renderAutomationTabs, renderAutomationRuleMatchFields, renderAutomationMetrics,
  automationMatchSummary, automationResourceText
} from '../dashboard/dashboard-render.js';
import { automationConnectionInput, automationPreviewSample, automationRuleInput, automationRuleUpdateInput, bindAutomationSecretReveal } from '../dashboard/dashboard.js';
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
    expect(automationSectionForPath('/dashboard/automations/metrics')).toBe('metrics');
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
    expect(tabs).toContain('href="/dashboard/automations/metrics"');
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
    expect(html).toContain('A run starts when a delivery matches an enabled rule.');
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
    expect(html).toContain('name="proxyOperations" value="grep_search">');
    expect(html).not.toContain('value="files_write"');
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
    expect(html).not.toContain('value="files_delete"');
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
    await createAutomationConnection({ provider: 'github', name: 'acme GitHub' });
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

  it('replays a delivery through a CSRF-protected post and reads health and metrics without one', async () => {
    const calls = stubFetch();
    await createAutomationConnection({ provider: 'jira', name: 'acme Jira', baseUrl: 'https://acme.atlassian.net' });
    await replayAutomationDelivery(deliveryId, 'QUARANTINED');
    await replayAutomationDelivery(deliveryId);
    await getAutomationHealth();
    await getAutomationHealth(connectionId);
    await getAutomationMetrics(30);
    await listAutomationWorkflows({ publishState: 'FAILED' });
    await listAutomationDeliveries({ state: 'QUARANTINED' });
    const base = '/dashboard/api/v1/automations';
    expect(JSON.parse(String(mutation(calls, `${base}/connections`)!.init.body))).toEqual({ provider: 'jira', name: 'acme Jira', baseUrl: 'https://acme.atlassian.net' });
    const replays = calls.filter((call) => call.url === `${base}/deliveries/${deliveryId}/replay`);
    expect(replays.map((call) => [call.init.method, JSON.parse(String(call.init.body))])).toEqual([['POST', { expectedState: 'QUARANTINED' }], ['POST', {}]]);
    for (const call of replays) expect(headers(call.init)['x-csrf-token']).toBe('csrf-token-1');
    const urls = calls.map((call) => call.url);
    expect(urls).toContain(`${base}/health`);
    expect(urls).toContain(`${base}/health?connectionId=${connectionId}`);
    expect(urls).toContain(`${base}/metrics?windowDays=30`);
    expect(urls).toContain(`${base}/workflows?publishState=FAILED`);
    expect(urls).toContain(`${base}/deliveries?state=QUARANTINED`);
    for (const call of calls.filter((entry) => /\/(health|metrics|workflows|deliveries)\?|\/health$/.test(entry.url))) expect(headers(call.init)['x-csrf-token']).toBeUndefined();
  });

  it('surfaces the BFF status and message so the page can choose its blocked state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable', message: 'Automations are disabled on this instance.' }) })));
    const error = await listAutomationRules().catch((caught: unknown) => caught as { status: number; message: string });
    expect(error).toMatchObject({ status: 503 });
    expect(automationBlockedState(error)).toBe('disabled');
  });
});

const linearConnectionId = id('whc', '1');
const jiraConnectionId = id('whc', '2');
const linearConnection = { ...connection, id: linearConnectionId, provider: 'linear', name: 'acme Linear', webhookPath: `/hooks/linear/${linearConnectionId}`, outboundConfigured: true };
const jiraConnection = {
  ...connection, id: jiraConnectionId, provider: 'jira', name: 'acme Jira', webhookPath: `/hooks/jira/${jiraConnectionId}`,
  outboundConfigured: false, config: { baseUrl: 'https://acme.atlassian.net' }
};
const linearRule = {
  ...rule, connectionId: linearConnectionId,
  match: { provider: 'linear', teamKey: 'ENG', trigger: 'state_changed', toState: 'Ready for agent', ignoreBots: true },
  action: { ...rule.action, repository: 'acme/widgets' }
};

/** The rule form for a non-GitHub provider: the common fields plus that provider's match fields. */
function providerRuleForm(fields: Record<string, string | undefined>) {
  return ruleForm({ repository: undefined, events: undefined, label: undefined, actorAllowlist: undefined, checkoutRepository: 'acme/widgets', ...fields });
}

describe('automation rules for every provider', () => {
  it('renders each provider match form and keeps the GitHub fields unchanged', () => {
    const github = renderAutomationRuleMatchFields('github', rule.match, rule.action);
    expect(github).toContain('id="automation-rule-repository" name="repository" required');
    expect(github).not.toContain('name="checkoutRepository"');

    const linear = renderAutomationRuleMatchFields('linear', linearRule.match, linearRule.action);
    expect(linear).toContain('id="automation-rule-scope" name="teamKey" maxlength="16"');
    expect(linear).toContain('<option value="state_changed" selected>Moved to a workflow state</option>');
    expect(linear).toContain('name="toState" maxlength="100" autocomplete="off" spellcheck="false" value="Ready for agent"');
    expect(linear).toContain('name="checkoutRepository" required maxlength="140"');
    expect(linear).toContain('value="acme/widgets"');
    expect(linear).not.toContain('name="events"');

    const jira = renderAutomationRuleMatchFields('jira', { provider: 'jira', projectKey: 'OPS', trigger: 'status_changed', toStatus: 'Triage' });
    expect(jira).toContain('name="projectKey" required');
    expect(jira).toContain('value="OPS"');
    expect(jira).toContain('<option value="status_changed" selected>Moved to a status</option>');
    expect(jira).toContain('value="Triage"');

    const custom = renderAutomationRuleMatchFields('custom', { provider: 'custom', event: 'deploy.finished' });
    expect(custom).toContain('name="event" required maxlength="64"');
    expect(custom).not.toContain('name="ignoreBots"');
    expect(custom).toContain('name="checkoutRepository" required');
    for (const html of [github, linear, jira, custom]) expectCspSafe(html);
  });

  it('opens a new rule on the first connection provider and an edit on the rule provider', () => {
    const fresh = renderAutomationRuleDialog({ connections: [linearConnection, connection], profiles });
    expect(fresh).toContain('<div id="automation-rule-match" class="automation-match" data-provider="linear">');
    expect(fresh).toContain(`<option value="${linearConnectionId}" data-provider="linear">acme Linear · Linear</option>`);
    expect(fresh).toContain(`<option value="${connectionId}" data-provider="github">acme GitHub · GitHub</option>`);
    const edit = renderAutomationRuleDialog({ rule: linearRule, connections: [linearConnection], profiles });
    expect(edit).toContain('data-provider="linear"');
    expect(edit).toContain('value="Ready for agent"');
    expect(renderAutomationRuleDialog({ rule, connections: [connection], profiles })).toContain('<div id="automation-rule-match" class="automation-match" data-provider="github">');
  });

  it('builds each provider match body and the pinned checkout repository', () => {
    const linear = automationRuleInput(providerRuleForm({ teamKey: 'ENG', trigger: 'state_changed', toState: 'Ready for agent', label: 'ignored', ignoreBots: 'on', actorAllowlist: 'dev@acme.test' }), 'linear');
    expect(linear.errors).toEqual({});
    expect(linear.body?.match).toEqual({ provider: 'linear', teamKey: 'ENG', trigger: 'state_changed', toState: 'Ready for agent', ignoreBots: true, actorAllowlist: ['dev@acme.test'] });
    expect(linear.body?.action.repository).toBe('acme/widgets');

    const anyState = automationRuleInput(providerRuleForm({ trigger: 'state_changed', ignoreBots: undefined }), 'linear');
    expect(anyState.body?.match).toEqual({ provider: 'linear', trigger: 'state_changed', ignoreBots: false });

    const jira = automationRuleInput(providerRuleForm({ projectKey: 'OPS', trigger: 'label_added', label: 'agent', toState: 'ignored' }), 'jira');
    expect(jira.body?.match).toEqual({ provider: 'jira', projectKey: 'OPS', trigger: 'label_added', label: 'agent', ignoreBots: true });
    const jiraStatus = automationRuleInput(providerRuleForm({ projectKey: 'OPS', trigger: 'status_changed', toState: 'Triage' }), 'jira');
    expect(jiraStatus.body?.match).toMatchObject({ trigger: 'status_changed', toStatus: 'Triage' });
    expect(jiraStatus.body?.match).not.toHaveProperty('toState');

    const custom = automationRuleInput(providerRuleForm({ event: 'deploy.finished', ignoreBots: 'on' }), 'custom');
    expect(custom.body?.match).toEqual({ provider: 'custom', event: 'deploy.finished' });

    const github = automationRuleInput(ruleForm({ checkoutRepository: 'other/repo' }));
    expect(github.body?.action).not.toHaveProperty('repository');
  });

  it('reports provider field errors before a round trip', () => {
    expect(Object.keys(automationRuleInput(providerRuleForm({ trigger: 'label_added', label: '', teamKey: 'not a key', checkoutRepository: 'nope', actorAllowlist: 'has\0nul' }), 'linear').errors).sort())
      .toEqual(['actorAllowlist', 'checkoutRepository', 'label', 'teamKey']);
    expect(Object.keys(automationRuleInput(providerRuleForm({ projectKey: '9X', trigger: 'status_changed' }), 'jira').errors)).toEqual(['projectKey']);
    expect(Object.keys(automationRuleInput(providerRuleForm({ event: 'bad event' }), 'custom').errors)).toEqual(['event']);
    expect(automationRuleInput(providerRuleForm({}), 'gitlab').errors.connectionId).toBe('Choose a connection.');
  });

  it('summarizes every provider match in the rules list', () => {
    expect(automationMatchSummary(linearRule)).toContain('Linear ENG');
    expect(automationMatchSummary(linearRule)).toContain('moved to <span class="mono">Ready for agent</span>');
    expect(automationMatchSummary(linearRule)).toContain('checks out <span class="mono">acme/widgets</span>');
    expect(automationMatchSummary({ match: { provider: 'jira', projectKey: 'OPS', trigger: 'label_added', label: 'agent' } })).toContain('label <span class="mono">agent</span>');
    expect(automationMatchSummary({ match: { provider: 'custom', event: 'deploy.finished' } })).toContain('deploy.finished');
    const hostile = automationMatchSummary({ match: { provider: 'linear', trigger: 'state_changed', toState: HOSTILE }, action: { repository: HOSTILE } });
    expect(hostile).not.toContain(HOSTILE);
    expect(hostile).toContain(ESCAPED);
  });

  it('previews a non-GitHub rule with a normalized sample', () => {
    const html = renderAutomationPreviewDialog(linearRule, 'linear');
    expect(html).toContain('<input type="hidden" name="provider" value="linear">');
    expect(html).toContain('<option value="linear.issue.state_changed" selected>linear.issue.state_changed</option>');
    expect(html).toContain('id="automation-preview-scope" name="scope" required maxlength="200" autocomplete="off" spellcheck="false" value="ENG"');
    expect(html).toContain('name="actorIsBot"');
    expect(html).not.toContain('name="senderType"');
    expect(renderAutomationPreviewDialog({ ...rule, match: { provider: 'custom', event: 'deploy.finished' } }, 'custom')).not.toContain('name="toState"');

    const values = new URLSearchParams({ eventType: 'linear.issue.state_changed', scope: 'ENG', fromState: 'Backlog', toState: 'Ready for agent', actorLogin: 'dev@acme.test', actorIsBot: 'on' });
    expect(automationPreviewSample(values, 'linear')).toEqual({
      errors: {},
      sample: { provider: 'linear', eventType: 'linear.issue.state_changed', scope: 'ENG', fromState: 'Backlog', toState: 'Ready for agent', actor: { login: 'dev@acme.test', isBot: true } }
    });
    const invalid = automationPreviewSample(new URLSearchParams({ eventType: 'github.issue.label_added', scope: '', actorLogin: 'a b' }), 'jira');
    expect(Object.keys(invalid.errors).sort()).toEqual(['actorLogin', 'eventType', 'scope']);
  });
});

describe('automation connections for every provider', () => {
  const origin = 'https://harness.example.com';
  const counts = (processed: number, quarantined: number) => ({ RECEIVED: 0, PROCESSED: processed, IGNORED: 1, QUARANTINED: quarantined });
  const health = [{
    connectionId: linearConnectionId, provider: 'linear', enabled: true, outboundConfigured: true, lastDeliveryAt: '2026-10-03T10:00:00.000Z',
    lastQuarantine: { at: '2026-10-02T10:00:00.000Z', reason: 'malformed_payload' }, last24h: counts(2, 0), last7d: counts(9, 1)
  }];

  it('shows provider, webhook path, outbound flag, Jira site and health', () => {
    const html = renderAutomationConnections({ connections: [connection, linearConnection, jiraConnection], origin, health });
    expect(html).toContain(`data-copy="https://harness.example.com/hooks/linear/${linearConnectionId}"`);
    expect(html).toContain(`<dd class="mono wrap">/hooks/jira/${jiraConnectionId}</dd>`);
    expect(html).toContain('<dt>Jira site</dt><dd class="mono wrap">https://acme.atlassian.net</dd>');
    expect(html).toContain('<dt>Post back</dt><dd><span class="status enabled">Configured</span></dd>');
    expect(html).toContain('<dt>Post back</dt><dd><span class="status">Not configured</span></dd>');
    expect(html).toContain('<dt>Last 24 hours</dt><dd>0 received · 2 processed · 1 ignored · 0 quarantined</dd>');
    expect(html).toContain('<dt>Last 7 days</dt><dd>0 received · 9 processed · 1 ignored · 1 quarantined</dd>');
    expect(html).toContain('<span class="mono wrap">malformed_payload</span>');
    expectCspSafe(html);
    expect(renderAutomationConnections({ connections: [connection], origin, health: null })).toContain('<dt>Health</dt><dd>Not available right now</dd>');
  });

  it('offers provider fields in hidden, disabled fieldsets and never renders a credential value', () => {
    const html = renderAutomationConnections({ connections: [], origin });
    expect(html).toContain('<select id="automation-connection-provider" name="provider" required><option value="github" selected>GitHub</option><option value="linear">Linear</option><option value="jira">Jira</option><option value="custom">Custom webhook</option></select>');
    expect(html).toContain('<fieldset class="automation-fieldset" data-automation-provider-fields="linear" hidden disabled>');
    expect(html).toContain('<fieldset class="automation-fieldset" data-automation-provider-fields="jira" hidden disabled>');
    for (const name of ['apiKey', 'apiToken']) {
      const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
      expect(input).toContain('type="password"');
      expect(input).toContain('data-write-only');
      expect(input).toContain('autocomplete="new-password"');
      expect(input).not.toContain('value=');
    }
    expect(html).toContain('name="baseUrl" type="url" required');
  });

  it('never echoes a stored credential: summaries only carry the outbound flag', () => {
    const html = renderAutomationConnections({ connections: [{ ...linearConnection, apiKey: 'lin_api_secret_value' }], origin, health });
    expect(html).not.toContain('lin_api_secret_value');
  });

  it('builds the create body per provider and refuses unpaired Jira credentials', () => {
    expect(automationConnectionInput(new URLSearchParams({ provider: 'github', name: 'acme GitHub', apiKey: 'ignored-key' }))).toEqual({ errors: {}, body: { provider: 'github', name: 'acme GitHub' } });
    expect(automationConnectionInput(new URLSearchParams({ provider: 'linear', name: 'acme Linear', apiKey: 'lin_api_12345678' })).body)
      .toEqual({ provider: 'linear', name: 'acme Linear', apiKey: 'lin_api_12345678' });
    expect(automationConnectionInput(new URLSearchParams({ provider: 'linear', name: 'acme Linear', apiKey: '' })).body).toEqual({ provider: 'linear', name: 'acme Linear' });
    expect(automationConnectionInput(new URLSearchParams({ provider: 'jira', name: 'acme Jira', baseUrl: 'https://acme.atlassian.net/', email: 'ops@acme.test', apiToken: 'atl-token-123' })).body)
      .toEqual({ provider: 'jira', name: 'acme Jira', baseUrl: 'https://acme.atlassian.net', email: 'ops@acme.test', apiToken: 'atl-token-123' });
    expect(automationConnectionInput(new URLSearchParams({ provider: 'custom', name: 'deploys' })).body).toEqual({ provider: 'custom', name: 'deploys' });
    expect(Object.keys(automationConnectionInput(new URLSearchParams({ provider: 'jira', name: 'x', baseUrl: 'http://acme.atlassian.net/path', email: 'ops@acme.test' })).errors).sort())
      .toEqual(['apiToken', 'baseUrl']);
    expect(Object.keys(automationConnectionInput(new URLSearchParams({ provider: 'linear', name: '', apiKey: 'short' })).errors).sort()).toEqual(['apiKey', 'name']);
    expect(automationConnectionInput(new URLSearchParams({ provider: 'gitlab', name: 'x' })).errors.provider).toBe('Choose a provider.');
  });

  it('explains where to paste the secret for each provider and keeps the secret out of the markup', () => {
    for (const [provider, text] of [['linear', 'In Linear'], ['jira', 'In Jira'], ['custom', 'x-cloudharness-signature'], ['github', 'In GitHub']]) {
      const html = renderAutomationSecretPanel({ connection: { ...connection, provider }, origin });
      expect(html).toContain(text);
      expect(html).toContain('<code>application/json</code>');
      expect(html).toContain('<input id="automation-webhook-secret" class="mono" readonly autocomplete="off" spellcheck="false">');
    }
    expect(renderAutomationSecretPanel({ connection: linearConnection, origin, rotated: true })).toContain('update the Linear webhook now');
  });
});

describe('automation deliveries triage and replay', () => {
  it('filters by state with dead letter wording and offers Replay only on replayable deliveries', () => {
    const html = renderAutomationDeliveries({
      deliveries: [
        { ...delivery, state: 'QUARANTINED', outcome: 'no_matching_rule', replayable: true },
        { ...delivery, id: id('dlv', '9'), state: 'QUARANTINED', outcome: 'malformed_payload', replayable: false }
      ],
      connections: [connection], filters: { state: 'QUARANTINED' }
    });
    expect(html).toContain('<option value="QUARANTINED" selected>Quarantined (dead letter)</option>');
    expect(html).toContain(`<button type="button" data-automation-delivery-replay="${deliveryId}" data-state="QUARANTINED">Replay</button>`);
    expect(html).not.toContain(`data-automation-delivery-replay="${id('dlv', '9')}"`);
    expect(html).toContain('<th>Actions</th>');
    expectCspSafe(html);
    expect(renderAutomationDeliveries({ deliveries: [], filters: { state: 'QUARANTINED' } })).toContain('No deliveries in this state.');
  });

  it('shows a non-GitHub resource reference with its checkout repository', () => {
    expect(automationResourceText({ resourceRef: 'ENG-12', repository: 'acme/widgets' })).toBe('ENG-12 · acme/widgets');
    expect(automationResourceText({ repository: 'acme/widgets', resourceNumber: 42 })).toBe('acme/widgets#42');
    expect(automationResourceText({})).toBe('Unknown resource');
    const html = renderAutomationDeliveries({ deliveries: [{ ...delivery, repository: null, resourceNumber: null, resourceRef: 'OPS-7' }] });
    expect(html).toContain('<span class="mono wrap">OPS-7</span>');
  });

  it('wires Replay through a confirmation that sends the state it saw', () => {
    const client = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(client).toContain("content.querySelectorAll('[data-automation-delivery-replay]')) button.addEventListener('click', (event) => confirmAction({");
    expect(client).toContain('await replayAutomationDelivery(button.dataset.automationDeliveryReplay, button.dataset.state)');
    expect(client).toContain('resetWriteOnlyFields(form);');
  });
});

describe('automation metrics', () => {
  const entry = {
    workflows: 13, active: 1, completed: 10, failed: 1, cancelled: 1, expired: 0, successRate: 10 / 12, costMicros: 15_500,
    inputTokens: 1200, outputTokens: 300, latencyP50Ms: 5000, latencyP95Ms: 150_000
  };
  const metrics = {
    windowDays: 7, since: '2026-10-12T10:00:00.000Z',
    providers: [{ provider: 'github', ...entry }],
    rules: [{ ruleId, name: HOSTILE, provider: 'linear', deleted: true, ...entry, successRate: null, latencyP50Ms: null, latencyP95Ms: null }]
  };

  it('renders success, cost and latency per provider and per rule', () => {
    const html = renderAutomationMetrics({ metrics, windowDays: 7 });
    expect(html).toContain('<option value="7" selected>Last 7 days</option>');
    expect(html).toContain('<option value="1">Last 24 hours</option>');
    expect(html).toContain('<caption>1 providers</caption>');
    expect(html).toContain('<th scope="row">GitHub</th>');
    expect(html).toContain('83.3%');
    expect(html).toContain('$0.0155');
    expect(html).toContain('1200 in · 300 out');
    expect(html).toContain('p50 5.0 s · p95 2.5 min');
    expect(html).toContain('10 completed · 1 failed · 1 cancelled or expired · 1 active');
    expect(html).toContain('No finished runs');
    expect(html).toContain('p50 — · p95 —');
    expect(html).toContain('Linear · deleted');
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain(ESCAPED);
    expectCspSafe(html);
  });

  it('renders empty and error states', () => {
    expect(renderAutomationMetrics({ metrics: { ...metrics, providers: [], rules: [] }, windowDays: 30 })).toContain('No runs in this window.');
    const failed = renderAutomationMetrics({ windowDays: 1, error: { message: HOSTILE } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Metrics could not be loaded.');
    expect(failed).toContain('data-automation-retry');
    expect(failed).toContain('<option value="1" selected>Last 24 hours</option>');
    expect(failed).not.toContain(HOSTILE);
  });

  it('loads the metrics section with a loading state and keeps blocked states page-wide', () => {
    const client = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(client).toContain("else if (section === 'metrics') await loadAutomationMetrics();");
    expect(client).toContain('if (automationBlockedState(caught)) throw caught;');
    expect(client).toContain('insertRendered(content, renderAutomationLoading());');
  });
});
