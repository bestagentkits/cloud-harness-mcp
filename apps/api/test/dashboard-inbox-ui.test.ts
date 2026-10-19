import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import './dashboard-test-dom.js';
import {
  NOTIFICATION_KIND_LABELS, createInboxView, inboxListPath, inboxStatus, inboxUnreadOnly, renderInboxPage, renderInboxPreferences,
  renderInboxTable, safeNotificationLink
} from '../dashboard/dashboard-inbox.js';
import { FakeElement } from './dashboard-test-dom.js';

const id = (char: string) => `ntf_${char.repeat(32)}`;
const hostile = '<img src=x onerror=alert(1)>';
const at = '2026-10-20T00:00:00.000Z';
const notification = (overrides: Record<string, unknown> = {}) => ({
  notificationId: id('a'), kind: 'automation.failed', subjectType: 'automation_workflow', subjectId: 'wfl_1',
  title: 'Automation failed: acme/widgets#7', link: '/dashboard/automations/runs/wfl_1', createdAt: at, readAt: null,
  deliveries: [
    { channel: 'inbox', state: 'DELIVERED', attempts: 0, lastErrorClass: null, updatedAt: at },
    { channel: 'mcp_event', state: 'FAILED', attempts: 5, lastErrorClass: 'http_5xx', updatedAt: at }
  ],
  ...overrides
});

describe('inbox rendering', () => {
  it('escapes every value and links only to relative Dashboard paths', () => {
    const markup = renderInboxTable([
      notification({ title: hostile, kind: hostile, deliveries: [{ channel: hostile, state: hostile, attempts: 0, lastErrorClass: hostile, updatedAt: at }] }),
      notification({ notificationId: id('b'), link: 'javascript:alert(1)' }),
      notification({ notificationId: id('c'), link: '/dashboard/../api/v1/x' })
    ]);
    expect(markup).not.toContain(hostile);
    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('/dashboard/../');
    expect(markup).not.toMatch(/style=/i);
    expect(safeNotificationLink('//evil.example.com')).toBeNull();
    expect(safeNotificationLink('/dashboard/approvals')).toBe('/dashboard/approvals');
  });

  it('states delivery and read state in words, not colour alone', () => {
    const markup = renderInboxTable([notification(), notification({ notificationId: id('b'), readAt: at })]);
    expect(markup).toContain('Inbox: delivered');
    expect(markup).toContain('MCP Events: failed (http_5xx)');
    expect(markup).toContain('<span class="inbox-unread">Unread</span>');
    expect(markup.match(/data-mark-read=/g)).toHaveLength(1);
  });

  it('explains an empty inbox and an empty unread filter', () => {
    expect(renderInboxTable([])).toContain('Your inbox is empty.');
    expect(renderInboxTable([], { unreadOnly: true })).toContain('No unread notifications.');
    expect(renderInboxPage({ unread: 0 })).toContain('id="inbox-mark-all" type="button" disabled');
  });

  it('renders a checkbox per switchable channel and kind, defaulting to on', () => {
    const markup = renderInboxPreferences([{ channel: 'github', kind: 'agent.failed', enabled: false }]);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2 * Object.keys(NOTIFICATION_KIND_LABELS).length);
    expect(markup).toContain('name="github:agent.failed" aria-label="GitHub comment status for Agent failed">');
    expect(markup).toContain('name="mcp_event:agent.failed" aria-label="MCP Events for Agent failed" checked>');
    expect(markup).not.toContain('name="inbox:');
  });

  it('builds list paths from the URL', () => {
    expect(inboxUnreadOnly('?unread=1')).toBe(true);
    expect(inboxUnreadOnly('?unread=true')).toBe(false);
    expect(inboxListPath({ unreadOnly: true, cursor: 'abc' })).toBe('/inbox?limit=50&unread=true&cursor=abc');
  });
});

function harness(responses: (path: string, options?: any) => unknown, elements: Record<string, FakeElement> = {}) {
  const container = new FakeElement() as FakeElement & { querySelector: (selector: string) => FakeElement | null };
  container.querySelector = (selector: string) => elements[selector] ?? null;
  const insert = vi.fn((element: FakeElement, markup: string) => { element.markup = markup; });
  const fetcher = vi.fn(async (path: string, options?: any) => {
    const value = responses(path, options);
    if (value instanceof Error) throw value;
    return value;
  });
  const onUnread = vi.fn();
  const announce = vi.fn();
  const view = createInboxView({ insert, fetcher, onUnread, announce });
  return { view, container, insert, fetcher, onUnread, announce };
}

const pageResponses = (path: string, options?: any) => {
  if (path === '/notification-preferences' && !options) return { data: { preferences: [] } };
  if (path === '/notification-preferences') return { data: { preferences: [], revoked: 2 } };
  if (path === '/inbox/read') return { data: { updated: 1, unread: 0 } };
  return { data: { notifications: [notification()], nextCursor: null, unread: 1 } };
};

describe('inbox controller', () => {
  it('loads the list and preferences, and reports the unread count for the badge', async () => {
    const { view, container, fetcher, onUnread } = harness(pageResponses);
    await view.load(container, '?unread=1');
    expect(fetcher).toHaveBeenCalledWith('/inbox?limit=50&unread=true');
    expect(fetcher).toHaveBeenCalledWith('/notification-preferences');
    expect(container.markup).toContain('Automation failed: acme/widgets#7');
    expect(onUnread).toHaveBeenCalledWith(1);
  });

  it('marks one notification read through the API and refreshes the rows and badge', async () => {
    const list = new FakeElement();
    const rows = new FakeElement();
    const count = new FakeElement();
    const { view, container, fetcher, onUnread, announce } = harness(pageResponses, { '#inbox-list': list, '#inbox-rows': rows, '#inbox-unread-count': count });
    await view.load(container, '');
    const button = new FakeElement();
    button.setAttribute('data-mark-read', id('a'));
    list.dispatch('click', { target: { closest: () => button } });
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith('Notification marked read.'));
    expect(fetcher).toHaveBeenCalledWith('/inbox/read', { method: 'POST', body: JSON.stringify({ notificationIds: [id('a')] }) });
    expect(rows.markup).not.toContain('data-mark-read');
    expect(count.textContent).toBe('0 unread');
    expect(onUnread).toHaveBeenLastCalledWith(0);
  });

  it('marks all read only through the newest notification this page load showed', async () => {
    const all = new FakeElement() as FakeElement & { disabled?: boolean };
    const rows = new FakeElement();
    const later = '2026-10-20T00:05:00.000Z';
    const responses = (path: string, options?: any) => (path.startsWith('/inbox?')
      ? { data: { notifications: [notification({ createdAt: later }), notification({ notificationId: id('b') })], nextCursor: null, unread: 2 } }
      : pageResponses(path, options));
    const { view, container, fetcher, announce } = harness(responses, { '#inbox-mark-all': all, '#inbox-rows': rows });
    await view.load(container, '');
    all.dispatch('click', {});
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith('1 notification(s) marked read.'));
    expect(fetcher).toHaveBeenCalledWith('/inbox/read', { method: 'POST', body: JSON.stringify({ all: true, before: later }) });
    expect(rows.markup).not.toContain('data-mark-read');
  });

  it('ignores a click whose target carries a malformed id', async () => {
    const list = new FakeElement();
    const { view, container, fetcher } = harness(pageResponses, { '#inbox-list': list });
    await view.load(container, '');
    fetcher.mockClear();
    const button = new FakeElement();
    button.setAttribute('data-mark-read', 'ntf_../../x');
    list.dispatch('click', { target: { closest: () => button } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('saves preferences and says how many pending deliveries stopped', async () => {
    const form = new FakeElement();
    const { view, container, fetcher, announce } = harness(pageResponses, { '#inbox-preferences': form });
    await view.load(container, '');
    const original = (globalThis as any).FormData;
    (globalThis as any).FormData = class { [Symbol.iterator]() { return [['mcp_event:agent.failed', 'on']][Symbol.iterator](); } };
    try {
      form.dispatch('submit', { preventDefault: () => {}, currentTarget: form });
      await vi.waitFor(() => expect(announce).toHaveBeenCalledWith('Preferences saved. 2 pending delivery(ies) stopped.'));
    } finally {
      (globalThis as any).FormData = original;
    }
    const [, options] = fetcher.mock.calls.find(([path, init]) => path === '/notification-preferences' && init)!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.preferences).toHaveLength(12);
    expect(body.preferences.filter((entry: { enabled: boolean }) => entry.enabled)).toEqual([{ channel: 'mcp_event', kind: 'agent.failed', enabled: true }]);
  });

  it('reports availability from the status route, hiding only on the feature-disabled answer', async () => {
    expect(await inboxStatus(async () => ({ data: { enabled: true, unread: 3 } }))).toEqual({ available: true, unread: 3 });
    expect(await inboxStatus(async () => ({ data: { enabled: false, unread: 0 } }))).toEqual({ available: false, unread: 0 });
    expect(await inboxStatus(async () => { throw Object.assign(new Error('off'), { code: 'feature_disabled' }); })).toEqual({ available: false, unread: 0 });
    expect(await inboxStatus(async () => { throw Object.assign(new Error('boom'), { code: 'unavailable' }); })).toEqual({ available: true, unread: 0 });
  });
});

describe('dashboard wiring', () => {
  it('hides the Inbox rail entry until the server confirms notifications are on', () => {
    const script = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(script).toContain('a[data-feature="notifications"]');
    expect(script).toContain("inbox: loadInbox");
    expect(script).toContain('#nav-badge-inbox');
  });
});
