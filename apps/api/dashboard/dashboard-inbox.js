/**
 * The notification inbox in the Dashboard: the newest notifications first, where each one was
 * delivered, read state, and the per-kind delivery preferences.
 *
 * Every value rendered here comes from the strict notification projection of the dashboard API and
 * is escaped. A notification link is followed only when it is a relative `/dashboard` path; anything
 * else renders as plain text. The related links of an automation run (its source issue, trace and pull
 * request) render only when the source and pull request are canonical https URLs without credentials,
 * query or fragment, and the trace is a relative `/dashboard` path. The inbox itself cannot be turned
 * off; preferences choose the extra channels (MCP Events and the GitHub comment mirror) per
 * notification kind.
 */
import { api } from './dashboard-api.js';
import { escapeHtml as escape } from './dashboard-render.js';

const NOTIFICATION_ID = /^ntf_[a-f0-9]{32}$/;
const SAFE_LINK = /^\/dashboard(?:\/[A-Za-z0-9._~-]+)*\/?$/;
const PAGE_SIZE = 50;

/** Notification kinds, in the order the preferences table lists them. */
export const NOTIFICATION_KIND_LABELS = {
  'automation.completed': 'Automation completed',
  'automation.failed': 'Automation failed',
  'agent.completed': 'Agent completed',
  'agent.failed': 'Agent failed',
  'workflow.waiting_for_human': 'Waiting for you',
  'approval.decided': 'Approval decided'
};
/** Channels a preference can switch; the inbox is always on. */
export const NOTIFICATION_CHANNEL_LABELS = { mcp_event: 'MCP Events', github: 'GitHub comment status' };
const CHANNEL_LABELS = { inbox: 'Inbox', ...NOTIFICATION_CHANNEL_LABELS };
const DELIVERY_LABELS = { PENDING: 'pending', CLAIMED: 'sending', DELIVERED: 'delivered', FAILED: 'failed', REVOKED: 'stopped' };
/** Pill classes reuse the shared status palette; the label carries the meaning, never colour alone. */
const DELIVERY_CLASSES = { PENDING: 'queued', CLAIMED: 'running', DELIVERED: 'succeeded', FAILED: 'failed', REVOKED: 'revoked' };

export function notificationKindLabel(kind) {
  return NOTIFICATION_KIND_LABELS[kind] ?? 'Notification';
}

/** A link the inbox may navigate to: relative, under `/dashboard`, without dot segments. */
export function safeNotificationLink(link) {
  if (typeof link !== 'string' || link.length > 300 || !SAFE_LINK.test(link)) return null;
  return link.split('/').some((segment) => segment === '.' || segment === '..') ? null : link;
}

/** An off-site link the inbox may open: a canonical https URL with no user info, query or fragment. */
export function safeExternalNotificationLink(link) {
  if (typeof link !== 'string' || link.length > 300) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === link ? link : null;
  } catch {
    return null;
  }
}

const RELATED_LINKS = [
  ['source', 'Source', safeExternalNotificationLink],
  ['trace', 'Trace', safeNotificationLink],
  ['pullRequest', 'Pull request', safeExternalNotificationLink]
];

/** The run's other deep links beside the primary one; off-site links open in a new tab. */
function relatedLinks(notification) {
  const links = notification.links && typeof notification.links === 'object' ? notification.links : {};
  const items = RELATED_LINKS.flatMap(([key, label, safe]) => {
    const href = safe(links[key]);
    if (!href) return [];
    const external = safe === safeExternalNotificationLink;
    return [`<li><a href="${escape(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escape(label)}</a></li>`];
  });
  return items.length ? `<ul class="inbox-links" aria-label="Related links">${items.join('')}</ul>` : '';
}

/** The inbox list API path. */
export function inboxListPath({ cursor, unreadOnly = false, limit = PAGE_SIZE } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (unreadOnly) query.set('unread', 'true');
  if (cursor) query.set('cursor', cursor);
  return `/inbox?${query}`;
}

/** Whether the URL asks for unread notifications only. */
export function inboxUnreadOnly(search) {
  return new URLSearchParams(search ?? '').get('unread') === '1';
}

function time(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return 'unknown';
  return `<time datetime="${escape(value)}">${escape(parsed.toLocaleString())}</time>`;
}

function deliveryPill(delivery) {
  const channel = CHANNEL_LABELS[delivery.channel] ?? delivery.channel;
  const state = DELIVERY_LABELS[delivery.state] ?? 'unknown';
  const detail = delivery.lastErrorClass ? ` (${delivery.lastErrorClass})` : '';
  return `<li><span class="status ${escape(DELIVERY_CLASSES[delivery.state] ?? '')}">${escape(`${channel}: ${state}${detail}`)}</span></li>`;
}

function notificationRow(notification) {
  const unread = !notification.readAt;
  const link = safeNotificationLink(notification.link);
  const title = link ? `<a href="${escape(link)}">${escape(notification.title)}</a>` : escape(notification.title);
  const id = NOTIFICATION_ID.test(String(notification.notificationId)) ? notification.notificationId : '';
  const action = unread && id
    ? `<button type="button" data-mark-read="${escape(id)}">Mark read</button>`
    : '';
  return `<tr class="inbox-row${unread ? ' unread' : ''}"><th scope="row">`
    + `${unread ? '<span class="inbox-unread">Unread</span> ' : ''}${title}<small>${escape(notificationKindLabel(notification.kind))}</small>${relatedLinks(notification)}</th>`
    + `<td>${time(notification.createdAt)}</td>`
    + `<td><ul class="inbox-deliveries" aria-label="Delivery">${(notification.deliveries ?? []).map(deliveryPill).join('')}</ul></td>`
    + `<td><div class="row-actions">${action}</div></td></tr>`;
}

export function renderInboxRows(notifications = []) {
  return notifications.map(notificationRow).join('');
}

/** The notification table; an empty inbox explains what lands here. */
export function renderInboxTable(notifications = [], { nextCursor = null, unreadOnly = false } = {}) {
  if (!notifications.length) {
    return unreadOnly
      ? '<div class="empty"><h3>No unread notifications.</h3><p>Everything in your inbox has been read.</p></div>'
      : '<div class="empty"><h3>Your inbox is empty.</h3><p>A notification arrives when an automation or a top-level agent finishes, or when a run is waiting for your approval.</p></div>';
  }
  return `<div class="desktop-table"><table id="inbox-table"><caption>${escape(`${notifications.length} notification(s), newest first`)}</caption>`
    + '<thead><tr><th>Notification</th><th>When</th><th>Delivery</th><th><span class="sr-only">Actions</span></th></tr></thead>'
    + `<tbody id="inbox-rows">${renderInboxRows(notifications)}</tbody></table></div>`
    + `<div class="row-actions"><button id="inbox-load-more" type="button"${nextCursor ? '' : ' hidden'}>Load more</button></div>`;
}

/** The preferences matrix: one checkbox per kind and switchable channel. */
export function renderInboxPreferences(preferences = []) {
  const enabled = new Map(preferences.map((preference) => [`${preference.channel}:${preference.kind}`, preference.enabled !== false]));
  const channels = Object.entries(NOTIFICATION_CHANNEL_LABELS);
  const rows = Object.entries(NOTIFICATION_KIND_LABELS).map(([kind, label]) => `<tr><th scope="row">${escape(label)}</th>${channels.map(([channel, channelLabel]) => {
    const key = `${channel}:${kind}`;
    return `<td><input type="checkbox" name="${escape(key)}" aria-label="${escape(`${channelLabel} for ${label}`)}"${enabled.get(key) === false ? '' : ' checked'}></td>`;
  }).join('')}</tr>`).join('');
  return '<section class="panel" aria-labelledby="inbox-preferences-heading"><h2 id="inbox-preferences-heading">Delivery preferences</h2>'
    + '<p class="metric-note">The inbox always records every notification. Turning a channel off stops its pending deliveries. MCP Events reach only an active <code>cloudharness.notification.created</code> subscription; GitHub mirrors the comment an automation already posts.</p>'
    + `<form id="inbox-preferences"><div class="desktop-table"><table class="inbox-preferences"><thead><tr><th>Kind</th>${channels.map(([, label]) => `<th>${escape(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
    + '<div class="row-actions"><button type="submit">Save preferences</button></div></form></section>';
}

/** Mark-all needs something unread and the server's watermark to bound it; it is never sent unbounded. */
function markAllEnabled(unread, readThrough) {
  return unread > 0 && readThrough !== null;
}

export function renderInboxPage({ notifications = [], nextCursor = null, unread = 0, unreadOnly = false, preferences = [], readThrough = null } = {}) {
  const filter = unreadOnly
    ? '<a href="/dashboard/inbox">Show all</a>'
    : '<a href="/dashboard/inbox?unread=1">Show unread only</a>';
  return `<div class="row-actions inbox-toolbar"><p class="metric-note" id="inbox-unread-count">${escape(`${unread} unread`)}</p>${filter}`
    + `<button id="inbox-mark-all" type="button"${markAllEnabled(unread, readThrough) ? '' : ' disabled'}>Mark all read</button></div>`
    + `<section id="inbox-list" aria-label="Notifications">${renderInboxTable(notifications, { nextCursor, unreadOnly })}</section>`
    + renderInboxPreferences(preferences);
}

/** Preference updates from the form, for every switchable channel and kind. */
export function preferencesFromForm(form) {
  const checked = new Set();
  for (const [key] of new FormData(form)) checked.add(String(key));
  return Object.keys(NOTIFICATION_CHANNEL_LABELS).flatMap((channel) => Object.keys(NOTIFICATION_KIND_LABELS)
    .map((kind) => ({ channel, kind, enabled: checked.has(`${channel}:${kind}`) })));
}

/**
 * Whether notifications are on, and the unread count, from the cheap status route. Only an answer
 * that the feature is off hides the Inbox; a transient failure keeps the entry visible.
 */
export async function inboxStatus(fetcher = api) {
  try {
    const result = await fetcher('/inbox/status');
    return { available: result?.data?.enabled !== false, unread: Number(result?.data?.unread ?? 0) || 0 };
  } catch (error) {
    return { available: error?.code !== 'feature_disabled', unread: 0 };
  }
}

/**
 * The inbox page controller. `onUnread` receives the unread count after every read or write so the
 * sidebar badge stays current.
 */
export function createInboxView({ insert, announce = () => {}, onUnread = () => {}, fetcher = api }) {
  async function load(container, search) {
    const unreadOnly = inboxUnreadOnly(search);
    const [list, preferences] = await Promise.all([
      fetcher(inboxListPath({ unreadOnly })),
      fetcher('/notification-preferences')
    ]);
    const state = { unreadOnly };
    applyList(state, list);
    insert(container, renderInboxPage({ ...state, preferences: preferences?.data?.preferences ?? [] }));
    onUnread(state.unread);
    bindList(container, state);
    bindPreferences(container);
  }

  /**
   * Takes a first-page list response. "Mark all read" covers what existed when it was listed: the
   * server's insertion watermark, so a notification written later stays unread.
   */
  function applyList(state, list) {
    state.notifications = list?.data?.notifications ?? [];
    state.nextCursor = list?.data?.nextCursor ?? null;
    state.unread = Number(list?.data?.unread ?? 0) || 0;
    const through = list?.data?.readThrough;
    state.readThrough = Number.isSafeInteger(through) && through > 0 ? through : null;
  }

  function setUnread(container, state, unread) {
    state.unread = unread;
    onUnread(unread);
    const count = container.querySelector?.('#inbox-unread-count');
    if (count) count.textContent = `${unread} unread`;
    const all = container.querySelector?.('#inbox-mark-all');
    if (all) all.disabled = !markAllEnabled(unread, state.readThrough);
  }

  /**
   * The server marks only rows written up to the watermark, and a page loaded later through "Load more"
   * can hold rows written after it, so the list is re-read instead of guessing which rows were covered.
   */
  async function markAll(container, state) {
    const result = await fetcher('/inbox/read', { method: 'POST', body: JSON.stringify({ all: true, through: state.readThrough }) });
    let unread = Number(result?.data?.unread ?? 0) || 0;
    try {
      const list = await fetcher(inboxListPath({ unreadOnly: state.unreadOnly }));
      applyList(state, list);
      unread = state.unread;
      renderRows(container, state);
      const more = container.querySelector?.('#inbox-load-more');
      if (more) more.hidden = !state.nextCursor;
    } catch {
      // The rows stay as they were until the next load; the count still comes from the server.
    }
    setUnread(container, state, unread);
    return Number(result?.data?.updated ?? 0) || 0;
  }

  function renderRows(container, state) {
    const body = container.querySelector?.('#inbox-rows');
    if (body) insert(body, renderInboxRows(state.notifications));
  }

  async function markRead(container, state, id) {
    const result = await fetcher('/inbox/read', { method: 'POST', body: JSON.stringify({ notificationIds: [id] }) });
    const now = new Date().toISOString();
    for (const notification of state.notifications) {
      if (!notification.readAt && notification.notificationId === id) notification.readAt = now;
    }
    renderRows(container, state);
    setUnread(container, state, Number(result?.data?.unread ?? 0) || 0);
    return Number(result?.data?.updated ?? 0) || 0;
  }

  function bindList(container, state) {
    const rows = container.querySelector?.('#inbox-list');
    rows?.addEventListener?.('click', async (event) => {
      const button = event.target?.closest?.('[data-mark-read]');
      const id = button?.getAttribute?.('data-mark-read');
      if (!button || !NOTIFICATION_ID.test(String(id))) return;
      button.disabled = true;
      try {
        await markRead(container, state, id);
        announce('Notification marked read.');
      } catch {
        button.disabled = false;
        announce('The notification could not be marked read.');
      }
    });
    const all = container.querySelector?.('#inbox-mark-all');
    all?.addEventListener?.('click', async () => {
      if (state.readThrough === null) return;
      all.disabled = true;
      try {
        const updated = await markAll(container, state);
        announce(`${updated} notification(s) marked read.`);
      } catch {
        all.disabled = false;
        announce('Notifications could not be marked read.');
      }
    });
    const more = container.querySelector?.('#inbox-load-more');
    more?.addEventListener?.('click', async () => {
      if (!state.nextCursor) return;
      more.disabled = true;
      try {
        const page = await fetcher(inboxListPath({ cursor: state.nextCursor, unreadOnly: state.unreadOnly }));
        const next = page?.data?.notifications ?? [];
        state.notifications.push(...next);
        state.nextCursor = page?.data?.nextCursor ?? null;
        renderRows(container, state);
        more.hidden = !state.nextCursor;
        announce(`${next.length} more notification(s) loaded.`);
      } catch {
        announce('More notifications could not load.');
      } finally {
        more.disabled = false;
      }
    });
  }

  function bindPreferences(container) {
    const form = container.querySelector?.('#inbox-preferences');
    form?.addEventListener?.('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector?.('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const result = await fetcher('/notification-preferences', { method: 'PUT', body: JSON.stringify({ preferences: preferencesFromForm(event.currentTarget ?? form) }) });
        const revoked = Number(result?.data?.revoked ?? 0) || 0;
        announce(revoked > 0 ? `Preferences saved. ${revoked} pending delivery(ies) stopped.` : 'Preferences saved.');
      } catch {
        announce('Preferences could not be saved.');
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  return { load };
}
