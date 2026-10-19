import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AutomationProviderSchema, AutomationRuleMatchSchema } from '@cloud-harness/contracts';
import {
  ANY_INDEX_KEY,
  eventIndexKeys,
  normalizedEventProblem,
  rejectActor,
  ruleIndexKeys,
  type NormalizedAutomationEvent
} from '../src/automation-adapter.js';
import { githubAdapter, matchGitHubRule } from '../src/automation-github.js';
import { AUTOMATION_PROVIDER_ADAPTERS } from '../src/automation-providers.js';

const event = (overrides: Partial<NormalizedAutomationEvent> = {}): NormalizedAutomationEvent => ({
  provider: 'github',
  eventType: 'github.issue.label_added',
  scope: 'acme/widgets',
  resourceKey: 'acme/widgets#7',
  resourceRef: '#7',
  resourceNumber: 7,
  resourceUrl: 'https://github.com/acme/widgets/issues/7',
  label: 'Claude',
  actor: { login: 'alice', isBot: false, type: 'User' },
  title: 't',
  body: 'b',
  ...overrides
});

describe('automation provider registry', () => {
  it('keys every adapter by its own provider and only by known providers', () => {
    for (const [provider, adapter] of Object.entries(AUTOMATION_PROVIDER_ADAPTERS)) {
      expect(AutomationProviderSchema.safeParse(provider).success).toBe(true);
      expect(adapter?.provider).toBe(provider);
    }
    expect(AUTOMATION_PROVIDER_ADAPTERS.github).toBe(githubAdapter);
  });

  it('reads the GitHub event, delivery id and signature from the allowlisted headers', () => {
    const body = Buffer.from('{"a":1}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': signature };
    expect(githubAdapter.verify({ secret: 'secret', body, headers, now: 0 })).toEqual({ ok: true });
    expect(githubAdapter.verify({ secret: 'secret', body, headers: { ...headers, 'x-hub-signature-256': '' }, now: 0 }).ok).toBe(false);
    expect(githubAdapter.verify({ secret: 'secret', body, headers: {}, now: 0 }).ok).toBe(false);
    expect(githubAdapter.eventName(headers, body)).toBe('issues');
    expect(githubAdapter.eventName({ 'x-github-event': 'Issues' }, body)).toBeUndefined();
    expect(githubAdapter.deliveryId(headers, body)).toBe('d-1');
  });

  it('matches GitHub rules on kind, repository, label and actor, and refuses other providers', () => {
    const match = AutomationRuleMatchSchema.parse({ repository: 'acme/widgets', events: ['issues'], label: 'claude' });
    expect(matchGitHubRule(match, event(), undefined)).toEqual({ matched: true, reason: 'matched' });
    expect(matchGitHubRule(match, event({ eventType: 'github.pull_request.label_added' }), undefined).reason).toBe('event_not_selected');
    expect(matchGitHubRule(match, event({ scope: 'acme/other' }), undefined).reason).toBe('repository_mismatch');
    expect(matchGitHubRule(match, event({ provider: 'linear', eventType: 'linear.issue.label_added' }), undefined).reason).toBe('provider_mismatch');
    const linear = AutomationRuleMatchSchema.parse({ provider: 'linear', trigger: 'label_added', label: 'claude' });
    expect(matchGitHubRule(linear, event(), undefined).reason).toBe('provider_mismatch');
  });

  it('applies the shared actor filters in a fixed order', () => {
    const human = { login: 'Alice', id: 'u-1', isBot: false };
    expect(rejectActor({ ignoreBots: true }, human, undefined, [human.id])).toBeUndefined();
    expect(rejectActor({ ignoreBots: true }, { login: 'app[bot]', isBot: true }, 'APP[bot]', [])?.reason).toBe('self_trigger');
    expect(rejectActor({ ignoreBots: true }, { login: 'ci', isBot: true }, undefined, [])?.reason).toBe('bot_sender');
    expect(rejectActor({ ignoreBots: false }, { login: 'ci', isBot: true }, undefined, [])).toBeUndefined();
    expect(rejectActor({ actorAllowlist: ['U-1'] }, human, undefined, [human.id])).toBeUndefined();
    expect(rejectActor({ actorAllowlist: ['bob'] }, human, undefined, [human.id])?.reason).toBe('actor_not_allowed');
  });

  it('compares an actor allowlist only with the identities the adapter vouches for', () => {
    // A display name set to an allowed id is not that user.
    const impostor = { login: 'u-1', id: 'u-2', isBot: false };
    expect(rejectActor({ actorAllowlist: ['u-1'] }, impostor, undefined, [impostor.id])?.reason).toBe('actor_not_allowed');
    expect(rejectActor({ actorAllowlist: ['u-1'] }, impostor, undefined, [undefined, ''])?.reason).toBe('actor_not_allowed');
    expect(rejectActor({ actorAllowlist: ['Alice'] }, { login: 'alice', isBot: false }, undefined, ['alice'])).toBeUndefined();
  });

  it('indexes every provider rule by scope and trigger, with an empty key for an omitted filter', () => {
    const keys = (match: unknown) => ruleIndexKeys(AutomationRuleMatchSchema.parse(match));
    expect(keys({ repository: 'Acme/Widgets', events: ['issues'], label: 'Claude' })).toEqual({ scope: 'acme/widgets', trigger: 'claude' });
    expect(keys({ provider: 'linear', trigger: 'state_changed' })).toEqual({ scope: ANY_INDEX_KEY, trigger: ANY_INDEX_KEY });
    expect(keys({ provider: 'linear', teamKey: 'ENG', trigger: 'state_changed', toState: 'In Progress' })).toEqual({ scope: 'eng', trigger: ANY_INDEX_KEY });
    expect(keys({ provider: 'custom', event: 'deploy.failed', label: 'Claude' })).toEqual({ scope: 'deploy.failed', trigger: ANY_INDEX_KEY });
    expect(keys({ provider: 'jira', projectKey: 'OPS', trigger: 'label_added', label: 'AI' })).toEqual({ scope: 'ops', trigger: ANY_INDEX_KEY });
    expect(keys({ provider: 'custom', event: 'deploy.failed' })).toEqual({ scope: 'deploy.failed', trigger: ANY_INDEX_KEY });
    expect(eventIndexKeys(event({ provider: 'linear', eventType: 'linear.issue.state_changed', scope: 'ENG', label: undefined, toState: 'Done' })))
      .toEqual({ scope: 'eng', trigger: 'done' });
  });

  it('rejects adapter output that is unbounded, mislabelled or not https', () => {
    expect(normalizedEventProblem(event())).toBeUndefined();
    expect(normalizedEventProblem(event({ eventType: 'linear.issue.label_added' }))).toBe('eventType');
    expect(normalizedEventProblem(event({ scope: 'a\nb' }))).toBe('scope');
    expect(normalizedEventProblem(event({ resourceUrl: 'http://example.com/x' }))).toBe('resourceUrl');
    expect(normalizedEventProblem(event({ resourceNumber: 0 }))).toBe('resourceNumber');
    expect(normalizedEventProblem(event({ label: '' }))).toBe('label');
    expect(normalizedEventProblem(event({ body: 'x'.repeat(9_000) }))).toBe('body');
    expect(normalizedEventProblem(event({ extras: { 'bad key': 1 } }))).toBe('extras');
    expect(normalizedEventProblem(event({ extras: { issueId: 'x'.repeat(201) } }))).toBe('extras');
    expect(normalizedEventProblem(event({ extras: { issueId: 'abc', count: 2, flag: true } }))).toBeUndefined();
  });
});
