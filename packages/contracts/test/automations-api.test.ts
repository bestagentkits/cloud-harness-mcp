import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_WEBHOOK_HEADERS,
  AutomationConnectionCreateInputSchema,
  AutomationConnectionUpdateInputSchema,
  AutomationJiraBaseUrlSchema,
  AutomationProviderSchema,
  AutomationRuleInputSchema,
  AutomationRuleMatchSchema,
  AutomationSampleEventSchema,
  AutomationsRunnerRequestSchema,
  automationMatchProvider,
  automationRuleProblem
} from '../src/index.js';

const CONNECTION = `whc_${'a'.repeat(32)}`;
const GENERATION = { id: CONNECTION, expectedGeneration: 1 };
const action = { profileId: 'default', instructions: 'Analyse the issue.' };
const githubMatch = { repository: 'acme/widgets', events: ['issues'], label: 'claude' };

const ingest = (input: Record<string, unknown>) => AutomationsRunnerRequestSchema.safeParse({
  version: 1,
  operation: 'webhook_ingest',
  input: { connectionId: CONNECTION, bodyBase64: '', ...input }
});

describe('automation rule contracts', () => {
  it('keeps stored GitHub matches valid without a provider field', () => {
    const match = AutomationRuleMatchSchema.parse(githubMatch);
    expect(automationMatchProvider(match)).toBe('github');
    expect(automationMatchProvider(AutomationRuleMatchSchema.parse({ ...githubMatch, provider: 'github' }))).toBe('github');
  });

  it('parses each provider match and enforces its trigger shape', () => {
    const valid = [
      { provider: 'linear', trigger: 'label_added', label: 'claude' },
      { provider: 'linear', teamKey: 'ENG', trigger: 'state_changed', toState: 'In Progress', actorAllowlist: ['alice@example.com'] },
      { provider: 'linear', trigger: 'state_changed' },
      { provider: 'jira', projectKey: 'OPS', trigger: 'label_added', label: 'ai' },
      { provider: 'jira', projectKey: 'OPS', trigger: 'status_changed', toStatus: 'Done', ignoreBots: false },
      { provider: 'custom', event: 'deploy.failed' },
      { provider: 'custom', event: 'deploy.failed', label: 'prod' }
    ];
    for (const match of valid) expect(AutomationRuleMatchSchema.safeParse(match).success, JSON.stringify(match)).toBe(true);
    const invalid = [
      { provider: 'linear', trigger: 'label_added' },
      { provider: 'linear', trigger: 'state_changed', label: 'claude' },
      { provider: 'jira', trigger: 'label_added', label: 'ai' },
      { provider: 'jira', projectKey: 'OPS', trigger: 'status_changed', label: 'ai' },
      { provider: 'custom' },
      { provider: 'gitlab', event: 'x' },
      { provider: 'linear', trigger: 'label_added', label: 'claude', repository: 'acme/widgets' }
    ];
    for (const match of invalid) expect(AutomationRuleMatchSchema.safeParse(match).success, JSON.stringify(match)).toBe(false);
  });

  it('takes the repository from the GitHub match and requires every other provider to pin it', () => {
    const linear = AutomationRuleMatchSchema.parse({ provider: 'linear', trigger: 'label_added', label: 'claude' });
    const github = AutomationRuleMatchSchema.parse(githubMatch);
    expect(automationRuleProblem(github, {})).toBeUndefined();
    expect(automationRuleProblem(github, { repository: 'acme/other' })).toMatch(/GitHub rules/u);
    expect(automationRuleProblem(linear, {})).toMatch(/must pin action\.repository/u);
    expect(automationRuleProblem(linear, { repository: 'acme/widgets' })).toBeUndefined();

    const rule = (match: unknown, ruleAction: Record<string, unknown>) =>
      AutomationRuleInputSchema.safeParse({ connectionId: CONNECTION, name: 'Triage', match, action: ruleAction });
    expect(rule(githubMatch, action).success).toBe(true);
    expect(rule(githubMatch, { ...action, repository: 'acme/widgets' }).success).toBe(false);
    expect(rule({ provider: 'custom', event: 'deploy.failed' }, action).success).toBe(false);
    expect(rule({ provider: 'custom', event: 'deploy.failed' }, { ...action, repository: 'acme/widgets' }).success).toBe(true);
    expect(rule({ provider: 'custom', event: 'deploy.failed' }, { ...action, repository: 'https://evil.example.com/x' }).success).toBe(false);
  });

  it('accepts provider-neutral sample events only with a matching event type', () => {
    const sample = { provider: 'linear', eventType: 'linear.issue.label_added', scope: 'ENG', label: 'claude', actor: { login: 'alice', isBot: false } };
    expect(AutomationSampleEventSchema.safeParse(sample).success).toBe(true);
    expect(AutomationSampleEventSchema.safeParse({ ...sample, eventType: 'jira.issue.label_added' }).success).toBe(false);
  });
});

describe('automation connection contracts', () => {
  it('takes provider-specific settings on create and refuses settings of another provider', () => {
    const parse = (input: Record<string, unknown>) => AutomationConnectionCreateInputSchema.safeParse({ name: 'acme', ...input });
    expect(parse({ provider: 'github' }).success).toBe(true);
    expect(parse({ provider: 'github', apiKey: 'lin_api_value' }).success).toBe(false);
    expect(parse({ provider: 'linear' }).success).toBe(true);
    expect(parse({ provider: 'linear', apiKey: 'lin_api_value' }).success).toBe(true);
    expect(parse({ provider: 'linear', apiKey: 'short' }).success).toBe(false);
    expect(parse({ provider: 'linear', apiKey: 'lin_api\nvalue' }).success).toBe(false);
    expect(parse({ provider: 'custom', baseUrl: 'https://acme.atlassian.net' }).success).toBe(false);
    expect(parse({ provider: 'jira', baseUrl: 'https://acme.atlassian.net' }).success).toBe(true);
    expect(parse({ provider: 'jira', baseUrl: 'https://acme.atlassian.net', email: 'a@example.com', apiToken: 'jira-token-value' }).success).toBe(true);
    expect(parse({ provider: 'jira', baseUrl: 'https://acme.atlassian.net', email: 'a@example.com' }).success).toBe(false);
    expect(parse({ provider: 'jira' }).success).toBe(false);
    expect(parse({ provider: 'gitlab' }).success).toBe(false);
  });

  it('accepts only a public https origin as the Jira base URL', () => {
    expect(AutomationJiraBaseUrlSchema.parse('https://Acme.atlassian.net/')).toBe('https://acme.atlassian.net');
    const rejected = [
      'http://acme.atlassian.net',
      'https://acme.atlassian.net:8443',
      'https://user:pass@acme.atlassian.net',
      'https://acme.atlassian.net/jira',
      'https://acme.atlassian.net/?x=1',
      'https://acme.atlassian.net/#x',
      'https://127.0.0.1',
      'https://[::1]',
      'https://localhost',
      'https://jira.internal',
      'https://jira.local',
      'https://intranet',
      'not a url'
    ];
    for (const value of rejected) expect(AutomationJiraBaseUrlSchema.safeParse(value).success, value).toBe(false);
  });

  it('pairs Jira credentials on update and keeps clearing exclusive of a new credential', () => {
    const parse = (input: Record<string, unknown>) => AutomationConnectionUpdateInputSchema.safeParse({ ...GENERATION, ...input });
    expect(parse({ apiKey: 'lin_api_value' }).success).toBe(true);
    expect(parse({ email: 'a@example.com', apiToken: 'jira-token-value' }).success).toBe(true);
    expect(parse({ apiToken: 'jira-token-value' }).success).toBe(false);
    expect(parse({ clearOutbound: true }).success).toBe(true);
    expect(parse({ clearOutbound: true, apiKey: 'lin_api_value' }).success).toBe(false);
    expect(parse({ clearOutbound: false }).success).toBe(false);
    expect(parse({ baseUrl: 'https://acme.atlassian.net' }).success).toBe(false);
  });
});

describe('automation webhook ingest contract', () => {
  it('keeps the legacy GitHub fields and refuses mixing them with headers', () => {
    expect(ingest({ provider: 'github', event: 'issues', deliveryId: 'd-1', signature: 'sha256=00' }).success).toBe(true);
    expect(ingest({ provider: 'github', event: 'issues', deliveryId: 'd-1' }).success).toBe(false);
    expect(ingest({ provider: 'linear', event: 'Issue', deliveryId: 'd-1', signature: '00' }).success).toBe(false);
    expect(ingest({ provider: 'github', event: 'issues', deliveryId: 'd-1', signature: 'sha256=00', headers: { 'x-github-event': 'issues' } }).success).toBe(false);
  });

  it('accepts only each provider allowlisted headers within their bounds', () => {
    for (const provider of AutomationProviderSchema.options) {
      const headers = Object.fromEntries(AUTOMATION_WEBHOOK_HEADERS[provider].map((header) => [header.name, 'x']));
      expect(ingest({ provider, headers }).success, provider).toBe(true);
      for (const header of AUTOMATION_WEBHOOK_HEADERS[provider]) {
        expect(ingest({ provider, headers: { ...headers, [header.name]: 'x'.repeat(header.maxChars + 1) } }).success, header.name).toBe(false);
      }
    }
    expect(ingest({ provider: 'linear', headers: { 'x-github-event': 'issues' } }).success).toBe(false);
    expect(ingest({ provider: 'github', headers: { 'x-github-event': 'issues', cookie: 'session' } }).success).toBe(false);
    expect(ingest({ provider: 'gitlab', headers: {} }).success).toBe(false);
  });
});
