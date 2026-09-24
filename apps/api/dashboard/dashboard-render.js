const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

/** Exported so the shell navigation renders registry values through the same escaping path as every renderer. */
export const escapeHtml = escape;
const statusLabel = (status) => ({ CREATING: 'Creating', ACTIVE: 'Active', REAPING: 'Closing', CLOSED: 'Closed', FAILED: 'Failed', NETWORK_QUARANTINED: 'Quarantined' })[status] ?? 'Unknown';
const networkLabel = (profile) => profile === 'dependency-access' ? 'Dependency access' : profile === 'local-host' ? 'Local host' : 'No network';
const time = (value) => `<time datetime="${escape(value)}">${escape(new Date(value).toLocaleString())}</time>`;

/**
 * The shared resource-page layout: an optional note, an optional filter bar, and
 * the resource body. Page identity (title, help) comes from the page registry;
 * the primary action is rendered into the shell's action slot by the loader.
 */
export function renderResourcePage({ note = '', filters = '', body }) {
  return `${note}${filters ? `<div class="resource-filters">${filters}</div>` : ''}<div class="resource-body">${body}</div>`;
}

/** Exactly one visually dominant action per page states the one thing to do next. */
export function renderPrimaryAction({ id, label, dialogId, disabled = false }) {
  return `<button id="${escape(id)}" class="accent-btn" type="button"${dialogId ? ` data-dialog="${escape(dialogId)}"` : ''}${disabled ? ' disabled' : ''}>${escape(label)}</button>`;
}

/** A secondary action in the same slot: never accented, never competing for attention. */
export function renderSecondaryAction({ id, label, dialogId, disabled = false }) {
  return `<button id="${escape(id)}" type="button"${dialogId ? ` data-dialog="${escape(dialogId)}"` : ''}${disabled ? ' disabled' : ''}>${escape(label)}</button>`;
}

/** The Models & Budgets page actions: one primary (a profile), one secondary (a credential). */
export function renderModelsActions() {
  return `${renderSecondaryAction({ id: 'open-add-credential-btn', label: '+ Add credential' })}${renderPrimaryAction({ id: 'open-add-profile-btn', label: '+ Add profile' })}`;
}

/** The MCP tab's single primary action. */
export function renderMcpActions() {
  return '<div class="row-actions"><button class="accent-btn" type="button" data-mcp-add aria-haspopup="dialog">Add MCP server</button></div>';
}

/**
 * The GitHub tab's maintenance action. GitHub's own primary path is the setup form
 * rendered in the page body, so this stays a plain action rather than a second
 * accented button.
 */
export function renderGitHubActions(status) {
  const installations = Array.isArray(status?.installations) && status.installations.length
    ? status.installations
    : (status?.installation ? [status.installation] : []);
  const label = installations.length > 1 ? 'Reconcile all installations' : 'Reconcile installation';
  return `<button id="reconcile-github" type="button"${installations.length === 0 ? ' disabled' : ''}>${escape(label)}</button>`;
}

/**
 * A create/edit dialog. The form keeps the element ids the page loaders already
 * bind and the UI contract tests already assert, so the mutation keeps one
 * description while its markup moves off the page body.
 */
export function renderFormDialog({ id, title, description, formId, body, submitLabel, submitId, danger = false }) {
  return `<dialog id="${escape(id)}" aria-labelledby="${escape(id)}-title" aria-describedby="${escape(id)}-description"><h2 id="${escape(id)}-title">${escape(title)}</h2><p id="${escape(id)}-description">${escape(description)}</p><form id="${escape(formId)}" class="stack-form">${body}<p class="form-status" aria-live="polite"></p><div class="dialog-actions"><button type="button" data-dialog-close>Cancel</button><button id="${escape(submitId)}" class="${danger ? 'danger' : 'accent-btn'}" type="submit">${escape(submitLabel)}</button></div></form></dialog>`;
}

/**
 * A copy affordance for identifiers. Ids and generations are secondary metadata:
 * they are copied, not read, so they never become the page's labels.
 */
export function renderCopyChip({ value, label }) {
  return `<button class="copy-chip mono" type="button" data-copy="${escape(value)}" data-copy-label="${escape(label)}" aria-label="Copy ${escape(label)}">${escape(value)}</button>`;
}

export function renderWorkspaceIndex(workspaces, query) {
  const expiringMinutes = Number(query.expiring);
  const now = Date.now();
  const filtered = workspaces.filter((workspace) => {
    const term = query.q.toLowerCase();
    if (query.status && workspace.status !== query.status) return false;
    if (term && !`${workspace.repositoryUrl} ${workspace.workspaceId}`.toLowerCase().includes(term)) return false;
    // The Overview's "Expiring soon" tile links here with a minute budget, so the view
    // shows exactly the leases that budget names instead of the whole list.
    if (Number.isFinite(expiringMinutes) && expiringMinutes > 0) {
      const expiresAt = Date.parse(workspace.expiresAt ?? '');
      if (!Number.isFinite(expiresAt) || expiresAt - now > expiringMinutes * 60_000) return false;
    }
    return true;
  });
  if (!workspaces.length) return '<h2 id="workspace-list-heading">Workspace list</h2><div class="empty"><h3>No workspaces yet.</h3><p>Open one from an MCP client and it will appear here.</p></div>';
  if (!filtered.length) return '<h2 id="workspace-list-heading">Workspace list</h2><div class="empty"><h3>No workspaces match these filters.</h3><button id="clear-filters" type="button">Clear filters</button></div>';
  const rows = filtered.map((workspace) => `<tr><th scope="row"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a><small class="mono">${escape(workspace.workspaceId)}</small></th><td><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span></td><td>${time(workspace.lastActivityAt)}</td><td>${time(workspace.expiresAt)}</td><td>${networkLabel(workspace.networkProfile)}</td></tr>`).join('');
  const cards = filtered.map((workspace) => `<li><h3><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a></h3><dl><dt>State</dt><dd>${statusLabel(workspace.status)}</dd><dt>Last activity</dt><dd>${time(workspace.lastActivityAt)}</dd><dt>Expires</dt><dd>${time(workspace.expiresAt)}</dd></dl></li>`).join('');
  return `<h2 id="workspace-list-heading">Workspace list</h2><div class="desktop-table"><table><caption>${filtered.length} workspaces</caption><thead><tr><th>Repository</th><th>State</th><th>Last activity</th><th>Expires</th><th>Network</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

/** Contextual workspace sections. These are never global rail entries. */
export const WORKSPACE_TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'agents', label: 'Agents' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'automation', label: 'Automation' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'activity', label: 'Activity' }
];

/** Tabs are all backed by real adapters, so no tab needs a phase label. */

/** Lease posture from the workspace record. Thresholds drive emphasis, never colour alone. */
export function workspaceLeaseState(workspace, now = Date.now()) {
  const expiresAt = Date.parse(workspace?.expiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return { state: 'unknown', label: 'Lease unknown' };
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return { state: 'expired', label: 'Lease expired' };
  const minutes = Math.round(remainingMs / 60_000);
  if (remainingMs <= 10 * 60_000) return { state: 'soon', label: `${minutes} min left` };
  return { state: 'ok', label: `${Math.round(minutes / 60)} h left` };
}

/**
 * The attention list contains only reasons the dashboard can actually observe. An
 * invented reason is worse than a missing one, so the agent, task and Git reasons
 * join once the phases that expose them land.
 */
export function workspaceAttention(workspace, options = {}) {
  const reasons = [];
  const lease = workspaceLeaseState(workspace, options.now);
  if (lease.state === 'expired') reasons.push({ id: 'lease-expired', label: 'Lease expired', detail: 'Renew the lease to keep working, or recover the workspace if it was reaped.' });
  else if (lease.state === 'soon') reasons.push({ id: 'lease-soon', label: 'Lease expires soon', detail: lease.label });
  if (workspace?.status === 'FAILED') reasons.push({ id: 'failed', label: 'Workspace setup failed', detail: 'Review the failure, and recover if the checkout is worth keeping.' });
  if (workspace?.status === 'NETWORK_QUARANTINED') reasons.push({ id: 'quarantine', label: 'Network quarantined', detail: 'Egress was revoked for this workspace, so dependency access is denied.' });
  if (options.dirty === true) reasons.push({ id: 'dirty-git', label: 'Uncommitted changes', detail: 'Commit or finalize before the workspace is reaped.' });
  if (Array.isArray(options.extra)) reasons.push(...options.extra);
  return reasons;
}

/** Header state first: repository, status, ref, network, lease, and the action set. */
export function renderWorkspaceCockpitHeader(workspace, options = {}) {
  const lease = workspaceLeaseState(workspace, options.now);
  const attention = workspaceAttention(workspace, options);
  const generation = Number(workspace?.version);
  const canClose = Number.isSafeInteger(generation) && generation > 0;
  return `<div class="cockpit-header"><div class="record-heading"><div><h2 id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</h2><p>${renderCopyChip({ value: workspace.workspaceId, label: 'Workspace ID' })}</p></div><span class="status ${escape(String(workspace.status ?? '').toLowerCase())}">${escape(statusLabel(workspace.status))}</span></div><dl class="facts"><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd><dt>Network</dt><dd>${escape(networkLabel(workspace.networkProfile))}</dd><dt>Lease</dt><dd class="lease-${escape(lease.state)}">${escape(lease.label)}</dd><dt>Attention</dt><dd>${attention.length ? `${escape(attention.length)} item(s) need action` : 'Nothing needs attention'}</dd></dl><div class="cockpit-actions"><button id="renew-workspace-lease" class="accent-btn" type="button">Renew lease</button><button id="finalize-workspace" type="button" data-dialog="finalize-workspace-dialog">Finalize workspace</button><details class="row-edit"><summary>More actions</summary><button id="recover-workspace" type="button"${workspace.status === 'ACTIVE' ? ' disabled' : ''}>Recover workspace</button><button id="close-workspace" class="danger" type="button"${canClose ? '' : ' disabled'}>Close workspace</button></details></div></div>`;
}

export function renderWorkspaceTabs(workspaceId, current) {
  return `<nav class="cockpit-tabs" aria-label="Workspace sections">${WORKSPACE_TABS.map((tab) => `<a href="/dashboard/workspaces/${encodeURIComponent(workspaceId)}/${tab.id}" ${tab.id === current ? 'aria-current="page"' : ''}>${escape(tab.label)}</a>`).join('')}</nav>`;
}

export function renderWorkspaceAttentionPanel(workspace, options = {}) {
  const attention = workspaceAttention(workspace, options);
  const items = attention.length
    ? `<ul class="attention-list">${attention.map((item) => `<li class="attention-item attention-${escape(item.id)}"><strong>${escape(item.label)}</strong><span>${escape(item.detail)}</span></li>`).join('')}</ul>`
    : '<p class="empty-note">Nothing needs attention right now.</p>';
  return `<section class="panel" aria-labelledby="attention-heading"><h2 id="attention-heading">Needs attention</h2>${items}</section>`;
}

/**
 * The Summary tab reports only what the dashboard can read today. Cost, budget and
 * agent/task counts arrive with the phases that expose them, and the panel says so
 * rather than showing a zero that reads like a measurement.
 */
export function renderWorkspaceSummary({ workspace, context, options = {} }) {
  const manifest = context?.manifest ?? {};
  const capabilities = Object.entries(context?.capabilities ?? {}).filter(([, value]) => value === true).map(([key]) => escape(key)).join(', ');
  const itemCount = Number.isFinite(manifest.itemCount) ? `${escape(manifest.itemCount)} attributable item(s)${manifest.truncated === true ? ' (truncated)' : ''}` : 'Not reported';
  return `${renderWorkspaceAttentionPanel(workspace, options)}<section class="panel" aria-labelledby="summary-heading"><h2 id="summary-heading">Summary</h2><dl class="facts"><dt>Status</dt><dd>${escape(statusLabel(workspace.status))}</dd><dt>Branch</dt><dd>${escape(context?.branch ?? workspace.ref ?? 'Default branch')}</dd><dt>Repository context</dt><dd>${itemCount}</dd><dt>Capabilities</dt><dd>${capabilities || 'Not reported'}</dd><dt>Network posture</dt><dd>${escape(networkLabel(workspace.networkProfile))}</dd><dt>Cost used</dt><dd>Not reported for workspaces yet</dd></dl><p class="page-note">Cost, budget, agent and task counts arrive with the phases that expose them; this panel never invents a number.</p></section>`;
}

/** Tabs are all backed by real adapters, so the cockpit never renders a placeholder.
 * @param {{ artifacts?: Record<string, unknown>[] }} [input] */
export function renderWorkspaceArtifacts({ artifacts = [] } = {}) {
  const rows = artifacts.length
    ? artifacts.map((artifact) => `<tr><th scope="row">${escape(artifact.logicalName)}<small class="mono wrap">${escape(artifact.artifactId)}</small></th><td>${escape(formatBytes(artifact.sizeBytes))}</td><td>${time(artifact.expiresAt)}</td><td><a class="secondary button download-artifact" href="/dashboard/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download" download="${escape(artifact.logicalName)}">Download</a></td></tr>`).join('')
    : '<tr><td colspan="4">No retained snapshots belong to this workspace yet.</td></tr>';
  return `<section class="panel" aria-labelledby="workspace-artifacts-heading"><h2 id="workspace-artifacts-heading">Artifacts</h2><p class="page-note">Bounded snapshots whose own record names this workspace. Creating and deleting snapshots stays on the global Artifacts page.</p><div class="desktop-table"><table><caption>${artifacts.length} snapshot(s)</caption><thead><tr><th>Name</th><th>Size</th><th>Expires</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/** The workspace's own activity: its live agent rows plus the audit rows recorded
 * against it, over the same event grammar the Activity Center uses.
 * @param {{ events?: Record<string, unknown>[]; workspaceId?: string }} [input] */
export function renderWorkspaceActivity({ events = [], workspaceId = '' } = {}) {
  const rows = events.length ? events.map(activityRow).join('') : '<li class="empty">No activity recorded for this workspace yet.</li>';
  return `<section class="panel" aria-labelledby="workspace-activity-heading"><h2 id="workspace-activity-heading">Activity</h2><p class="page-note">Live runtime rows and retained audit rows recorded against <span class="mono">${escape(workspaceId)}</span>. The cross-workspace view is the Activity Center.</p><ul class="activity-list">${rows}</ul></section>`;
}

/** The finalize dialog: a commit message, plus the push decision. */
export function renderFinalizeDialog() {
  return renderFormDialog({
    id: 'finalize-workspace-dialog', title: 'Finalize workspace',
    description: 'Stages the changes, runs the preflights, commits with the workspace identity, and pushes when you ask it to.',
    formId: 'finalize-workspace-form', submitId: 'finalize-workspace-submit', submitLabel: 'Finalize workspace',
    body: '<label for="finalize-commit-message">Commit message</label><input id="finalize-commit-message" name="commitMessage" required maxlength="10000"><label class="checkbox-label"><input name="push" type="checkbox" checked><span>Push to the remote after committing</span></label>'
  });
}

export const AGENT_STATUSES = ['SPAWNING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'LIMIT_EXCEEDED', 'INTERRUPTED'];

const AGENT_STATUS_LABELS = {
  SPAWNING: 'Spawning', RUNNING: 'Running', CANCELLING: 'Cancelling', SUCCEEDED: 'Succeeded',
  FAILED: 'Failed', CANCELLED: 'Cancelled', TIMED_OUT: 'Timed out', LIMIT_EXCEEDED: 'Limit exceeded', INTERRUPTED: 'Interrupted'
};

/** Agent state is always text plus a semantic class; colour is never the only signal. */
export function agentStatusLabel(status) {
  return AGENT_STATUS_LABELS[status] ?? 'Unknown';
}

/**
 * Budget utilization. A missing or unlimited budget reads as "Not reported" rather
 * than as 0%, because a zero would look like a measurement the runner never made.
 */
export function budgetUtilization(used, max) {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return { state: 'unknown', percent: undefined };
  const percent = Math.min(100, Math.round((used / max) * 100));
  return { state: percent >= 100 ? 'exhausted' : percent >= 80 ? 'close' : 'ok', percent };
}

/** Age and TTL readouts for the list and the detail view. */
export function agentAge(agent, now = Date.now()) {
  const started = Date.parse(agent?.startedAt ?? agent?.createdAt ?? '');
  if (!Number.isFinite(started)) return 'Not reported';
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

export function agentTtl(agent, now = Date.now()) {
  const expiresAt = Date.parse(agent?.expiresAt ?? '');
  if (!Number.isFinite(expiresAt)) return 'Not reported';
  const remaining = expiresAt - now;
  return remaining <= 0 ? 'Expired' : `${Math.round(remaining / 60_000)} min`;
}

const costOf = (micros) => (Number.isFinite(micros) ? `$${(micros / 1_000_000).toFixed(4)}` : 'Not reported');
const countOf = (value) => (Number.isFinite(value) ? String(value) : 'Not reported');
const percentOf = (used, max) => {
  const utilization = budgetUtilization(used, max);
  return utilization.state === 'unknown' ? 'Not reported' : `${utilization.percent}%`;
};

/**
 * Build the parent/child index. An agent whose parent is missing from this page is
 * attached to the root so it cannot vanish from the hierarchy.
 */
export function agentTreeIndex(agents = []) {
  const known = new Set(agents.map((agent) => agent.agentId));
  const byParent = new Map();
  for (const agent of agents) {
    const parent = agent.parentAgentId && known.has(agent.parentAgentId) ? agent.parentAgentId : 'root';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(agent);
  }
  return byParent;
}

function agentNode(agent, now) {
  const status = escape(agent.status ?? 'UNKNOWN');
  return `<div class="agent-node"><div class="agent-identity"><a href="/dashboard/agents/${encodeURIComponent(agent.agentId)}">${escape(agent.agentId)}</a><span class="status ${status.toLowerCase()}">${escape(agentStatusLabel(agent.status))}</span></div><dl class="facts"><dt>Workspace</dt><dd>${escape(agent.workspaceId ?? 'Not reported')}</dd><dt>Profile</dt><dd>${escape(agent.profileId ?? 'Not reported')}</dd><dt>Age</dt><dd>${escape(agentAge(agent, now))}</dd><dt>TTL</dt><dd>${escape(agentTtl(agent, now))}</dd><dt>Tokens</dt><dd>${escape(countOf(agent.usage?.inputTokens))} in · ${escape(countOf(agent.usage?.outputTokens))} out</dd><dt>Cost</dt><dd>${escape(costOf(agent.usage?.costMicros))}</dd><dt>Budget</dt><dd>${escape(percentOf(agent.usage?.costMicros, agent.budget?.maxCostMicros))} of cost limit</dd>${agent.terminalReason ? `<dt>Terminal reason</dt><dd>${escape(agent.terminalReason)}</dd>` : ''}${agent.outcomeUnknown === true ? '<dt>Outcome</dt><dd>Unknown — the agent stopped without a recorded terminal state</dd>' : ''}</dl></div>`;
}

/** Accessible parent/child hierarchy: a nested list, so a screen reader gets nesting. */
export function renderAgentHierarchy(agents = [], now = Date.now()) {
  const byParent = agentTreeIndex(agents);
  const seen = new Set();
  const render = (parentId) => {
    const children = byParent.get(parentId) ?? [];
    if (!children.length) return '';
    return `<ul class="agent-tree" role="list">${children.map((agent) => {
      if (seen.has(agent.agentId)) return '';
      seen.add(agent.agentId);
      return `<li>${agentNode(agent, now)}${render(agent.agentId)}</li>`;
    }).join('')}</ul>`;
  };
  const markup = render('root');
  return markup || '<p class="empty-note">No agents reported yet.</p>';
}

/** The flat fallback: same facts, one row per agent, with the parent named. */
export function renderAgentTable(agents = [], now = Date.now()) {
  const rows = agents.length
    ? agents.map((agent) => `<tr><th scope="row"><a href="/dashboard/agents/${encodeURIComponent(agent.agentId)}">${escape(agent.agentId)}</a></th><td><span class="status ${escape(String(agent.status ?? '').toLowerCase())}">${escape(agentStatusLabel(agent.status))}</span></td><td>${escape(agent.workspaceId ?? 'Not reported')}</td><td>${escape(agent.parentAgentId ?? '—')}</td><td>${escape(agent.profileId ?? 'Not reported')}</td><td>${escape(agentAge(agent, now))}</td><td>${escape(percentOf(agent.usage?.costMicros, agent.budget?.maxCostMicros))}</td><td>${escape(costOf(agent.usage?.costMicros))}</td></tr>`).join('')
    : '<tr><td colspan="8">No agents reported yet.</td></tr>';
  return `<div class="desktop-table"><table><caption>${agents.length} agent(s)</caption><thead><tr><th>Agent</th><th>Status</th><th>Workspace</th><th>Parent</th><th>Profile</th><th>Age</th><th>Budget</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Global Agents page and the workspace-scoped tab share this body. */
export function renderAgentsIndex({ agents = [], filters = {}, now = Date.now() } = {}) {
  const statusOptions = ['<option value="">All statuses</option>', ...AGENT_STATUSES.map((status) => `<option value="${escape(status)}"${filters.status === status ? ' selected' : ''}>${escape(agentStatusLabel(status))}</option>`)].join('');
  const attentionOptions = [['', 'Any attention state'], ['needs-attention', 'Needs attention'], ['clear', 'Clear']].map(([value, label]) => `<option value="${value}"${(filters.attention ?? '') === value ? ' selected' : ''}>${label}</option>`).join('');
  const filterRow = '<form id="agent-filters" class="resource-filters" role="search" aria-label="Filter agents">'
    + `<label for="agent-status-filter">Status</label><select id="agent-status-filter" name="status">${statusOptions}</select>`
    + (filters.workspaceId ? `<input type="hidden" name="workspaceId" value="${escape(filters.workspaceId)}">` : `<label for="agent-workspace-filter">Workspace</label><input id="agent-workspace-filter" name="workspaceId" value="${escape(filters.workspaceId ?? '')}" placeholder="ws_…" pattern="ws_[A-Za-z0-9_-]{20,80}">`)
    + `<label for="agent-profile-filter">Profile</label><input id="agent-profile-filter" name="profileId" value="${escape(filters.profileId ?? '')}" placeholder="coding-fast">`
    + `<label for="agent-parent-filter">Parent agent</label><input id="agent-parent-filter" name="parentAgentId" value="${escape(filters.parentAgentId ?? '')}" placeholder="agent_…">`
    + `<label for="agent-attention-filter">Attention</label><select id="agent-attention-filter" name="attention">${attentionOptions}</select>`
    + '<button type="submit">Apply filters</button></form>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Agent control.</strong> Every agent runs as your identity in an isolated executor with its own TTL, token, output and cost budgets. Child agents appear under the agent that spawned them.</div>',
    filters: filterRow,
    body: `<section aria-labelledby="agent-hierarchy-heading"><h2 id="agent-hierarchy-heading">Hierarchy</h2>${renderAgentHierarchy(agents, now)}</section><section aria-labelledby="agent-table-heading"><h2 id="agent-table-heading">All agents</h2>${renderAgentTable(agents, now)}</section>`
  })}`;
}

/**
 * One agent in full: overview, usage, logs, and the message controls. Logs are the
 * bounded projection the adapter produced; nothing larger is rendered here.
 */
export function renderAgentDetail({ agent, logs = [] } = {}) {
  const usage = agent?.usage ?? {};
  const budget = agent?.budget ?? {};
  const logRows = logs.length
    ? logs.map((event) => `<li class="agent-log-event"><span class="mono">${escape(event.type ?? 'event')}</span>${time(event.timestamp)}<pre class="mono">${escape(event.content ?? '')}</pre></li>`).join('')
    : '<li class="empty">No retained log events for this agent.</li>';
  const overview = `<section class="panel" aria-labelledby="agent-overview-heading"><h2 id="agent-overview-heading">Overview</h2><dl class="facts"><dt>Status</dt><dd><span class="status ${escape(String(agent?.status ?? '').toLowerCase())}">${escape(agentStatusLabel(agent?.status))}</span></dd><dt>Profile</dt><dd>${escape(agent?.profileId ?? 'Not reported')}</dd><dt>Parent</dt><dd>${escape(agent?.parentAgentId ?? 'None')}</dd><dt>Started</dt><dd>${agent?.startedAt ? time(agent.startedAt) : 'Not reported'}</dd><dt>Terminal</dt><dd>${agent?.terminalAt ? time(agent.terminalAt) : 'Still running or not reported'}</dd><dt>Expires</dt><dd>${agent?.expiresAt ? time(agent.expiresAt) : 'Not reported'}</dd><dt>Terminal reason</dt><dd>${escape(agent?.terminalReason ?? 'Not reported')}</dd><dt>Outcome</dt><dd>${agent?.outcomeUnknown === true ? 'Unknown — no terminal state was recorded' : 'Reported'}</dd><dt>Allowed proxy operations</dt><dd>${Array.isArray(agent?.proxyOperations) && agent.proxyOperations.length ? agent.proxyOperations.map((operation) => escape(operation)).join(', ') : 'Not reported'}</dd></dl></section>`;
  const usagePanel = `<section class="panel" aria-labelledby="agent-usage-heading"><h2 id="agent-usage-heading">Usage</h2><dl class="facts"><dt>Input tokens</dt><dd>${escape(countOf(usage.inputTokens))} of ${escape(countOf(budget.maxInputTokens))} (${escape(percentOf(usage.inputTokens, budget.maxInputTokens))})</dd><dt>Output tokens</dt><dd>${escape(countOf(usage.outputTokens))} of ${escape(countOf(budget.maxOutputTokens))} (${escape(percentOf(usage.outputTokens, budget.maxOutputTokens))})</dd><dt>Cost</dt><dd>${escape(costOf(usage.costMicros))} of ${escape(costOf(budget.maxCostMicros))} (${escape(percentOf(usage.costMicros, budget.maxCostMicros))})</dd><dt>Output bytes</dt><dd>${escape(countOf(usage.outputBytes))} of ${escape(countOf(budget.maxOutputBytes))}</dd><dt>Tool time</dt><dd>${escape(countOf(usage.toolTimeMs))} ms</dd><dt>Wall time</dt><dd>${escape(countOf(usage.wallTimeMs))} ms</dd><dt>Events</dt><dd>${escape(countOf(usage.eventCount))}</dd></dl><p class="page-note">Usage is the runner's reported counters; a limit that was never configured reads as “Not reported”.</p></section>`;
  const logsPanel = `<section class="panel" aria-labelledby="agent-logs-heading"><h2 id="agent-logs-heading">Logs</h2><p class="page-note">Bounded and redacted: large events are truncated before they reach this page.</p><ul class="agent-log-list">${logRows}</ul></section>`;
  const messagesPanel = `<section class="panel" aria-labelledby="agent-messages-heading"><h2 id="agent-messages-heading">Messages</h2><form id="agent-message-form" class="stack-form"><label for="agent-message-mode">Delivery</label><select id="agent-message-mode" name="mode"><option value="steer" selected>Steer the running agent</option><option value="followUp">Queue a follow-up</option></select><label for="agent-message-text">Message</label><textarea id="agent-message-text" name="message" rows="3" required maxlength="65536"></textarea><div class="form-row-actions"><button type="submit" class="accent-btn">Send message</button><button id="cancel-agent" class="danger" type="button">Cancel agent</button></div><p class="form-status" aria-live="polite"></p></form></section>`;
  return `${overview}${usagePanel}${logsPanel}${messagesPanel}`;
}

const TASK_STATUS_LABELS = {
  queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', timedOut: 'Timed out'
};

/** Task state is text plus a semantic class; colour is never the only signal. */
export function taskStatusLabel(status) {
  return (status && TASK_STATUS_LABELS[status]) ?? 'Unknown';
}

/** Duration from the task's own timestamps; a running task measures against now. */
export function taskDuration(task = {}, now = Date.now()) {
  // `Number(null)` is 0, which would read as "finished at the epoch", so absent
  // timestamps are treated as absent before any coercion.
  const start = task.startedAt === null || task.startedAt === undefined ? Number.NaN : Number(task.startedAt);
  if (!Number.isFinite(start)) return 'Not started';
  const finished = task.finishedAt === null || task.finishedAt === undefined ? Number.NaN : Number(task.finishedAt);
  const end = Number.isFinite(finished) ? finished : now;
  const ms = Math.max(0, end - start);
  return ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timedOut']);

/**
 * The task table: outcome, duration, exit code, dependencies and bounded output, with
 * a cancel control for every task that can still be stopped.
 */
export function renderTaskList(tasks = [], now = Date.now()) {
  const rows = tasks.length ? tasks.map((task) => {
    const status = String(task.status ?? 'unknown');
    const dependencyText = Array.isArray(task.dependsOn) && task.dependsOn.length ? task.dependsOn.map((id) => escape(String(id))).join(', ') : '—';
    const outputText = typeof task.output === 'string' && task.output.trim() ? escape(task.output) : 'No output reported';
    const cancel = TERMINAL_TASK_STATES.has(status) ? '' : `<button class="danger cancel-task" type="button" data-task-id="${escape(String(task.id ?? ''))}">Cancel</button>`;
    return `<tr><th scope="row">${escape(String(task.name ?? task.id ?? 'task'))}<small class="mono wrap">${escape(String(task.id ?? ''))}</small></th><td><span class="status ${escape(status.toLowerCase())}">${escape(taskStatusLabel(status))}</span></td><td>${escape(taskDuration(task, now))}</td><td>${task.exitCode === undefined || task.exitCode === null ? '—' : escape(String(task.exitCode))}</td><td class="mono wrap">${dependencyText}</td><td><details class="row-edit"><summary>Output</summary><pre class="mono">${outputText}</pre></details></td><td>${cancel}</td></tr>`;
  }).join('') : '<tr><td colspan="7">No tasks have run in this workspace yet.</td></tr>';
  return `<div class="desktop-table"><table><caption>${tasks.length} task(s)</caption><thead><tr><th>Task</th><th>Status</th><th>Duration</th><th>Exit</th><th>Depends on</th><th>Output</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * Lay the graph out by dependency depth. Cycle-guarded: a malformed graph cannot hang
 * the layout, and an edge to an unknown node is simply not drawn.
 */
export function taskGraphLayout(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const known = new Set(nodes.map((node) => String(node.id)));
  const depth = new Map();
  const depthOf = (id, seen = new Set()) => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = edges.filter((edge) => edge.to === id && edge.from && known.has(edge.from)).map((edge) => String(edge.from));
    const value = parents.length ? Math.max(...parents.map((parent) => depthOf(parent, seen) + 1)) : 0;
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) depthOf(String(node.id));
  const layers = [];
  for (const node of nodes) {
    const level = depth.get(String(node.id)) ?? 0;
    if (!layers[level]) layers[level] = [];
    layers[level].push(node);
  }
  const positions = new Map();
  layers.forEach((layer, level) => layer.forEach((node, index) => positions.set(String(node.id), { x: 20 + level * 240, y: 20 + index * 92 })));
  const tallest = Math.max(1, ...layers.map((layer) => layer.length));
  return { layers, positions, edges, nodes, width: Math.max(340, layers.length * 240 + 20), height: Math.max(120, tallest * 92 + 20) };
}

/**
 * Internal SVG for the task DAG. Each node carries its state as text and a semantic
 * class, is focusable so its full description is reachable from the keyboard, and the
 * caller renders the task table beside it as the text fallback.
 */
export function renderTaskGraph(graph = {}, now = Date.now()) {
  const { positions, width, height, edges, nodes } = taskGraphLayout(graph);
  if (!nodes.length) return '<p class="empty-note">No tasks have run in this workspace yet.</p>';
  const lines = edges.map((edge) => {
    const from = positions.get(String(edge.from)); const to = positions.get(String(edge.to));
    if (!from || !to) return '';
    return `<line x1="${from.x + 190}" y1="${from.y + 30}" x2="${to.x}" y2="${to.y + 30}" class="task-edge" aria-hidden="true"/>`;
  }).join('');
  const boxes = nodes.map((node) => {
    const spot = positions.get(String(node.id));
    const status = String(node.status ?? 'unknown').toLowerCase();
    const label = `${String(node.name ?? node.id)}: ${taskStatusLabel(status)}, ${taskDuration(node, now)}, exit ${node.exitCode ?? 'none'}`;
    return `<g class="task-node task-${escape(status)}" transform="translate(${spot?.x ?? 0},${spot?.y ?? 0})" tabindex="0" role="listitem" aria-label="${escape(label)}"><rect width="190" height="60" rx="6"/><text class="task-node-name" x="10" y="24">${escape(String(node.name ?? node.id))}</text><text class="task-node-state" x="10" y="44">${escape(taskStatusLabel(status))} · ${escape(taskDuration(node, now))}</text></g>`;
  }).join('');
  return `<figure class="task-graph-figure"><svg class="task-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="list" aria-label="Task dependency graph">${lines}${boxes}</svg><figcaption>Node state is written in each node; the task table below carries the same facts.</figcaption></figure>`;
}

/**
 * Sessions: named, closeable, and readable only through a bounded, read-only view.
 * The dashboard never sends input to a session, so this cannot become a terminal.
 */
export function renderSessionsPanel({ sessions = [], io } = {}) {
  const rows = sessions.length ? sessions.map((session) => {
    const status = String(session.status ?? 'unknown');
    const closed = status === 'closed';
    return `<li class="panel session-row"><div class="record-heading"><div><h3>${escape(String(session.name ?? session.id))}</h3><p>${renderCopyChip({ value: String(session.id ?? ''), label: 'Session ID' })}</p></div><span class="status ${escape(status.toLowerCase())}">${escape(status)}</span></div><div class="row-actions"><button class="read-session" type="button" data-session-id="${escape(String(session.id ?? ''))}">Read output</button><button class="danger close-session" type="button" data-session-id="${escape(String(session.id ?? ''))}"${closed ? ' disabled' : ''}>Close session</button></div></li>`;
  }).join('') : '<li class="empty">No sessions are open in this workspace.</li>';
  const ioPanel = io ? `<section class="panel" aria-labelledby="session-io-heading"><h2 id="session-io-heading">Session output</h2><p class="page-note"><strong>Read-only and bounded.</strong> The dashboard never sends input to a session.</p><pre id="session-io-output" class="mono">${escape(String(io.output ?? 'No output yet.'))}</pre>${io.truncated === true ? '<p class="status-message" role="status">Output is truncated. Read again with the returned cursor for the next slice.</p>' : ''}</section>` : '';
  const dialog = renderFormDialog({
    id: 'open-session-dialog', title: 'Open coding session',
    description: 'Sessions are named and bounded; close one when you are done with it.',
    formId: 'open-session-form', submitId: 'open-session-submit', submitLabel: 'Open session',
    body: '<label for="session-name">Session name</label><input id="session-name" name="name" required maxlength="80"><label for="session-cwd">Working directory</label><input id="session-cwd" name="cwd" value="." maxlength="1024">'
  });
  return `<section class="panel" aria-labelledby="sessions-heading"><h2 id="sessions-heading">Sessions</h2><div class="row-actions"><button id="open-session" class="accent-btn" type="button" data-dialog="open-session-dialog">Open session</button></div><ul class="record-list">${rows}</ul></section>${ioPanel}${dialog}`;
}

/** The cockpit Runtime tab: tasks, the dependency graph, and sessions. */
export function renderRuntimePanel({ tasks = [], graph = {}, sessions = [], io } = {}, now = Date.now()) {
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Live workspace runtime.</strong> Tasks and sessions are volatile: they disappear when the workspace is reaped, unlike retained artifacts.</div>',
    body: `<section aria-labelledby="tasks-heading"><h2 id="tasks-heading">Tasks</h2>${renderTaskList(tasks, now)}</section><section aria-labelledby="graph-heading"><h2 id="graph-heading">Task dependency graph</h2>${renderTaskGraph(graph, now)}</section>`
  })}${renderSessionsPanel({ sessions, io })}`;
}

/** Git posture: branch, upstream, ahead/behind, and the index/working-tree summary. */
export function renderGitStatus(status = {}) {
  const entries = Array.isArray(status.entries) ? status.entries : [];
  const rows = entries.length
    ? entries.map((entry) => `<li class="git-entry"><span class="mono git-code">${escape(String(entry.code ?? '??'))}</span><span class="mono wrap">${escape(String(entry.path ?? ''))}</span></li>`).join('')
    : '<li class="empty">No changed files.</li>';
  return `<section class="panel" aria-labelledby="git-status-heading"><h2 id="git-status-heading">Working tree</h2><dl class="facts"><dt>Branch</dt><dd>${escape(String(status.branch ?? 'Not reported'))}</dd><dt>Upstream</dt><dd>${escape(String(status.upstream ?? 'Not reported'))}</dd><dt>Ahead / behind</dt><dd>${escape(String(status.ahead ?? 0))} ahead · ${escape(String(status.behind ?? 0))} behind</dd><dt>Staged</dt><dd>${escape(String(status.staged ?? 0))}</dd><dt>Modified</dt><dd>${escape(String(status.modified ?? 0))}</dd><dt>Untracked</dt><dd>${escape(String(status.untracked ?? 0))}</dd></dl><h3>File changes</h3><ul class="record-list git-entry-list">${rows}</ul></section>`;
}

/** The diff view: bounded, escaped, and explicit about truncation. */
export function renderGitDiff({ staged = false, diff, truncated } = {}) {
  return `<section class="panel" aria-labelledby="git-diff-heading"><h2 id="git-diff-heading">${staged ? 'Staged diff' : 'Unstaged diff'}</h2><div class="row-actions"><button class="git-diff-toggle" type="button" data-staged="${staged ? 'true' : 'false'}">Show ${staged ? 'unstaged' : 'staged'} diff</button></div><pre id="git-diff-output" class="mono">${diff ? escape(diff) : 'No diff to show.'}</pre>${truncated === true ? '<p class="status-message" role="status">Diff is truncated. Narrow it with a path filter before trusting the whole change set.</p>' : ''}</section>`;
}

export function renderGitLog(commits = []) {
  const rows = commits.length
    ? commits.map((commit) => `<li class="panel"><div class="record-heading"><strong>${escape(String(commit.subject ?? commit.message ?? 'Commit'))}</strong><span class="mono">${escape(String(commit.oid ?? commit.sha ?? '').slice(0, 12))}</span></div><p>${escape(String(commit.author ?? 'Unknown author'))}${commit.authoredAt || commit.date ? ` · ${time(commit.authoredAt ?? commit.date)}` : ''}</p></li>`).join('')
    : '<li class="empty">No commits reported.</li>';
  return `<section class="panel" aria-labelledby="git-log-heading"><h2 id="git-log-heading">Recent commits</h2><ul class="record-list">${rows}</ul></section>`;
}

/** Worktrees are an advanced surface, so they stay collapsed with their own create form. */
export function renderWorktrees(worktrees = []) {
  const rows = worktrees.length
    ? worktrees.map((tree) => `<li class="worktree-row"><span class="mono wrap">${escape(String(tree.path ?? ''))}</span><span class="mono">${escape(String(tree.head ?? '').slice(0, 12))}</span><span>${escape(String(tree.branch ?? 'detached'))}</span><button class="danger remove-worktree" type="button" data-worktree-name="${escape(String(tree.path ?? '').split('/').pop() ?? '')}">Remove</button></li>`).join('')
    : '<li class="empty">No managed worktrees.</li>';
  return `<details class="row-edit"><summary>Worktrees</summary><ul class="record-list worktree-list">${rows}</ul><form id="create-worktree-form" class="stack-form"><label for="worktree-name">Name</label><input id="worktree-name" name="name" required pattern="[A-Za-z0-9._-]{1,80}"><label for="worktree-ref">Ref</label><input id="worktree-ref" name="ref" required maxlength="255"><button type="submit">Create worktree</button><p class="form-status" aria-live="polite"></p></form></details>`;
}

/**
 * Advanced Git operations, collapsed. Finalize is the happy path; these exist for the
 * operator who needs them, and a conflict reports back through the same status line.
 */
export function renderGitAdvanced() {
  return `<details class="row-edit"><summary>Advanced Git operations</summary><form id="git-advanced-form" class="stack-form"><label for="git-action">Action</label><select id="git-action" name="action"><option value="fetch">Fetch from origin</option><option value="pull">Pull (fast-forward only)</option><option value="checkout">Checkout a ref</option><option value="branch">Create a branch</option><option value="merge">Merge a ref</option><option value="rebase">Start a rebase</option></select><label for="git-argument">Ref (checkout, branch, merge, rebase)</label><input id="git-argument" name="argument" maxlength="255"><div class="form-row-actions"><button type="submit">Run Git operation</button></div><p class="form-status" aria-live="polite"></p></form><p class="page-note">Conflicts are reported here and never resolved automatically. Finalize remains the recommended path.</p></details>`;
}

/** The cockpit Git tab: status, diff, log, worktrees, and the collapsed advanced set. */
export function renderGitPanel({ status = {}, diff = {}, log = [], worktrees = [] } = {}) {
  return renderResourcePage({
    note: '<div class="page-note"><strong>Workspace Git.</strong> Finalize stages, commits and pushes in one confirmed step. Advanced operations stay collapsed until you need them.</div>',
    body: `${renderGitStatus(status)}${renderGitDiff(diff)}${renderGitLog(log)}${renderWorktrees(worktrees)}${renderGitAdvanced()}`
  });
}

/** The lifecycle events hooks can run on, in pipeline order. */
export const HOOK_LIFECYCLE = [
  { id: 'on_workspace_open', label: 'On workspace open' },
  { id: 'post_checkout', label: 'After checkout' },
  { id: 'pre_commit', label: 'Before commit' },
  { id: 'post_commit', label: 'After commit' },
  { id: 'manual', label: 'Manual' }
];

/** Hooks grouped by the lifecycle event that runs them. */
export function groupHooksByLifecycle(hooks = []) {
  return HOOK_LIFECYCLE.map((event) => ({
    id: event.id,
    label: event.label,
    hooks: hooks.filter((hook) => (Array.isArray(hook.events) ? hook.events.includes(event.id) : hook.event === event.id))
  }));
}

/**
 * The lifecycle pipeline as an ordered list of stages with their hook counts. It is
 * text-first on purpose: the same facts are readable without colour or connectors.
 */
export function renderHookPipeline(groups = []) {
  const stages = groups.map((group) => `<li class="pipeline-stage${group.hooks.length ? ' has-hooks' : ''}"><span class="pipeline-label">${escape(group.label)}</span><span class="pipeline-count">${escape(String(group.hooks.length))} hook(s)</span></li>`).join('');
  return `<ol class="hook-pipeline" aria-label="Hook lifecycle in run order">${stages}</ol>`;
}

/** Hooks, grouped by lifecycle, with the retained text list beside the pipeline. */
export function renderHooks(hooks = []) {
  const groups = groupHooksByLifecycle(hooks);
  const lists = groups.map((group) => {
    const rows = group.hooks.length
      ? `<ul class="record-list">${group.hooks.map((hook) => `<li><strong>${escape(String(hook.name ?? hook.path ?? 'hook'))}</strong> <span class="status${hook.active === false ? '' : ' active'}">${hook.active === false ? 'Inactive' : 'Active'}</span>${hook.description ? `<p>${escape(String(hook.description))}</p>` : ''}</li>`).join('')}</ul>`
      : '<p class="empty-note">No hooks run at this stage.</p>';
    return `<section aria-labelledby="hooks-${escape(group.id)}"><h3 id="hooks-${escape(group.id)}">${escape(group.label)}</h3>${rows}</section>`;
  }).join('');
  const options = HOOK_LIFECYCLE.map((event) => `<option value="${escape(event.id)}">${escape(event.label)}</option>`).join('');
  return `<section class="panel" aria-labelledby="hooks-heading"><h2 id="hooks-heading">Hooks</h2>${renderHookPipeline(groups)}${lists}<form id="hook-run-form" class="stack-form"><label for="hook-event">Run the hooks for this event</label><select id="hook-event" name="event">${options}</select><button type="submit">Run hooks</button><p class="form-status" aria-live="polite"></p></form><p class="page-note">Activation and deactivation stay with the runner's manifest contract; this page runs only what is already active.</p></section>`;
}

/** The workspace skill set, with a guarded run form for an explicitly named script. */
export function renderWorkspaceSkills(skills = []) {
  const rows = skills.length
    ? `<ul class="record-list">${skills.map((skill) => `<li><strong>${escape(String(skill.name ?? 'skill'))}</strong>${skill.tier ? ` <span class="status">${escape(String(skill.tier))}</span>` : ''}${skill.description ? `<p>${escape(String(skill.description))}</p>` : ''}${skill.sha256 ? `<small class="mono wrap">${escape(String(skill.sha256).slice(0, 16))}</small>` : ''}</li>`).join('')}</ul>`
    : '<p class="empty-note">No skills are resolved for this workspace.</p>';
  return `<section class="panel" aria-labelledby="skills-heading"><h2 id="skills-heading">Skills</h2>${rows}<details class="row-edit"><summary>Run a skill script</summary><p class="page-note">A script runs inside the workspace executor under the runner's verified-bytes contract. Nothing runs unless you name it here.</p><form id="skill-run-form" class="stack-form"><label for="skill-run-name">Skill</label><input id="skill-run-name" name="name" required maxlength="120"><label for="skill-run-script">Script path</label><input id="skill-run-script" name="script" required maxlength="255"><button type="submit">Run script</button><p class="form-status" aria-live="polite"></p></form></details></section>`;
}

/** Deploy targets: external-effect risk, so every run confirms and every failure shows. */
export function renderDeployPanel(deployments = []) {
  const rows = deployments.length
    ? deployments.map((target) => `<li class="panel deploy-target"><div class="record-heading"><div><h3>${escape(String(target.name ?? 'target'))}</h3><p class="mono wrap">${escape(String(target.cwd ?? ''))}</p></div><button class="accent-btn run-deployment" type="button" data-deployment-name="${escape(String(target.name ?? ''))}">Run deployment</button></div><dl class="facts"><dt>Last result</dt><dd>${escape(String(target.lastResult ?? target.status ?? 'Not reported'))}</dd><dt>Duration</dt><dd>${Number.isFinite(Number(target.durationMs)) ? `${escape(String(target.durationMs))} ms` : 'Not reported'}</dd><dt>Failure detail</dt><dd>${target.error ? escape(String(target.error)) : 'None reported'}</dd></dl></li>`).join('')
    : '<li class="empty">No deployment targets are defined for this repository.</li>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Deployments run repository-defined commands.</strong> They are external-effect operations: each run confirms first and reports its exit status here.</div>',
    body: `<section aria-labelledby="deploy-heading"><h2 id="deploy-heading">Deployment targets</h2><ul class="record-list">${rows}</ul></section>`
  })}`;
}

/** The cockpit Automation tab: the workspace skill set and its hooks. */
export function renderAutomationPanel({ skills = [], hooks = [] } = {}) {
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Workspace automation.</strong> Skills resolve from your library and pinned sets; hooks run at lifecycle events inside the executor.</div>',
    body: `${renderWorkspaceSkills(skills)}${renderHooks(hooks)}`
  })}`;
}

/** The Activity Center's shared event grammar and its filters. */
export const ACTIVITY_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'agents', label: 'Agents' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'mcp', label: 'MCP' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'audit', label: 'Audit' }
];

/**
 * One event grammar for every source: when it happened, which category, its status,
 * the actor or resource, a short summary and where to look next. `durable` marks the
 * events that are retained audit records rather than live runtime data, so the UI can
 * never imply that a running task is a durable history entry.
 */
export function activityEvent({ at, category, status, actor, summary, href, durable = false }) {
  return { at, category, status, actor, summary, href, durable };
}

/** One activity row. The Activity Center and the cockpit's Activity tab share it, so a
 * live runtime row and a retained audit row look the same wherever they appear. */
function activityRow(event) {
  return `<li class="activity-event"><div class="record-heading"><span class="mono">${event.at ? time(event.at) : 'Time not reported'}</span><span class="status ${escape(String(event.status ?? 'unknown').toLowerCase())}">${escape(String(event.status ?? 'unknown'))}</span></div><p><strong>${escape(String(event.summary ?? event.category))}</strong></p><p class="activity-meta">${escape(String(event.category))} · ${escape(String(event.actor ?? 'Not reported'))} ${event.durable ? '<span class="status active">Retained audit</span>' : '<span class="status">Live runtime</span>'}</p>${event.href ? `<a href="${escape(String(event.href))}">Open</a>` : ''}</li>`;
}

export function renderActivityCenter({ events = [], filter = 'all' } = {}) {
  const tabs = ACTIVITY_FILTERS.map((entry) => `<a href="/dashboard/activity${entry.id === 'all' ? '' : `?filter=${entry.id}`}" ${entry.id === filter ? 'aria-current="page"' : ''}>${escape(entry.label)}${entry.id === 'all' ? '' : ` (${escape(String(events.filter((event) => event.category === entry.id).length))})`}</a>`).join('');
  const visible = filter === 'all' ? events : events.filter((event) => event.category === filter);
  const rows = visible.length
    ? visible.map(activityRow).join('')
    : '<li class="empty">No events in this view yet.</li>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Operational activity.</strong> Runtime categories are live and disappear with their workspace; audit rows are retained and redacted. The panel labels each row, so the two are never confused.</div>',
    filters: `<nav class="activity-filters" aria-label="Activity filters">${tabs}</nav>`,
    body: `<section aria-labelledby="activity-heading"><h2 id="activity-heading">Events</h2><ul class="activity-list activity-center">${rows}</ul></section>`
  })}`;
}

/** Pending privilege grants as an inbox: context, requested capability, decision. */
export function renderApprovals({ grants = [] } = {}) {
  const rows = grants.length
    ? grants.map((grant) => {
      const id = String(grant.id ?? '');
      return `<li class="panel approval-row"><div class="record-heading"><div><h3>${escape(String(grant.command ?? 'Requested operation'))}</h3><p class="mono wrap">${escape(String(grant.workspaceId ?? 'Workspace not reported'))}</p></div><span class="status reaping">Pending</span></div><dl class="facts"><dt>Requested</dt><dd>${grant.createdAt ? time(grant.createdAt) : 'Not reported'}</dd><dt>Expires</dt><dd>${grant.expiresAt ? time(grant.expiresAt) : 'Not reported'}</dd><dt>Working directory</dt><dd class="mono wrap">${escape(String(grant.cwd ?? 'Not reported'))}</dd><dt>Command digest</dt><dd class="mono wrap">${escape(String(grant.commandSha256 ?? 'Not reported'))}</dd></dl><div class="row-actions"><button class="accent-btn approve-grant" type="button" data-grant-id="${escape(id)}">Approve</button><button class="danger reject-grant" type="button" data-grant-id="${escape(id)}">Reject</button></div></li>`;
    }).join('')
    : '<li class="empty"><h3>No approvals are waiting.</h3><p>Privilege requests appear here while they are pending and leave once you decide.</p></li>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Privilege grants.</strong> Approving lets one command run in a workspace under your identity. Both decisions are audited.</div>',
    body: `<section aria-labelledby="approvals-heading"><h2 id="approvals-heading">Pending requests</h2><ul class="record-list approval-list">${rows}</ul></section>`
  })}`;
}

/**
 * Chart primitives. Internal SVG only: no external dependency, no gradient and no inline
 * style (the geometry carries the value, the classes carry the colour), every mark is
 * focusable with its numbers in the accessible name, and the same numbers are always
 * available as a table beside the figure.
 */
export function renderBarChart({ label, unit = '', points = [], emptyNote = 'Nothing to chart yet.' }) {
  if (!points.length) return `<p class="empty-note">${escape(emptyNote)}</p>`;
  const values = points.map((point) => Number(point.value) || 0);
  const ceiling = Math.max(1, ...values);
  const width = Math.max(240, points.length * 28 + 12);
  const height = 140;
  const bars = points.map((point, index) => {
    const value = Number(point.value) || 0;
    const barHeight = Math.round((value / ceiling) * (height - 34));
    const x = index * 28 + 6;
    return `<g class="chart-bar" tabindex="0" role="listitem" aria-label="${escape(`${point.label}: ${value}${unit}`)}"><title>${escape(`${point.label}: ${value}${unit}`)}</title><rect x="${x}" y="${height - 22 - barHeight}" width="18" height="${Math.max(barHeight, 1)}" rx="2"/><text x="${x + 9}" y="${height - 8}" text-anchor="middle" class="chart-tick">${escape(String(point.tick ?? ''))}</text></g>`;
  }).join('');
  return renderChartFigure({ label, legend: 'Item', unit, points, svg: bars, width, height, className: 'chart-bars' });
}

/** Horizontal bars: the same primitive for values that read better as rows. */
export function renderBarRows({ label, unit = '', points = [], emptyNote = 'Nothing to chart yet.' }) {
  if (!points.length) return `<p class="empty-note">${escape(emptyNote)}</p>`;
  const ceiling = Math.max(1, ...points.map((point) => Number(point.value) || 0));
  const rows = points.map((point, index) => {
    const value = Number(point.value) || 0;
    const barWidth = Math.round((value / ceiling) * 200);
    const y = index * 30;
    const note = point.note ? `, ${point.note}` : '';
    return `<g class="chart-bar" tabindex="0" role="listitem" aria-label="${escape(`${point.label}: ${value}${unit}${note}`)}"><text x="0" y="${y + 14}" class="bar-label">${escape(String(point.label))}</text><rect x="150" y="${y + 3}" width="${Math.max(barWidth, 1)}" height="12" rx="2" class="bar-fill"/><text x="360" y="${y + 14}" class="bar-value">${escape(String(value))}${escape(unit)}</text></g>`;
  }).join('');
  return renderChartFigure({ label, legend: 'Item', unit, points, svg: rows, width: 420, height: points.length * 30, className: 'chart-rows' });
}

function renderChartFigure({ label, legend, unit, points, svg, width, height, className }) {
  const columns = points.some((point) => point.note) ? `<th>Note</th>` : '';
  const rows = points.map((point) => `<tr><th scope="row">${escape(String(point.label))}</th><td>${escape(String(point.value ?? 0))}${escape(unit)}</td>${point.note ? `<td>${escape(String(point.note))}</td>` : ''}</tr>`).join('');
  return `<figure class="chart-figure"><figcaption>${escape(label)}</figcaption><svg class="chart ${escape(className)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="list" aria-label="${escape(label)}">${svg}</svg><details class="chart-data"><summary>Show numbers</summary><table class="chart-fallback"><caption>${escape(label)} (numbers)</caption><thead><tr><th>${escape(legend)}</th><th>Value</th>${columns}</tr></thead><tbody>${rows}</tbody></table></details></figure>`;
}

/**
 * Stacked bars for a series with categories per bucket (an execution-health timeline).
 * Each bar is focusable and its accessible name spells out every category count, the
 * categories are named in a legend and by class, and the table below carries the same
 * numbers — so nothing is conveyed by colour or height alone.
 */
export function renderStackedBars({ label, categories = [], points = [], emptyNote = 'Nothing to chart yet.' }) {
  if (!points.length) return `<p class="empty-note">${escape(emptyNote)}</p>`;
  const totals = points.map((point) => categories.reduce((sum, category) => sum + (Number(point.segments?.[category.key]) || 0), 0));
  const ceiling = Math.max(1, ...totals);
  const width = Math.max(240, points.length * 34 + 12);
  const height = 150;
  const bars = points.map((point, index) => {
    let y = height - 22;
    const segments = categories.map((category) => {
      const value = Number(point.segments?.[category.key]) || 0;
      const segmentHeight = Math.round((value / ceiling) * (height - 44));
      if (segmentHeight <= 0) return '';
      y -= segmentHeight;
      return `<rect x="${index * 34 + 6}" y="${y}" width="22" height="${segmentHeight}" class="bar-segment segment-${escape(category.key)}"/>`;
    }).join('');
    const description = `${point.label}: ${categories.map((category) => `${category.label} ${Number(point.segments?.[category.key]) || 0}`).join(', ')}`;
    return `<g class="chart-bar" tabindex="0" role="listitem" aria-label="${escape(description)}">${segments}<text x="${index * 34 + 17}" y="${height - 8}" text-anchor="middle" class="chart-tick">${escape(String(point.tick ?? ''))}</text></g>`;
  }).join('');
  const legend = `<ul class="chart-legend">${categories.map((category) => `<li><span class="legend-swatch legend-${escape(category.key)}" aria-hidden="true"></span>${escape(category.label)}</li>`).join('')}</ul>`;
  const header = categories.map((category) => `<th>${escape(category.label)}</th>`).join('');
  const rows = points.map((point) => `<tr><th scope="row">${escape(String(point.label))}</th>${categories.map((category) => `<td>${escape(String(Number(point.segments?.[category.key]) || 0))}</td>`).join('')}</tr>`).join('');
  return `<figure class="chart-figure"><figcaption>${escape(label)}</figcaption>${legend}<svg class="chart chart-stacked" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="list" aria-label="${escape(label)}">${bars}</svg><details class="chart-data"><summary>Show numbers</summary><table class="chart-fallback"><caption>${escape(label)} (numbers)</caption><thead><tr><th>Bucket</th>${header}</tr></thead><tbody>${rows}</tbody></table></details></figure>`;
}

/**
 * The analytics section. Every chart states the scope it measured; the two series charts
 * cover the *retained agent window* rather than pretending to be a longer history, and no
 * chart is drawn for data the harness does not keep.
 */
export function renderAnalyticsSection({ overview = {}, metrics = {}, reliability = {} } = {}) {
  const series = Array.isArray(metrics.series) ? metrics.series : [];
  const activity = series.map((point) => ({ label: new Date(point.at).toLocaleTimeString(), tick: '', value: point.count }));
  const outcomes = Array.isArray(overview.agentOutcomes) ? overview.agentOutcomes : [];
  const costSeries = Array.isArray(overview.costSeries) ? overview.costSeries.map((point) => ({ ...point, value: Number(point.value) || 0 })) : [];
  const scope = String(overview.agentSeriesScope ?? 'retained agents');
  const profiles = (overview.usageByProfile ?? []).map((entry) => ({ label: String(entry.profileId ?? 'unprofiled'), value: (Number(entry.costMicros) || 0) / 1_000_000, note: `${Number(entry.inputTokens) || 0} in · ${Number(entry.outputTokens) || 0} out tokens` }));
  const burn = (overview.budgetBurn ?? []).map((entry) => {
    const used = Number(entry.costMicros) || 0;
    const max = Number(entry.maxCostMicros) || 0;
    const percent = max > 0 ? Math.round((used / max) * 100) : undefined;
    return { label: String(entry.agentId ?? '').slice(0, 18), value: used / 1_000_000, note: percent === undefined ? 'cost limit not reported' : `${percent}% of cost limit` };
  });
  const expiry = (overview.expiring ?? []).map((bucket) => ({ label: String(bucket.label ?? ''), value: Number(bucket.count) || 0, note: 'workspaces' }));
  const servers = (reliability.servers ?? []).map((server) => ({ label: String(server.serverName ?? server.serverId ?? 'server'), value: Number(server.calls) || 0, note: `${Number(server.error) || 0} error(s), p50 ${server.p50Ms ?? '—'} ms, p95 ${server.p95Ms ?? '—'} ms` }));
  return `<section class="panel analytics" aria-labelledby="analytics-heading"><h2 id="analytics-heading">Analytics</h2><p class="page-note">Each chart states the scope it measured. Execution health and cost cover the <strong>${escape(scope)}</strong>, because the harness keeps agent state and per-agent usage rather than a dated outcome or billing ledger.</p><div class="analytics-grid">${renderBarChart({ label: `Retained audit events per bucket (${String(metrics.window ?? 'window')})`, points: activity, emptyNote: 'No retained events in this window.' })}${renderStackedBars({ label: `Execution health over retained agents (${scope})`, categories: [{ key: 'succeeded', label: 'Succeeded' }, { key: 'attention', label: 'Failed / limit' }, { key: 'cancelled', label: 'Cancelled' }, { key: 'running', label: 'Running' }], points: outcomes, emptyNote: 'No agents are on record yet.' })}${renderBarChart({ label: `Cost over retained agents (${scope})`, unit: ' USD', points: costSeries, emptyNote: 'No agent usage is on record yet.' })}${renderBarRows({ label: 'Cost by model profile', unit: ' USD', points: profiles, emptyNote: 'No agent usage reported yet.' })}${renderBarRows({ label: 'Budget burn of running agents', unit: '', points: burn, emptyNote: 'No running agents report a budget.' })}${renderBarRows({ label: 'Workspace expiry buckets', points: expiry, emptyNote: 'No workspaces are close to expiry.' })}${renderBarRows({ label: 'MCP reliability by server', points: servers, emptyNote: 'No gateway traces reported yet.' })}</div></section>`;
}

export function renderWorkspaceDetail(workspace, dedicated = false, modal = false) {
  const heading = dedicated ? 'h1' : 'h2';
  const warning = workspace.networkProfile === 'dependency-access' ? '<p class="warning">Executor network access is enabled for this workspace (public DNS/HTTP/HTTPS).</p>' : '';
  const close = modal ? '<button id="close-detail" class="drawer-close" type="button">Close workspace details</button>' : '';
  return `${close}<${heading} id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</${heading}><p class="mono wrap">${escape(workspace.workspaceId)}</p><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span><ol class="lifecycle" aria-label="Workspace lifecycle"><li><strong>Created</strong>${time(workspace.createdAt)}</li><li><strong>Last activity</strong>${time(workspace.lastActivityAt)}</li><li><strong>Expires</strong>${time(workspace.expiresAt)}</li></ol><dl class="facts"><dt>Repository</dt><dd class="wrap">${escape(workspace.repositoryUrl)}</dd><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd><dt>Network</dt><dd>${networkLabel(workspace.networkProfile)}</dd></dl>${warning}<nav class="detail-actions" aria-label="Workspace sections"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/files">Files</a><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/runtime">Runtime</a></nav><div class="danger-zone"><button id="close-workspace" class="danger" type="button" ${workspace.version ? '' : 'disabled'}>Close workspace</button>${workspace.version ? '' : '<p>Close is unavailable until lifecycle fencing is ready.</p>'}</div>`;
}

export function renderProjectIndex(projects) {
  const items = projects.length
    ? `<ul class="card-grid">${projects.map((project) => `<li class="panel"><h3><a href="/dashboard/projects/${encodeURIComponent(project.id)}">${escape(project.name)}</a></h3>${renderCopyChip({ value: project.id, label: 'Project ID' })}<p>Generation ${escape(project.generation)}</p></li>`).join('')}</ul>`
    : '<div class="empty"><h3>No projects yet.</h3><p>Create a project to group retained environment metadata.</p></div>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Retained control-plane metadata.</strong> Projects and environments persist independently from volatile workspace runtime.</div>',
    body: `<section aria-labelledby="project-list-heading"><h2 id="project-list-heading">Projects</h2>${items}</section>`
  })}${renderFormDialog({
    id: 'create-project-dialog', title: 'Create project',
    description: 'Projects group retained environment metadata for your signed-in identity. Nothing starts until you open a workspace.',
    formId: 'create-project-form', submitId: 'create-project-submit', submitLabel: 'Create project',
    body: '<label for="project-name">Project name</label><input id="project-name" name="name" required maxlength="100">'
  })}`;
}

export function renderProjectDetail(project, environments) {
  const environmentItems = environments.length ? environments.map((environment) => {
    const secrets = Array.isArray(environment.secrets) ? environment.secrets : [];
    const secretRows = secrets.length ? secrets.map((secret) => {
      const descHtml = secret.description ? `<p class="secret-desc">${escape(secret.description)}</p>` : '';
      return `<li class="secret-reference"><div><strong>${escape(secret.name)}</strong>${descHtml}<span class="status">${escape(secret.state ?? 'unknown')}</span><small>Version ${escape(secret.version ?? secret.generation)} · Generation ${escape(secret.generation)}</small></div><form class="update-secret-desc-form inline-form" data-environment-id="${escape(environment.id)}" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>Description<input name="description" value="${escape(secret.description ?? '')}" maxlength="500" autocomplete="off"></label><button type="submit">Save desc</button><p class="form-status" aria-live="polite"></p></form><form class="rotate-secret-form inline-form" data-environment-id="${escape(environment.id)}" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>New write-only value<input name="value" type="password" autocomplete="new-password" data-write-only required></label><button type="submit">Rotate</button><p class="form-status" aria-live="polite"></p></form><button class="danger delete-secret" type="button" data-environment-id="${escape(environment.id)}" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}">Delete secret reference</button></li>`;
    }).join('') : '<li>No secret references.</li>';
    const readiness = environment.readiness?.ready === false ? `<p class="warning">Secret storage unavailable: ${escape(environment.readiness.error ?? 'Review runner readiness.')}</p>` : '';
    return `<li class="panel environment-card"><div class="record-heading"><div><h3>${escape(environment.name)}</h3><p class="mono wrap">${escape(environment.id)}</p></div><div class="row-actions"><button class="open-bulk-import" type="button" data-environment-id="${escape(environment.id)}">Bulk import .env</button><button class="export-env-example" type="button" data-environment-id="${escape(environment.id)}" data-environment-name="${escape(environment.name)}">Export .env.example</button><button class="danger delete-environment" type="button" data-environment-id="${escape(environment.id)}" data-generation="${escape(environment.generation)}">Delete environment</button></div></div>${readiness}<section aria-labelledby="secrets-${escape(environment.id)}"><h4 id="secrets-${escape(environment.id)}">Write-only secret references</h4><p>Values can be submitted or rotated, but are never returned or rendered after submission.</p><ul class="record-list">${secretRows}</ul><form class="create-secret-form stack-form" data-environment-id="${escape(environment.id)}"><label>Secret name<input name="name" required maxlength="100" autocomplete="off"></label><label>Write-only value<input name="value" type="password" required autocomplete="new-password" data-write-only></label><label>Description <span class="optional">Optional</span><input name="description" maxlength="500" autocomplete="off"></label><button type="submit">Create secret reference</button><p class="form-status" aria-live="polite"></p></form></section></li>`;
  }).join('') : '<li class="empty">No environments yet.</li>';
  return `<nav aria-label="Breadcrumb"><a href="/dashboard/projects">Projects</a><span>${escape(project.name)}</span></nav><div class="page-note"><strong>Retained configuration metadata.</strong> Secret values are write-only and never displayed. Workspace task and session state remains volatile.</div><div class="record-heading"><div><h2>${escape(project.name)}</h2><p class="mono wrap">${escape(project.id)}</p></div><button id="delete-project" class="danger" type="button" data-project-id="${escape(project.id)}" data-generation="${escape(project.generation)}">Delete project</button></div><section aria-labelledby="environment-list-heading"><h2 id="environment-list-heading">Environments</h2><ul class="environment-list">${environmentItems}</ul></section><section class="panel"><h2>Create environment</h2><form id="create-environment-form" class="stack-form"><label for="environment-name">Environment name</label><input id="environment-name" name="name" required maxlength="100"><button type="submit">Create environment</button><p class="form-status" aria-live="polite"></p></form></section>`;
}

export function renderGlobalSecrets(secrets = [], readiness = { ready: true }) {
  const secretList = Array.isArray(secrets) ? secrets : [];
  const secretRows = secretList.length ? secretList.map((secret) => {
    const descHtml = secret.description ? `<p class="secret-desc">${escape(secret.description)}</p>` : '';
    return `<li class="secret-reference"><div><strong>${escape(secret.name)}</strong>${descHtml}<span class="status">${escape(secret.state ?? 'unknown')}</span><small>Version ${escape(secret.version ?? secret.generation)} · Generation ${escape(secret.generation)}</small></div><details class="row-edit"><summary>Rotate or edit</summary><form class="update-global-secret-desc-form inline-form" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>Description<input name="description" value="${escape(secret.description ?? '')}" maxlength="500" autocomplete="off"></label><button type="submit">Save desc</button><p class="form-status" aria-live="polite"></p></form><form class="rotate-global-secret-form inline-form" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>New write-only value<input name="value" type="password" autocomplete="new-password" data-write-only required></label><button type="submit">Rotate</button><p class="form-status" aria-live="polite"></p></form></details><button class="danger delete-global-secret" type="button" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}">Delete secret</button></li>`;
  }).join('') : '<li class="empty"><h3>No global secrets yet.</h3><p>Add a secret when a workspace needs a credential that every project can inherit.</p></li>';
  const readinessWarning = readiness?.ready === false ? `<p class="warning">Secret storage unavailable: ${escape(readiness.error ?? 'Review runner readiness.')}</p>` : '';
  return `${renderResourcePage({
    note: `<div class="page-note"><strong>Retained global configuration metadata.</strong> Global secrets are automatically inherited by all newly opened workspaces for your signed-in identity. Environment-specific secrets override global secrets on key collision. Secret rotation and deletion apply to future workspace opens and do not retroactively modify running workspaces. Values are write-only and never displayed.</div>${readinessWarning}`,
    filters: '<div class="row-actions"><button id="open-global-bulk-import" type="button">Bulk import .env</button><button id="export-global-env-example" type="button">Export .env.example</button></div>',
    body: `<section aria-labelledby="global-secrets-heading"><h2 id="global-secrets-heading">Secret references</h2><ul class="record-list">${secretRows}</ul></section>`
  })}${renderFormDialog({
    id: 'create-global-secret-dialog', title: 'Add global secret',
    description: 'The value is write-only: it is encrypted, never returned, and never rendered again after you save it.',
    formId: 'create-global-secret-form', submitId: 'create-global-secret-submit', submitLabel: 'Create global secret',
    body: '<label for="global-secret-name">Secret name</label><input id="global-secret-name" name="name" required maxlength="100" autocomplete="off"><label for="global-secret-value">Write-only value</label><input id="global-secret-value" name="value" type="password" required autocomplete="new-password" data-write-only><label for="global-secret-desc">Description <span class="optional">Optional</span></label><input id="global-secret-desc" name="description" maxlength="500" autocomplete="off">'
  })}`;
}

export function renderArtifactIndex(artifacts, cursor) {
  const rows = artifacts.length ? artifacts.map((artifact) => `<tr><th scope="row">${escape(artifact.logicalName)}<small class="mono wrap">${escape(artifact.artifactId)}</small></th><td>${escape(formatBytes(artifact.sizeBytes))}</td><td class="mono wrap">${escape(artifact.sha256)}</td><td>${time(artifact.expiresAt)}</td><td><a class="secondary button download-artifact" href="/dashboard/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download" download="${escape(artifact.logicalName)}">Download</a> <button class="danger delete-artifact" type="button" data-artifact-id="${escape(artifact.artifactId)}" data-generation="${escape(artifact.generation)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="5">No retained snapshots yet. Create one to keep a bounded copy of a workspace file.</td></tr>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Retained artifact snapshots.</strong> These bounded copies persist until their displayed expiry or deletion. Tasks and sessions are volatile runtime state.</div>',
    body: `<section aria-labelledby="artifact-list-heading"><h2 id="artifact-list-heading">Retained artifacts</h2><div class="desktop-table"><table><caption>${artifacts.length} snapshots</caption><thead><tr><th>Name</th><th>Size</th><th>SHA-256</th><th>Expires</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>${cursor ? `<button id="load-more-artifacts" type="button" data-cursor="${escape(cursor)}">Load more</button>` : ''}</section>`
  })}${renderFormDialog({
    id: 'snapshot-dialog', title: 'Create snapshot',
    description: 'Copy one workspace file into retained, bounded storage. The snapshot expires at the retention you set, or at the server default.',
    formId: 'snapshot-form', submitId: 'snapshot-submit', submitLabel: 'Create retained snapshot',
    body: '<label for="snapshot-workspace">Workspace ID</label><input id="snapshot-workspace" name="workspaceId" required pattern="ws_[A-Za-z0-9_-]{20,80}"><label for="snapshot-path">Workspace path</label><input id="snapshot-path" name="path" required maxlength="1024"><label for="snapshot-name">Logical name</label><input id="snapshot-name" name="logicalName" required maxlength="128"><label for="snapshot-retention">Retention in seconds</label><input id="snapshot-retention" name="retentionSeconds" type="number" min="60" max="2592000" placeholder="Use server default">'
  })}`;
}

export function renderAuditIndex(events, cursor) {
  const items = events.length ? events.map((event) => `<li class="panel"><div class="record-heading"><strong>${escape(event.action)}</strong>${time(event.createdAt)}</div><dl class="facts"><dt>Subject</dt><dd>${escape(event.subjectType)} <span class="mono wrap">${escape(event.subjectId)}</span></dd><dt>Generation</dt><dd>${escape(event.subjectGeneration ?? '—')}</dd></dl><details><summary>Redacted details</summary><pre><code>${escape(JSON.stringify(event.details ?? {}, null, 2))}</code></pre></details></li>`).join('') : '<li class="empty">No retained audit events.</li>';
  return `<div class="page-note"><strong>Retained redacted audit history.</strong> Events exclude secret values, provider credentials, and workspace command output.</div><section aria-labelledby="audit-list-heading"><h2 id="audit-list-heading">Audit events</h2><ul class="audit-list">${items}</ul>${cursor ? `<button id="load-more-audit" type="button" data-cursor="${escape(cursor)}">Load more</button>` : ''}</section>`;
}

export function renderApiKeyIndex(data) {
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  const readiness = data?.readiness ?? { ready: true };
  const activeCount = keys.filter((key) => key?.state === 'ACTIVE').length;
  const publicUrl = readiness.ready === true ? publicMcpUrl(readiness.publicUrl ?? data?.publicUrl) : undefined;
  const readinessNote = readiness.ready === false
    ? '<p class="warning" role="status">API-key connections are not available yet. An operator must finish the dedicated gateway configuration.</p>'
    : publicUrl ? `<p class="page-note"><strong>Static client endpoint</strong> <code class="mono wrap">${escape(publicUrl)}</code></p>` : '';
  const items = keys.length ? keys.map((key) => renderApiKey(key)).join('') : '<li class="empty"><h3>No API keys yet.</h3><p>Create one when a client cannot complete the browser-based OAuth flow.</p></li>';
  const creationDisabled = readiness.ready === false || activeCount >= 10;
  const disabled = creationDisabled ? ' disabled' : '';
  const limitNote = activeCount >= 10 ? '<p class="warning" role="status">The 10-active-key limit is reached. Revoke an active key before creating another.</p>' : '';
  return `${readinessNote}${renderResourcePage({
    body: `<section aria-labelledby="api-key-list-heading"><div class="record-heading"><div><h2 id="api-key-list-heading">API keys</h2><p>${escape(activeCount)} active of 10 · ${escape(keys.length)} total</p></div></div><ul class="record-list api-key-list">${items}</ul></section>`
  })}${renderFormDialog({
    id: 'create-api-key-dialog', title: 'Create API key',
    description: 'The key is shown once and cannot be recovered. It carries full MCP access as your identity, including command execution.',
    formId: 'create-api-key-form', submitId: 'create-api-key-submit', submitLabel: 'Create API key',
    body: `<p class="warning"><strong>Full remote execution authority.</strong> This key grants full MCP access as your identity, including arbitrary command execution. It expires, cannot be recovered, and must be revoked if exposed.</p>${limitNote}<label for="api-key-name">Key name</label><input id="api-key-name" name="name" required maxlength="100" autocomplete="off"${disabled}><label for="api-key-expiry">Expires after (days)</label><input id="api-key-expiry" name="expiryDays" type="number" inputmode="numeric" min="1" max="3650" step="1" value="30" required${disabled}><label class="checkbox-label"><input name="authorityAcknowledged" type="checkbox" required${disabled}><span>I understand this key permits full MCP and command-execution access and will be shown only once.</span></label>`
  })}`;
}

function renderApiKey(key) {
  const keyId = key?.id;
  const generation = Number(key?.generation);
  const state = ['ACTIVE', 'EXPIRED', 'REVOKED'].includes(key?.state) ? key.state : 'UNKNOWN';
  const action = state === 'ACTIVE' && typeof keyId === 'string' && Number.isSafeInteger(generation) && generation > 0
    ? `<button class="danger revoke-api-key" type="button" data-key-id="${escape(keyId)}" data-generation="${escape(generation)}" data-key-name="${escape(key?.name)}">Revoke</button>` : '';
  return `<li class="panel api-key-card"><div class="record-heading"><div><h3>${escape(key?.name)}</h3><p><code class="mono">${escape(key?.displayPrefix)}</code> <span class="status ${state === 'ACTIVE' ? 'active' : state === 'EXPIRED' ? 'expired' : ''}">${escape(stateLabel(state))}</span></p></div>${action}</div><dl class="facts"><dt>Created</dt><dd>${optionalTime(key?.createdAt)}</dd><dt>Expires</dt><dd>${optionalTime(key?.expiresAt)}</dd><dt>Last used</dt><dd>${optionalTime(key?.lastUsedAt)}</dd><dt>Revoked</dt><dd>${optionalTime(key?.revokedAt)}</dd></dl></li>`;
}

function renderInstallationCard(installation) {
  const id = escape(installation.installationId);
  const account = escape(installation.accountLogin ?? installation.accountId);
  const instStatus = escape(installation.status);
  const checked = installation.checkedAt ? time(installation.checkedAt) : 'Not yet reconciled';
  return `<li class="panel installation-card" data-installation-id="${id}"><div class="record-heading"><div><h3>${account}</h3><p><code class="mono">${id}</code> <span class="status ${installation.status === 'active' ? 'active' : ''}">${instStatus}</span></p></div><div class="row-actions"><button class="reconcile-installation" type="button" data-installation-id="${id}">Reconcile</button><button class="danger disconnect-installation" type="button" data-installation-id="${id}" data-account="${account}">Disconnect</button></div></div><dl class="facts"><dt>Account</dt><dd>${account}</dd><dt>Status</dt><dd>${instStatus}</dd><dt>Installation ID</dt><dd class="mono">${id}</dd><dt>Last checked</dt><dd>${checked}</dd></dl></li>`;
}

export function renderGitHub(status, callbackPending = false) {
  const installations = Array.isArray(status?.installations) && status.installations.length
    ? status.installations
    : (status?.installation ? [status.installation] : []);
  const installationView = installations.length
    ? `<ul class="record-list">${installations.map(renderInstallationCard).join('')}</ul>`
    : '<p>No GitHub App installation is bound to this identity.</p>';
  const repositories = status?.repositories?.length ? `<ul class="record-list">${status.repositories.map((repository) => `<li><strong>${escape(repository.owner)}/${escape(repository.repository)}</strong><span>${escape(repository.status)} · Contents ${escape(repository.contents)}${repository.installationId ? ` · ID <code class="mono">${escape(repository.installationId)}</code>` : ''}</span></li>`).join('')}</ul>` : '<p>No authorized repositories reported.</p>';
  const reconcileLabel = installations.length > 1 ? 'Reconcile all installations' : 'Reconcile installation';
  void reconcileLabel;
  return `<div class="page-note"><strong>GitHub App authorization metadata.</strong> Provider private keys and minted tokens remain runner-only and are never rendered.</div>${callbackPending ? '<p class="status-message" role="status">Completing GitHub App connection…</p>' : ''}<section class="panel"><h2>Installation status</h2>${installationView}<p id="github-status-message" class="form-status" aria-live="polite"></p></section><section class="panel"><h2>Connect GitHub App</h2><form id="github-setup-form" class="stack-form"><label for="github-account-id">Expected account ID <span class="optional">Optional</span></label><input id="github-account-id" name="expectedAccountId" maxlength="100"><button type="submit">Connect GitHub App</button><p class="form-status" aria-live="polite"></p></form></section><section><h2>Authorized repositories</h2>${repositories}</section>`;
}
export function profileDisplayName(profile) {
  const preferred = typeof profile?.preferences?.displayName === 'string' ? profile.preferences.displayName.trim() : '';
  if (preferred) return preferred;
  const identity = profile?.identity ?? {};
  return identity.name ?? identity.email ?? 'Signed in';
}

export function renderProfile(profile) {
  const identity = profile?.identity ?? {};
  const scopes = Array.isArray(profile?.scopes) ? profile.scopes : [];
  const preferred = typeof profile?.preferences?.displayName === 'string' ? profile.preferences.displayName : '';
  const scopeList = scopes.length ? `<ul class="record-list">${scopes.map((scope) => `<li class="mono">${escape(scope)}</li>`).join('')}</ul>` : '<p>No scopes reported.</p>';
  const value = (raw, extraClass = '') => raw ? `<dd${extraClass ? ` class="${extraClass}"` : ''}>${escape(raw)}</dd>` : '<dd>Not provided</dd>';
  const displaySection = `<section class="panel" aria-labelledby="profile-display-heading"><h2 id="profile-display-heading">Display name</h2><p>Shown in the dashboard header. Letters, numbers, spaces, and <code class="mono">. _ - '</code> are accepted up to 64 characters. Your verified sign-on name and email stay authoritative and are never changed here.</p><form id="profile-name-form" class="stack-form"><label for="profile-display-name">Display name <span class="optional">Optional</span></label><input id="profile-display-name" name="displayName" maxlength="64" autocomplete="off" spellcheck="false" value="${escape(preferred)}" placeholder="${escape(identity.name ?? identity.email ?? 'Your sign-on name')}"><div class="form-row-actions"><button type="submit" id="save-display-name">Save display name</button><button type="button" id="clear-display-name">Use sign-on name</button></div><p class="form-status" aria-live="polite"></p></form></section>`;
  return `<div class="page-note"><strong>Signed-in identity.</strong> These details come from your verified single sign-on assertion. Cloud Harness keeps no separate password for your account.</div>${displaySection}<section class="panel" aria-labelledby="profile-account-heading"><h2 id="profile-account-heading">Account</h2><dl class="facts"><dt>Name</dt>${value(identity.name)}<dt>Email</dt>${value(identity.email, 'wrap')}<dt>Subject</dt>${value(identity.subject, 'mono wrap')}<dt>Identity provider</dt>${value(identity.issuer, 'mono wrap')}</dl></section><section class="panel" aria-labelledby="profile-session-heading"><h2 id="profile-session-heading">Session</h2><dl class="facts"><dt>Sign-in method</dt><dd>Single sign-on</dd><dt>Session expires</dt><dd>${optionalTime(profile?.sessionExpiresAt)}</dd></dl><h3>Granted scopes</h3>${scopeList}</section>`;
}

export function renderSettings(data, readiness) {
  const profile = data?.defaultNetworkProfile ?? {};
  const value = profile.value === 'network-none' ? 'network-none' : 'dependency-access';
  const stored = profile.source === 'setting';
  const options = [
    ['dependency-access', 'Dependency access — public DNS and TCP 80/443 egress; required for gh and the GitHub API'],
    ['network-none', 'No network — air-gapped isolation']
  ].map(([option, label]) => `<option value="${option}"${stored && value === option ? ' selected' : ''}>${label}</option>`).join('');
  const source = stored ? 'Set in this dashboard' : 'Runner default (WORKSPACE_NETWORK_PROFILE or built-in)';
  const readinessFact = readiness
    ? `<dt>Egress readiness</dt><dd>${readiness.ready === true ? 'Ready' : `Not ready: ${escape(readiness.reason ?? 'the readiness probe reported no reason')}`}</dd>`
    : '';
  return `<div class="page-note"><strong>Instance-wide defaults.</strong> These values apply to workspaces opened without an explicit network profile. Saving here neither starts nor changes a running workspace.</div><section class="panel" aria-labelledby="settings-network-heading"><h2 id="settings-network-heading">Default network profile</h2><p>Choose the network posture for newly opened workspaces.</p><label for="settings-network-profile">Effective default</label><select id="settings-network-profile" name="defaultNetworkProfile">${options}<option value=""${stored ? '' : ' selected'}>Use runner default</option></select><dl class="facts"><dt>Effective profile</dt><dd>${escape(networkLabel(value))} <span class="mono">${escape(value)}</span></dd><dt>Source</dt><dd>${escape(source)}</dd>${readinessFact}</dl><p class="warning"><strong>Dependency access grants outbound network access to repository-controlled code.</strong> A dependency, build script, or agent command can then reach the network and exfiltrate any credential injected into the workspace, including a global GH_TOKEN. A fine-grained token scoped only to the repositories a workspace needs is safer than a broadly scoped credential. Check egress readiness before relying on it.</p><div class="form-row-actions"><button id="save-settings-network-profile" class="accent-btn" type="button">Save</button><button id="reset-settings-network-profile" type="button">Reset to runner default</button><button id="check-settings-network" type="button">Check egress readiness</button></div><p id="settings-status" class="status-message" aria-live="polite"></p></section>${renderTypesafeSkeleton()}`;
}

export function renderRuntime(data) {
  const records = (items, kind) => items.length ? `<ul class="runtime-list">${items.map((item) => `<li><strong>${escape(kind === 'session' ? item.name : item.id)}</strong><span>${escape(statusLabelRuntime(item.status))}</span>${item.exitCode === undefined ? '' : `<span>Exit ${escape(item.exitCode)}</span>`}</li>`).join('')}</ul>` : kind === 'task' ? '<p>No current tasks.</p>' : '<p>No named sessions.</p>';
  return `<p class="eyebrow">CURRENT RUNTIME STATE</p><p>Not retained across runner restart.</p><section><h2>Tasks</h2>${records(data.tasks, 'task')}</section><section><h2>Named sessions</h2>${records(data.sessions, 'session')}</section>`;
}

export function renderFileList(workspaceId, data) {
  const path = data.path ?? '.';
  const items = data.entries.length ? data.entries.map((entry) => `<li><a href="/dashboard/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(join(path, entry.name))}${entry.type === 'file' ? '&file=1' : ''}">${escape(entry.name)}</a><span>${escape(entry.type)}</span></li>`).join('') : '<li>No files in this folder.</li>';
  return `<nav aria-label="Breadcrumb"><a href="/dashboard/workspaces/${encodeURIComponent(workspaceId)}/files?path=.">Workspace root</a><span class="mono wrap">${escape(path)}</span></nav><h2>Files</h2><ul class="file-list">${items}</ul><form id="folder-form"><label for="folder-path">New folder path</label><input id="folder-path" name="path" required><button type="submit">Create folder</button></form><form id="move-form"><label for="move-source">Source</label><input id="move-source" name="source" required><label for="move-destination">Destination</label><input id="move-destination" name="destination" required><button type="submit">Move</button></form>`;
}

export function renderFile(workspaceId, data) {
  return `<nav aria-label="Breadcrumb"><a href="/dashboard/workspaces/${encodeURIComponent(workspaceId)}/files?path=.">Workspace root</a></nav><h2 class="mono wrap">${escape(data.path)}</h2><p>Version <span class="mono wrap">${escape(data.sha256)}</span></p><pre><code>${escape(data.content)}</code></pre><form id="file-editor"><label for="file-content">File content</label><textarea id="file-content" name="content" spellcheck="false">${escape(data.content)}</textarea><input type="hidden" name="sha" value="${escape(data.sha256)}"><button type="submit">Save file</button><button id="delete-file" class="danger" type="button">Delete file</button></form><form id="patch-form"><label for="old-text">Text to replace</label><textarea id="old-text" name="oldText" spellcheck="false"></textarea><label for="new-text">Replacement text</label><textarea id="new-text" name="newText" spellcheck="false"></textarea><button type="submit">Apply text patch</button></form>`;
}

export const repositoryName = (url) => { try { return new URL(url).pathname.replace(/^\//, '').replace(/\.git$/, ''); } catch { return 'Repository'; } };
const join = (base, name) => base === '.' ? name : `${base}/${name}`;
const statusLabelRuntime = (status) => ({ queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', blocked: 'Blocked' })[status] ?? 'Unknown';
const formatBytes = (value) => Number.isFinite(value) ? `${Number(value).toLocaleString()} bytes` : 'Unknown';
const stateLabel = (state) => ({ ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked', UNKNOWN: 'Unknown' })[state];
const optionalTime = (value) => (typeof value === 'string' && value) || (typeof value === 'number' && Number.isFinite(value)) ? time(value) : 'Never';
const publicMcpUrl = (value) => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/mcp' && !url.username && !url.password && !url.search && !url.hash ? url.toString() : undefined;
  } catch { return undefined; }
};

export function renderOverviewSkeleton() {
  const tile = '<li class="skeleton tile" aria-hidden="true"></li>';
  const block = '<div class="skeleton tile" aria-hidden="true"></div>';
  return `<div class="overview"><ul class="metric-grid">${tile.repeat(4)}</ul><div class="overview-columns">${block}${block}</div></div>`;
}

/**
 * The Skills page skeleton. Every identifier here is named by the phase's UI contract, so the page
 * structure is asserted rather than assumed, and the four tabs keep their panels in the document so a
 * tab switch never has to rebuild markup the operators are reading.
 */
export function renderSkillsSkeleton() {
  const tab = (name, label, selected) =>
    `<button type="button" role="tab" id="skills-tab-${name}" aria-controls="skills-panel-${name}" aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}">${label}</button>`;
  const panel = (name, body, selected) =>
    `<div class="skills-panel" role="tabpanel" id="skills-panel-${name}" aria-labelledby="skills-tab-${name}"${selected ? '' : ' hidden'}>${body}</div>`;

  // Each filter is one `.skills-field` cell rather than a bare `<label>`/control pair, because the
  // dashboard's global `form` rule lays form children out as one wrapping flex row and a filter bar
  // needs labelled columns instead.
  const library = `<div class="skills-section-head">
        <h3 id="skills-library-heading">Installed skills</h3>
        <p id="skills-library-count" class="skills-count" role="status" aria-live="polite"></p>
      </div>
      <form class="skills-toolbar" role="search" aria-label="Filter skills">
        <div class="skills-field skills-field-search">
          <label for="skills-library-search">Search</label>
          <input id="skills-library-search" name="q" placeholder="Filter by name or provider">
        </div>
        <div class="skills-field">
          <label for="skills-library-provider">Provider</label>
          <select id="skills-library-provider" name="provider"><option value="">Any</option><option value="skills-sh">skills.sh</option><option value="skillx">SkillX</option><option value="custom">Custom</option><option value="git">Git</option></select>
        </div>
        <div class="skills-field">
          <label for="skills-library-state">State</label>
          <select id="skills-library-state" name="state"><option value="">Any</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="archived">Archived</option></select>
        </div>
        <div class="skills-field">
          <label for="skills-library-tag">Tag</label>
          <input id="skills-library-tag" name="tag" placeholder="Filter by tag">
        </div>
        <div class="skills-field">
          <label for="skills-library-sort">Sort</label>
          <select id="skills-library-sort" name="sort"><option value="name">Name</option><option value="provider">Provider</option><option value="state">State</option></select>
        </div>
      </form>
      <div id="skills-bulk-bar" class="skills-bulk-bar" hidden><span id="skills-bulk-count" class="skills-bulk-count"></span><div class="skills-bulk-actions"><button type="button" id="skills-bulk-archive">Archive</button><button type="button" id="skills-bulk-disable">Disable</button></div></div>
      <table id="skills-library-table" class="data-table desktop-table"><caption class="sr-only">Installed skills</caption><thead><tr><th scope="col">Name</th><th scope="col">Provider</th><th scope="col">Tier</th><th scope="col">Version</th><th scope="col">State</th><th scope="col">Select</th></tr></thead><tbody></tbody></table>
      <ul id="skills-library-cards" class="card-grid"></ul>
      <div id="skills-library-empty" class="empty" hidden>
        <p id="skills-library-empty-message"></p>
        <button type="button" id="skills-library-empty-action" class="secondary"></button>
      </div>
      <aside id="skill-detail" class="drawer" aria-labelledby="skill-detail-title" hidden>
        <div class="drawer-head">
          <div class="drawer-identity">
            <h3 id="skill-detail-title">Skill detail</h3>
            <p id="skill-detail-slug" class="mono"></p>
          </div>
          <button type="button" id="skill-detail-close" class="drawer-close">Close</button>
        </div>
        <section class="drawer-section">
          <h4>Instructions</h4>
          <div id="skill-detail-instructions"></div>
        </section>
        <!-- No dashboard reader exposes a revision's files, so this section stays out of the layout
             rather than rendering a labelled box with nothing under it. The container remains because
             the UI contract pins the id. -->
        <section class="drawer-section" hidden>
          <h4>Files</h4>
          <div id="skill-detail-files"></div>
        </section>
        <section class="drawer-section">
          <h4>Revisions</h4>
          <div id="skill-detail-revisions"></div>
        </section>
        <section class="drawer-section">
          <h4>Usage</h4>
          <div id="skill-detail-usage"></div>
        </section>
        <pre id="skill-revision-diff" class="skills-diff" tabindex="0" aria-label="Revision diff"></pre>
        <div class="drawer-actions">
          <button type="button" id="skill-detail-edit">Edit instructions</button>
        </div>
      </aside>`;

  const discover = `<div class="skills-search panel">
        <div class="skills-field skills-field-search">
          <label for="skills-search-input">Search providers</label>
          <input id="skills-search-input" name="q">
        </div>
        <button type="button" id="skills-search-run">Search</button>
      </div>
      <div id="skills-search-results" class="skills-results"></div>
      <dialog id="skill-import-dialog" aria-labelledby="skill-import-heading">
        <h2 id="skill-import-heading">Import skill</h2>
        <div class="skills-field">
          <label for="skill-import-source">Source</label>
          <input id="skill-import-source" name="source" placeholder="owner/repository">
        </div>
        <div class="skills-field">
          <label for="skill-import-ref">Ref</label>
          <input id="skill-import-ref" name="ref" placeholder="Full commit id (optional)">
        </div>
        <!-- The UI contract pins this id; the operation it feeds takes a source kind, not an install
             scope, because an imported skill always lands in the owner tier. The label says what the
             value actually is so the operator is not offered a choice the runner cannot honour. -->
        <div class="skills-field">
          <label for="skill-import-scope">Source kind</label>
          <select id="skill-import-scope" name="sourceKind"><option value="skills-sh">skills.sh</option><option value="skillx">SkillX</option><option value="git">Git</option></select>
        </div>
        <div id="skill-import-review" class="form-status"></div>
        <div id="skill-import-job" class="form-status" role="status"></div>
        <div class="skills-form-actions">
          <button type="button" id="skill-import-submit">Import</button>
          <button type="button" id="skill-import-retry">Retry</button>
          <button type="button" id="skill-import-cancel">Cancel</button>
        </div>
      </dialog>`;

  const sets = `<div id="skill-set-builder" class="panel">
        <h3>Build a skill set</h3>
        <div class="skills-field">
          <label for="skill-set-name">Name</label>
          <input id="skill-set-name" name="name">
        </div>
        <div class="skills-field">
          <h4>Available skills</h4>
          <div id="skill-set-picker" role="group" aria-label="Available skills" class="skills-picker tools-checkbox-grid"></div>
        </div>
        <div class="skills-field">
          <h4>Selected members</h4>
          <ol id="skill-set-members" class="skills-members"></ol>
        </div>
        <div class="skills-form-actions">
          <button type="button" id="skill-set-save">Save set</button><span id="skill-set-status" role="status"></span>
        </div>
      </div>`;

  const registry = `<div class="panel">
        <h3>Toolkit and registry cache</h3>
        <table id="skills-registry-table" class="data-table"><caption class="sr-only">Registry and toolkit inventory</caption><thead><tr><th scope="col">Name</th><th scope="col">Cache state</th><th scope="col">Pinned commit</th><th scope="col">Skills</th><th scope="col">Lock</th></tr></thead><tbody></tbody></table>
        <h4>Suggested toolkits to install</h4>
        <ul id="skills-registry-suggestions" class="preset-suggestions"></ul>
        <p id="skills-registry-status" role="status" aria-live="polite"></p>
      </div>`;

  return `<section id="skills-section" aria-labelledby="skills-heading">
      <h2 id="skills-heading" class="sr-only">Skills</h2>
      <div class="skills-tabs" role="tablist" aria-label="Skills views">${tab('library', 'Library', true)}${tab('discover', 'Discover', false)}${tab('sets', 'Skill Sets', false)}${tab('registry', 'Registry', false)}</div>
      ${panel('library', library, true)}${panel('discover', discover, false)}${panel('sets', sets, false)}${panel('registry', registry, false)}
      <!-- One dialog serves creating and editing, and it sits outside the tab panels on purpose: a dialog
           inside a hidden panel does not render, and its opener is the page-action button, which belongs
           to the page rather than to any one tab. -->
      <dialog id="skill-editor-dialog" aria-labelledby="skill-editor-title" aria-describedby="skill-editor-description">
        <h2 id="skill-editor-title">Create a custom skill</h2>
        <p id="skill-editor-description">Instructions are stored as the skill's SKILL.md.</p>
        <form id="skill-editor" class="skills-editor">
          <div class="skills-form-row">
            <div class="skills-field">
              <label for="skill-editor-slug">Slug</label>
              <input id="skill-editor-slug" name="slug" placeholder="my-skill">
            </div>
            <div class="skills-field">
              <label for="skill-editor-name">Display name</label>
              <input id="skill-editor-name" name="displayName">
            </div>
          </div>
          <div class="skills-field">
            <label for="skill-editor-instructions">Instructions</label>
            <textarea id="skill-editor-instructions" name="instructions"></textarea>
          </div>
          <p id="skill-editor-status" class="form-status" role="status"></p>
          <div class="dialog-actions">
            <button type="button" data-dialog-close>Cancel</button>
            <button type="submit" id="skill-editor-save">Save skill</button>
          </div>
        </form>
      </dialog>
      <dialog id="skill-upload-dialog" aria-labelledby="skill-upload-title" aria-describedby="skill-upload-description">
        <h2 id="skill-upload-title">Upload skills</h2>
        <p id="skill-upload-description">A zip of skill directories. Each directory's SKILL.md becomes a skill. Up to 200 skills, 8 MB per upload.</p>
        <form id="skill-upload" class="skills-editor">
          <div class="skills-field">
            <label for="skill-upload-file">Archive</label>
            <input id="skill-upload-file" name="archive" type="file" accept=".zip,application/zip">
          </div>
          <p id="skill-upload-status" class="form-status" role="status"></p>
          <ul id="skill-upload-results" class="skills-results"></ul>
          <div class="dialog-actions">
            <button type="button" data-dialog-close>Close</button>
            <button type="submit" id="skill-upload-save">Upload</button>
          </div>
        </form>
      </dialog>
    </section>`;
}

/**
 * Rows for the library table, injected into the skeleton's tbody once data arrives. Every value goes
 * through `escape`, because a skill's display name and slug are operator-supplied and a skill imported
 * from a provider carries a name this dashboard never authored.
 */
export function renderSkillsLibraryRows(skills) {
  const rows = Array.isArray(skills) ? skills : [];
  if (rows.length === 0) return '<tr><td colspan="6">No skills yet. Import one from Discover, or create a custom skill.</td></tr>';
  return rows.map((skill) => `<tr data-skill-id="${escape(skill.id)}">
      <th scope="row"><button type="button" class="link-btn" data-skill-detail="${escape(skill.id)}">${escape(skill.displayName)}</button><small class="mono">${escape(skill.slug)}</small></th>
      <td>${escape(skill.provider)}</td>
      <td>${escape(skill.kind)}</td>
      <td>${skill.version ? `<span class="mono">${escape(skill.version)}</span>` : '—'}</td>
      <td><span class="status ${escape(String(skill.state))}">${escape(skill.state)}</span></td>
      <td><input type="checkbox" data-skill-select="${escape(skill.id)}" aria-label="Select ${escape(skill.displayName)}"></td>
    </tr>`).join('');
}

/** Rows for the registry table: cache state, pinned commit, skill count, and lock state per entry. */
export function renderSkillsRegistryRows(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  if (rows.length === 0) return '<tr><td colspan="5">No registry entries yet.</td></tr>';
  return rows.map((entry) => `<tr>
      <th scope="row">${escape(entry.displayName ?? entry.slug)}</th>
      <td><span class="status">${escape(entry.cacheState ?? 'unknown')}</span></td>
      <td class="mono">${escape(entry.pinnedCommit ?? '—')}</td>
      <td>${escape(entry.skillCount ?? 0)}</td>
      <td>${escape(entry.lockState ?? 'unlocked')}</td>
    </tr>`).join('');
}

/**
 * Conflict radios for the launch dialog. A name is unresolved until an override names one of its
 * candidates, which is the same rule the resolver applies, so the dialog cannot offer a choice the
 * launch path would then refuse.
 */
export function renderSkillConflicts(conflicts, overrides = {}) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  return list.map((conflict) => {
    const choices = (Array.isArray(conflict.candidates) ? conflict.candidates : []).map((candidate) =>
      `<label><input type="radio" name="conflict-${escape(conflict.name)}" value="${escape(candidate.revisionId)}"${overrides[conflict.name] === candidate.revisionId ? ' checked' : ''}> ${escape(candidate.tier)} · ${escape(candidate.revisionId)}</label>`).join('');
    return `<fieldset data-conflict-name="${escape(conflict.name)}"><legend>${escape(conflict.name)}</legend>${choices}</fieldset>`;
  }).join('');
}

/** True while any conflict still lacks an override, which is what keeps launch disabled. */
export function launchBlockedByConflicts(conflicts, overrides = {}) {
  return (Array.isArray(conflicts) ? conflicts : []).some((conflict) => overrides[conflict.name] === undefined);
}

/**
 * The TypeSafe panel. The key field is a password input that is never rendered back, the kill switch is
 * an ordinary checkbox, and the usage list shows scores rather than prompts, because prompt text never
 * belongs on this page.
 */
export function renderTypesafeSkeleton() {
  return `<section id="typesafe-panel" aria-labelledby="typesafe-heading">
      <h2 id="typesafe-heading">TypeSafe skill suggestions</h2>
      <p id="typesafe-egress" role="status" aria-live="polite"></p>
      <form class="stack-form" id="typesafe-form">
        <label for="typesafe-key">API key (write-only, never shown again)</label>
        <input id="typesafe-key" name="value" type="password" autocomplete="new-password">
        <label for="typesafe-model">Model</label>
        <input id="typesafe-model" name="model" value="jev-latest">
        <label for="typesafe-gate-threshold">Gate threshold</label>
        <input id="typesafe-gate-threshold" name="gateThreshold" type="number" min="0" max="1" step="0.05">
        <label for="typesafe-fit-threshold">Fit threshold</label>
        <input id="typesafe-fit-threshold" name="fitThreshold" type="number" min="0" max="1" step="0.05">
        <label for="typesafe-max-egress-bytes">Maximum egress bytes</label>
        <input id="typesafe-max-egress-bytes" name="maxEgressBytes" type="number" min="256" max="8192">
        <label for="typesafe-cache-ttl">Cache lifetime (minutes)</label>
        <input id="typesafe-cache-ttl" name="cacheTtlMinutes" type="number" min="1" max="1440">
        <label for="typesafe-enabled"><input id="typesafe-enabled" name="enabled" type="checkbox"> Send suggestions</label>
        <button type="button" id="typesafe-test">Test connection</button>
        <button type="submit" id="typesafe-save">Save</button>
        <span id="typesafe-status" role="status" aria-live="polite"></span>
      </form>
      <table id="typesafe-usage" class="data-table desktop-table"><caption class="sr-only">Recent suggestions</caption><thead><tr><th scope="col">Skill</th><th scope="col">Gate</th><th scope="col">Fit</th><th scope="col">Latency</th><th scope="col">Redactions</th><th scope="col">Cached</th></tr></thead><tbody></tbody></table>
    </section>`;
}

/** Chips for the selected skill sets, so the launch dialog names what is about to be bound. */
export function renderSkillSetChips(names) {
  const list = Array.isArray(names) ? names : [];
  return list.map((name) => `<li>${escape(name)}</li>`).join('');
}

/**
 * The same rows as cards, for narrow screens. A five-column table cannot fit a phone, and the shell
 * already hides `.desktop-table` under its mobile breakpoint, so the two renderings share one source.
 */
export function renderSkillsLibraryCards(skills) {
  const list = Array.isArray(skills) ? skills : [];
  if (list.length === 0) return '<li class="panel">No skills yet. Import one from Discover, or create a custom skill.</li>';
  return list.map((skill) => `<li class="panel">
      <h3><button type="button" class="link-btn" data-skill-detail="${escape(skill.id)}">${escape(skill.displayName)}</button></h3>
      <p class="mono">${escape(skill.slug)}</p>
      <p><span class="status ${escape(String(skill.state))}">${escape(skill.state)}</span> ${escape(skill.provider)}</p>
      <label><input type="checkbox" data-skill-select="${escape(skill.id)}" aria-label="Select ${escape(skill.displayName)}"> Select</label>
    </li>`).join('');
}

/** Options for the launch dialog's skill-set selector. */
export function renderSkillSetOptions(sets) {
  const list = Array.isArray(sets) ? sets : [];
  return list.map((set) => `<option value="${escape(set.id)}">${escape(set.name)}</option>`).join('');
}

/** Pickable skills for the set builder. Names come from the inventory, so every one is escaped. */
export function renderSkillSetPicker(skills) {
  const list = Array.isArray(skills) ? skills : [];
  if (list.length === 0) return '<p>No skills to add yet.</p>';
  return list.map((skill) => `<label><input type="checkbox" data-set-member="${escape(skill.id)}"> ${escape(skill.displayName)}</label>`).join('');
}

/**
 * Revision rows for the detail drawer. The current revision is labelled rather than offering a restore
 * to itself, so the only restore a reader can press is one that would actually change something.
 */
export function renderSkillRevisions(revisions, currentRevisionId) {
  const list = Array.isArray(revisions) ? revisions : [];
  if (list.length === 0) return '<p>No revisions yet.</p>';
  return `<ul class="skills-revisions">${list.map((revision) => `<li>
      <span class="mono">${escape(revision.id)}</span>
      <span>${escape(revision.origin)}</span>
      <span class="mono">${revision.version ? escape(revision.version) : '—'}</span>
      ${time(revision.createdAt)}
      ${revision.id === currentRevisionId
        ? '<span class="status">current</span>'
        : `<button type="button" data-skill-restore="${escape(revision.id)}">Restore</button>`}
      <button type="button" data-skill-diff="${escape(revision.id)}">Diff</button>
      <button type="button" data-skill-fork="${escape(revision.id)}">Fork</button>
    </li>`).join('')}</ul>`;
}

/**
 * Guidance for an import job. A failed job is only actionable if it says which failure it was, and a
 * cache miss in particular has an exact remedy, so it gets its own sentence rather than a generic
 * failure line that leaves the operator guessing.
 */
export function renderImportJobGuidance(job) {
  const state = job ? job.state : undefined;
  if (state === 'failed') {
    const code = job.errorCode ?? 'unknown';
    if (code === 'CACHE_MISS') {
      return 'CACHE_MISS: this skill is not mirrored in the runner cache. Import it while the runner has network access, then retry.';
    }
    return `The import failed (${code}). Retry, or check the runner logs for the provider response.`;
  }
  if (state === 'succeeded') return 'Import finished. The skill is now in the library.';
  if (state === 'cancelled') return 'Import cancelled.';
  const percent = job && job.progress && typeof job.progress.percent === 'number' ? job.progress.percent : undefined;
  return `Import ${state ?? 'queued'}${percent === undefined ? '' : ` (${percent}%)`}.`;
}

/** True when a job has reached a state the operator can act on, which is when polling should stop. */
export function isTerminalImportState(job) {
  const state = job ? job.state : undefined;
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/**
 * A unified diff with its lines marked, plus a text alternative. A diff conveyed only through colour
 * is unreadable to a screen reader and to anyone who cannot distinguish the two shades, so the counts
 * travel with the markup and the line classes carry the meaning.
 */
export function renderRevisionDiff(diff) {
  const lines = String(diff ?? '').split('\n');
  const body = lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return `<span class="diff-line diff-meta">${escape(line)}</span>`;
    if (line.startsWith('+')) return `<span class="diff-line diff-add">${escape(line)}</span>`;
    if (line.startsWith('-')) return `<span class="diff-line diff-remove">${escape(line)}</span>`;
    return `<span class="diff-line">${escape(line)}</span>`;
  }).join('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return {
    html: `<code>${body}</code>`,
    text: `${added} line${added === 1 ? '' : 's'} added, ${removed} line${removed === 1 ? '' : 's'} removed`
  };
}

function renderServerPanel(server) {
  if (!server) return '';
  const oauth = server.managedOAuthUrl
    ? `<dd class="wrap"><span class="mono wrap">${escape(server.managedOAuthUrl)}</span> <button type="button" class="copy" data-copy="${escape(server.managedOAuthUrl)}">Copy</button></dd>`
    : '<dd>Not published</dd>';
  const gateway = server.apiKeyGateway?.enabled
    ? `<dd class="wrap">Enabled${server.apiKeyGateway.endpoint ? ` <span class="mono wrap">${escape(server.apiKeyGateway.endpoint)}</span> <button type="button" class="copy" data-copy="${escape(server.apiKeyGateway.endpoint)}">Copy</button>` : ''}</dd>`
    : '<dd>Disabled</dd>';
  const maxBytes = Number.isFinite(server.limits?.maxRequestBytes) ? formatBytes(server.limits.maxRequestBytes) : 'Unknown';
  const timeout = Number.isFinite(server.limits?.requestTimeoutMs) ? `${Math.round(server.limits.requestTimeoutMs / 1_000)}s` : 'Unknown';
  return `<section class="panel" aria-labelledby="overview-server-heading"><div class="record-heading"><h2 id="overview-server-heading">Server</h2><span class="status active">Online</span></div><dl class="facts"><dt>Auth mode</dt><dd class="mono">${escape(server.authMode ?? 'Unknown')}</dd><dt>Version</dt><dd class="mono">${escape(server.version ?? 'Unknown')}</dd><dt>Managed OAuth</dt>${oauth}<dt>API-key gateway</dt>${gateway}<dt>Max request</dt><dd>${escape(maxBytes)}</dd><dt>Request timeout</dt><dd>${escape(timeout)}</dd><dt>Session expires</dt><dd>${optionalTime(server.session?.expiresAt)}</dd><dt>Checked</dt><dd>${optionalTime(server.checkedAt)}</dd></dl></section>`;
}

/**
 * The Overview answers decision questions first: what needs attention, what is running,
 * what it costs, and what expires soon. Every tile links to the filtered view that
 * explains it, and Access/Server move below the decision metrics.
 */
export function renderOverview({ overview = {}, access = {}, server, metrics = {}, reliability = {} } = {}) {
  const attention = Array.isArray(overview.attention) ? overview.attention : [];
  const running = overview.running ?? {};
  const cost = overview.cost ?? {};
  const expiring = Array.isArray(overview.expiring) ? overview.expiring : [];
  const costMicros = Number(cost.costMicros);
  const inAnHour = expiring.find((bucket) => bucket.windowMinutes === 60) ?? {};
  const tiles = [
    { id: 'attention', label: 'Needs attention', value: String(attention.length), note: attention.length ? 'Open the agents needing attention; the list below also covers workspaces and approvals.' : 'Nothing needs action right now.', href: '/dashboard/agents?attention=needs-attention', alert: attention.length > 0 },
    { id: 'running', label: 'Running now', value: String(running.agents ?? 0), note: `${String(running.workspaces ?? 0)} active workspace(s)`, href: '/dashboard/agents?status=RUNNING' },
    { id: 'cost', label: 'Cost', value: Number.isFinite(costMicros) ? `$${(costMicros / 1_000_000).toFixed(4)}` : 'Not reported', note: `scope: ${String(cost.scope ?? 'not reported')}`, href: '/dashboard/agents?status=RUNNING' },
    { id: 'expiry', label: 'Expiring soon', value: String(inAnHour.count ?? 0), note: 'lease(s) within the hour', href: '/dashboard/workspaces?expiring=60', alert: Number(inAnHour.count ?? 0) > 0 }
  ];
  const metricTiles = `<ul class="metric-grid decision-grid">${tiles.map((tile) => `<li class="metric decision-${escape(tile.id)}${tile.alert ? ' has-alert' : ''}"><a href="${escape(tile.href)}"><span class="metric-label">${escape(tile.label)}</span><span class="metric-value">${escape(tile.value)}</span><span class="metric-note">${escape(tile.note)}</span></a></li>`).join('')}</ul>`;
  const attentionList = attention.length
    ? `<ul class="attention-list">${attention.map((item) => `<li class="attention-item"><a href="${escape(String(item.href ?? '/dashboard'))}">${escape(String(item.label ?? 'Attention'))}</a><span>${escape(String(item.detail ?? ''))}</span></li>`).join('')}</ul>`
    : '<p class="empty-note">Nothing needs attention right now.</p>';
  const expiryBuckets = expiring.length
    ? `<ul class="record-list">${expiring.map((bucket) => `<li><a href="/dashboard/workspaces">${escape(String(bucket.label ?? ''))}</a><span>${escape(String(bucket.count ?? 0))} workspace(s)</span></li>`).join('')}</ul>`
    : '<p class="empty-note">No workspaces are close to expiry.</p>';
  const endpoint = access.endpoint ? `<dt>Static endpoint</dt><dd class="wrap"><span class="mono wrap">${escape(access.endpoint)}</span> <button type="button" class="copy" data-copy="${escape(access.endpoint)}">Copy</button></dd>` : '';
  return `<div class="overview">${metricTiles}<div class="overview-columns"><section class="panel" aria-labelledby="overview-attention-heading"><h2 id="overview-attention-heading">Needs attention</h2>${attentionList}</section><section class="panel" aria-labelledby="overview-expiry-heading"><h2 id="overview-expiry-heading">Expiring soon</h2>${expiryBuckets}</section></div>${renderAnalyticsSection({ overview, metrics, reliability })}<div class="overview-columns overview-meta"><section class="panel" aria-labelledby="overview-access-heading"><h2 id="overview-access-heading">Access</h2><dl class="facts"><dt>Signed in as</dt><dd class="wrap">${escape(access.name ?? 'Not provided')}</dd><dt>Email</dt><dd class="wrap">${escape(access.email ?? 'Not provided')}</dd><dt>Session expires</dt><dd>${optionalTime(access.sessionExpiresAt)}</dd>${endpoint}</dl></section>${renderServerPanel(server)}</div></div>`;
}

export function renderModelsPage(profiles = [], credentials = [], status = null) {
  const syncLabel = status?.gatewaySynced ? 'Gateway synchronized' : 'Gateway sync pending';
  const syncClass = status?.gatewaySynced ? 'active' : 'reaping';

  const profileRows = profiles.length ? profiles.map((p) => {
    const rev = p.activeRevision;
    const modelInfo = rev ? `${escape(rev.model)} · ${escape(rev.apiMode)}` : 'No active revision';
    const pricing = rev ? `$${(rev.pricing.inputMicrosPerMillionTokens / 1_000_000).toFixed(4)} / $${(rev.pricing.outputMicrosPerMillionTokens / 1_000_000).toFixed(4)}` : '-';
    const statusPill = `<span class="status ${escape(p.status.toLowerCase())}">${escape(p.status)}</span>`;
    const actionBtn = p.status === 'ACTIVE'
      ? `<button class="disable-model-profile" data-profile-id="${escape(p.id)}" data-generation="${escape(p.generation)}">Disable</button>`
      : `<button class="activate-model-profile" data-profile-id="${escape(p.id)}" data-generation="${escape(p.generation)}">Activate</button>`;

    return `<tr>
      <th scope="row">
        <strong>${escape(p.displayName)}</strong>
        <small class="mono wrap">${escape(p.id)}</small>
      </th>
      <td>${statusPill}</td>
      <td>${modelInfo}</td>
      <td>${pricing}</td>
      <td>
        <div class="row-actions">
          <button class="edit-model-profile" data-profile-json="${escape(JSON.stringify(p))}">Edit</button>
          ${actionBtn}
          <button class="danger delete-model-profile" data-profile-id="${escape(p.id)}" data-generation="${escape(p.generation)}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">No model profiles configured yet.</td></tr>';

  const credentialRows = credentials.length ? credentials.map((c) => {
    const statusPill = `<span class="status ${escape(c.status.toLowerCase())}">${escape(c.status)}</span>`;
    return `<tr>
      <th scope="row">
        <strong>${escape(c.label)}</strong>
        <small class="mono wrap">${escape(c.id)}</small>
      </th>
      <td>${escape(c.provider)}</td>
      <td><span class="mono">Configured · v${escape(c.activeVersion)}</span></td>
      <td>${statusPill}</td>
      <td>
        <div class="row-actions">
          <button class="rotate-model-credential" data-credential-id="${escape(c.id)}" data-label="${escape(c.label)}" data-generation="${escape(c.generation ?? 1)}">Rotate</button>
          <button class="danger delete-model-credential" data-credential-id="${escape(c.id)}" data-generation="${escape(c.generation ?? 1)}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">No provider credentials configured yet.</td></tr>';

  return `
    <div class="page-note">
      <strong>Subagent Model Control Plane.</strong> Manage model profiles and write-only provider credentials for Pi subagents.
      Credentials are encrypted in StateStore and projected dynamically to Model Gateway without container restart.
    </div>
    <div class="record-heading">
      <div>
        <h2>Model Profiles & Credentials</h2>
        <p>Configured provider credentials and agent routing profiles.</p>
      </div>
      <div class="row-actions">
        <span class="status ${syncClass}">${syncLabel}</span>
      </div>
    </div>
    <section class="panel" aria-labelledby="model-profiles-heading">
      <h3 id="model-profiles-heading">Model Profiles</h3>
      <div class="desktop-table">
        <table>
          <caption>Active and configured model profiles for subagents</caption>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Status</th>
              <th>Model / API</th>
              <th>Pricing ($/1M in/out)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${profileRows}</tbody>
        </table>
      </div>
    </section>
    <section class="panel" aria-labelledby="model-credentials-heading">
      <h3 id="model-credentials-heading">Provider Credentials</h3>
      <div class="desktop-table">
        <table>
          <caption>Configured provider API keys and credentials</caption>
          <thead>
            <tr>
              <th>Credential</th>
              <th>Provider</th>
              <th>Secret Key</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${credentialRows}</tbody>
        </table>
      </div>
    </section>
  `;
}
export function renderMarkdown(markdown = '') {
  if (!markdown) return '<p class="empty">No content.</p>';
  const lines = String(markdown).split('\n');
  const html = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let inList = false;
  let inTable = false;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.trim().startsWith('```')) {
      if (inCode) {
        inCode = false;
        const rawCode = codeLines.join('\n');
        if (codeLang.toLowerCase() === 'mermaid') {
          html.push(renderMermaidSvg(rawCode));
        } else {
          html.push(`<pre><code class="lang-${escape(codeLang)}">${escape(rawCode)}</code></pre>`);
        }
        codeLines = [];
        codeLang = '';
      } else {
        inCode = true;
        codeLang = line.trim().slice(3).trim();
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Table parsing
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      inTable = true;
      tableRows.push(line.trim());
      continue;
    } else if (inTable) {
      inTable = false;
      html.push(renderMarkdownTable(tableRows));
      tableRows = [];
    }

    // Blank lines
    if (!line.trim()) {
      if (inList) { inList = false; html.push('</ul>'); }
      continue;
    }

    // Headings
    if (line.startsWith('#### ')) { html.push(`<h4>${formatInline(line.slice(5))}</h4>`); continue; }
    if (line.startsWith('### ')) { html.push(`<h3>${formatInline(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## ')) { html.push(`<h2>${formatInline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# ')) { html.push(`<h1>${formatInline(line.slice(2))}</h1>`); continue; }

    // Blockquote
    if (line.startsWith('> ')) { html.push(`<blockquote>${formatInline(line.slice(2))}</blockquote>`); continue; }

    // Lists
    if (line.trim().startsWith('- [ ] ') || line.trim().startsWith('- [x] ')) {
      if (!inList) { inList = true; html.push('<ul class="task-list">'); }
      const checked = line.trim().startsWith('- [x] ');
      const text = line.trim().slice(6);
      html.push(`<li><input type="checkbox" ${checked ? 'checked' : ''} disabled> ${formatInline(text)}</li>`);
      continue;
    }
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      if (!inList) { inList = true; html.push('<ul>'); }
      html.push(`<li>${formatInline(line.trim().slice(2))}</li>`);
      continue;
    }

    if (inList) { inList = false; html.push('</ul>'); }

    // Regular paragraph
    html.push(`<p>${formatInline(line)}</p>`);
  }

  if (inCode) {
    html.push(`<pre><code>${escape(codeLines.join('\n'))}</code></pre>`);
  }
  if (inList) html.push('</ul>');
  if (inTable) html.push(renderMarkdownTable(tableRows));

  return html.join('\n');
}

function renderMarkdownTable(rows) {
  if (!rows.length) return '';
  const parsed = rows.map((r) => r.split('|').map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1));
  if (parsed.length < 2) return `<p>${escape(rows.join('\n'))}</p>`;
  const headers = parsed[0];
  const bodyRows = parsed.slice(2);
  const headerHtml = `<thead><tr>${headers.map((h) => `<th>${formatInline(h)}</th>`).join('')}</tr></thead>`;
  const bodyHtml = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${formatInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="desktop-table"><table>${headerHtml}${bodyHtml}</table></div>`;
}

function formatInline(text = '') {
  let out = escape(text);
  // Wikilinks: [[id|Label]] or [[id]]
  out = out.replace(/\[\[(kn_[A-Za-z0-9_-]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => `<a class="wikilink" href="/dashboard/knowledge/${encodeURIComponent(id)}">${escape(label || id)}</a>`);
  // Bold & Italic
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

export function renderMermaidSvg(code = '') {
  const cleanCode = code.trim();
  if (!cleanCode) return '<p class="empty">Empty diagram.</p>';
  const lines = cleanCode.split('\n').map((l) => l.trim()).filter(Boolean);
  const nodes = [];
  const edges = [];

  for (const line of lines) {
    if (line.startsWith('graph ') || line.startsWith('flowchart ') || line.startsWith('sequenceDiagram') || line.startsWith('%%')) continue;
    const arrowMatch = line.match(/^([A-Za-z0-9_-]+)(?:\[([^\]]+)\])?\s*-->\s*([A-Za-z0-9_-]+)(?:\[([^\]]+)\])?$/);
    if (arrowMatch) {
      const [, srcId, srcLabel, tgtId, tgtLabel] = arrowMatch;
      if (!nodes.some((n) => n.id === srcId)) nodes.push({ id: srcId, label: srcLabel || srcId });
      if (!nodes.some((n) => n.id === tgtId)) nodes.push({ id: tgtId, label: tgtLabel || tgtId });
      edges.push({ from: srcId, to: tgtId });
    } else {
      const singleNodeMatch = line.match(/^([A-Za-z0-9_-]+)(?:\[([^\]]+)\])$/);
      if (singleNodeMatch) {
        const [, nId, nLabel] = singleNodeMatch;
        if (!nodes.some((n) => n.id === nId)) nodes.push({ id: nId, label: nLabel || nId });
      }
    }
  }

  if (!nodes.length) {
    return `<pre class="mermaid-fallback"><code>${escape(cleanCode)}</code></pre>`;
  }

  const nodeWidth = 140;
  const nodeHeight = 40;
  const spacingX = 180;
  const spacingY = 80;
  const width = Math.max(400, (nodes.length * spacingX) / 2 + 100);
  const height = Math.max(200, Math.ceil(nodes.length / 2) * spacingY + 80);

  const positionedNodes = nodes.map((n, idx) => ({
    ...n,
    x: 40 + (idx % 3) * spacingX,
    y: 30 + Math.floor(idx / 3) * spacingY
  }));

  const nodeMap = new Map(positionedNodes.map((n) => [n.id, n]));

  const edgeSvg = edges.map((e) => {
    const src = nodeMap.get(e.from);
    const tgt = nodeMap.get(e.to);
    if (!src || !tgt) return '';
    const x1 = src.x + nodeWidth / 2;
    const y1 = src.y + nodeHeight;
    const x2 = tgt.x + nodeWidth / 2;
    const y2 = tgt.y;
    return `<path class="mermaid-edge" d="M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}" marker-end="url(#mermaid-arrow)"/>`;
  }).join('');

  const nodeSvg = positionedNodes.map((n) => `
    <g class="mermaid-node-group" transform="translate(${n.x}, ${n.y})">
      <rect class="mermaid-node" width="${nodeWidth}" height="${nodeHeight}" rx="4"/>
      <text class="mermaid-label" x="${nodeWidth / 2}" y="${nodeHeight / 2 + 4}" text-anchor="middle">${escape(n.label)}</text>
    </g>
  `).join('');

  return `<div class="mermaid-diagram"><svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mermaid diagram"><defs><marker id="mermaid-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 8 5 L 0 9 z" fill="var(--line-strong)"/></marker></defs>${edgeSvg}${nodeSvg}</svg></div>`;
}
export function renderKnowledgeIndex(data, query = {}, activeTab = 'all') {
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.results) ? data.results.map((r) => r.item) : []);
  const results = Array.isArray(data?.results) ? data.results : null;
  const searchHint = query.q ? `<p class="form-status">Search results for: <strong>${escape(query.q)}</strong></p>` : '';
  const tabNav = `
    <div class="knowledge-nav-tabs" role="tablist" aria-label="Knowledge views">
      <button type="button" class="knowledge-tab-btn ${activeTab === 'all' ? 'active' : ''}" data-kn-tab="all" role="tab" aria-selected="${activeTab === 'all'}">All (${items.length})</button>
      <button type="button" class="knowledge-tab-btn ${activeTab === 'memories' ? 'active' : ''}" data-kn-tab="memories" role="tab" aria-selected="${activeTab === 'memories'}">Memories</button>
      <button type="button" class="knowledge-tab-btn ${activeTab === 'journals' ? 'active' : ''}" data-kn-tab="journals" role="tab" aria-selected="${activeTab === 'journals'}">Journals</button>
      <button type="button" class="knowledge-tab-btn ${activeTab === 'graph' ? 'active' : ''}" data-kn-tab="graph" role="tab" aria-selected="${activeTab === 'graph'}">Knowledge Graph</button>
    </div>
  `;

  if (activeTab === 'graph') {
    return `${tabNav}<div id="knowledge-graph-mount" class="knowledge-graph-container" aria-live="polite"><p class="form-status">Loading knowledge graph…</p></div>`;
  }

  const listItemsHtml = items.length ? items.map((item, idx) => {
    const resultMeta = results ? results[idx] : null;
    const relevanceHtml = resultMeta ? `<span class="relevance-badge ${escape(resultMeta.matchMode)}">${escape(resultMeta.matchMode.toUpperCase())} ${escape(resultMeta.relevancePercent)}%</span>` : '';
    const tagsHtml = (item.tags || []).map((t) => `<span class="tag-badge">${escape(t)}</span>`).join(' ');
    const dateStr = item.occurredAt ? new Date(item.occurredAt).toLocaleDateString() : (item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '');
    const journalTypeBadge = item.journalType ? `<span class="status">${escape(item.journalType)}</span>` : '';

    return `
      <li class="knowledge-card">
        <div class="knowledge-card-header">
          <div>
            <h3 class="knowledge-card-title"><a href="/dashboard/knowledge/${encodeURIComponent(item.id)}">${escape(item.title)}</a></h3>
            <div class="knowledge-meta-bar">
              <span class="mono">${escape(item.id)}</span>
              <span>${escape(item.scope.toUpperCase())}</span>
              ${journalTypeBadge}
              <span>${escape(dateStr)}</span>
              <span>Gen ${escape(item.generation)}</span>
            </div>
          </div>
          ${relevanceHtml}
        </div>
        <div class="knowledge-card-preview">${formatInline(item.content?.slice(0, 160) ?? '')}${item.content?.length > 160 ? '…' : ''}</div>
        <div class="knowledge-tags-row">${tagsHtml}</div>
      </li>
    `;
  }).join('') : '<li class="empty"><h3>No knowledge items match these filters.</h3><p>Create a memory note or journal to record durable context.</p></li>';

  return `
    <div class="page-note"><strong>Decoupled control-plane knowledge.</strong> Scoped memories and chronological journals persist independently from volatile workspace files and GitHub repository state.</div>
    <div class="record-heading">
      <div><h2>Knowledge Plane</h2><p>Durable memories, engineering journals, and interconnected graph relations.</p></div>
      <button id="open-create-knowledge-btn" class="accent-btn" type="button">+ Create item</button>
    ${tabNav}
    ${searchHint}
    <section aria-labelledby="knowledge-list-heading">
      <h2 id="knowledge-list-heading" class="sr-only">Knowledge items</h2>
      <ul class="knowledge-list">${listItemsHtml}</ul>
    </section>
  `;
}

export function renderKnowledgeDetail(item) {
  const tagsHtml = (item.tags || []).map((t) => `<span class="tag-badge">${escape(t)}</span>`).join(' ');
  const renderedContent = renderMarkdown(item.content);

  const outboundHtml = (item.outboundLinks || []).length
    ? `<ul>${item.outboundLinks.map((l) => `<li><a class="wikilink" href="/dashboard/knowledge/${encodeURIComponent(l.targetId)}">${escape(l.targetId)}</a> <small class="mono">(${escape(l.relation)})</small></li>`).join('')}</ul>`
    : '<p class="empty">No outgoing links.</p>';

  const backlinksHtml = (item.backlinks || []).length
    ? `<ul>${item.backlinks.map((l) => `<li><a class="wikilink" href="/dashboard/knowledge/${encodeURIComponent(l.sourceId)}">${escape(l.sourceId)}</a> <small class="mono">(${escape(l.relation)})</small></li>`).join('')}</ul>`
    : '<p class="empty">No incoming backlinks.</p>';

  return `
    <nav aria-label="Breadcrumb"><a href="/dashboard/knowledge">Knowledge</a><span>${escape(item.title)}</span></nav>
    <div class="record-heading">
      <div>
        <h2>${escape(item.title)}</h2>
        <div class="knowledge-meta-bar">
          <span class="mono">${escape(item.id)}</span>
          <span class="status">${escape(item.kind.toUpperCase())} (${escape(item.scope.toUpperCase())})</span>
          ${item.journalType ? `<span class="status">${escape(item.journalType)}</span>` : ''}
          <span>Generation <strong id="kn-current-generation">${escape(item.generation)}</strong></span>
          ${time(item.updatedAt)}
        </div>
      </div>
      <div class="row-actions">
        <button id="save-knowledge-btn" class="accent-btn" type="button" data-id="${escape(item.id)}">Save changes</button>
        <button id="delete-knowledge-btn" class="danger" type="button" data-id="${escape(item.id)}" data-generation="${escape(item.generation)}">Delete</button>
      </div>
    </div>
    <div class="knowledge-tags-row">${tagsHtml}</div>

    <div class="knowledge-split-container">
      <div class="knowledge-editor-pane">
        <div class="knowledge-pane-header"><span>Markdown source</span><span id="kn-edit-status">Saved</span></div>
        <textarea id="knowledge-editor-input" class="knowledge-textarea" spellcheck="false">${escape(item.content)}</textarea>
      </div>
      <div class="knowledge-preview-pane">
        <div class="knowledge-pane-header"><span>Live preview</span></div>
        <div id="knowledge-preview-output" class="knowledge-preview-body">${renderedContent}</div>
      </div>
    </div>

    <div class="form-row knowledge-relations-row">
      <section class="panel" aria-labelledby="outbound-links-heading">
        <h3 id="outbound-links-heading">Outgoing Relations</h3>
        ${outboundHtml}
      </section>
      <section class="panel" aria-labelledby="backlinks-heading">
        <h3 id="backlinks-heading">Backlinks</h3>
        ${backlinksHtml}
      </section>
    </div>
  `;
}

export function renderKnowledgeGraph(graphResult) {
  const nodes = Array.isArray(graphResult?.nodes) ? graphResult.nodes : [];
  const edges = Array.isArray(graphResult?.edges) ? graphResult.edges : [];

  if (!nodes.length) {
    return '<div class="empty"><h3>Knowledge graph is empty.</h3><p>Create memories, journals, or links to visualize relationships.</p></div>';
  }

  const width = 800;
  const height = 500;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.38;

  const positionedNodes = nodes.map((n, idx) => {
    const angle = (idx / nodes.length) * 2 * Math.PI;
    return {
      ...n,
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle)
    };
  });

  const nodeMap = new Map(positionedNodes.map((n) => [n.id, n]));

  const edgesSvg = edges.map((e) => {
    const src = nodeMap.get(e.sourceId);
    const tgt = nodeMap.get(e.targetId);
    if (!src || !tgt) return '';
    return `<line class="graph-edge-line ${escape(e.origin)}" x1="${src.x}" y1="${src.y}" x2="${tgt.x}" y2="${tgt.y}" stroke="var(--line-strong)" stroke-width="1.5"/>`;
  }).join('');

  const nodesSvg = positionedNodes.map((n) => `
    <g class="graph-node-group" transform="translate(${n.x}, ${n.y})" tabindex="0" role="button" aria-label="${escape(n.title)}" data-node-id="${escape(n.id)}">
      <circle class="graph-node-circle" r="8"/>
      <text class="graph-node-label" y="20">${escape(n.title.slice(0, 16))}${n.title.length > 16 ? '…' : ''}</text>
    </g>
  `).join('');

  const accessibleTable = `
    <details class="knowledge-graph-details">
      <summary>Accessible Graph Edge List (${edges.length} edges)</summary>
      <ul>${edges.map((e) => `<li><strong>${escape(e.sourceId)}</strong> ${escape(e.relation)} <strong>${escape(e.targetId)}</strong> <small>(${escape(e.origin)})</small></li>`).join('')}</ul>
    </details>
  `;

  return `
    <svg class="knowledge-graph-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Knowledge Graph Visualization">
      ${edgesSvg}
      ${nodesSvg}
    </svg>
    <div class="graph-controls">
      <button type="button" id="graph-zoom-in" aria-label="Zoom in">+</button>
      <button type="button" id="graph-zoom-out" aria-label="Zoom out">−</button>
      <button type="button" id="graph-reset" aria-label="Reset view">Reset</button>
    </div>
    ${accessibleTable}
  `;
}

/**
 * MCP gateway status vocabulary. The runner status names are lowercase; the pill
 * classes reuse the workspace status palette so the console keeps one visual language.
 */
const MCP_STATUS = {
  connected: { label: 'Connected', className: 'active' },
  connecting: { label: 'Connecting', className: 'info' },
  disconnected: { label: 'Disconnected', className: '' },
  error: { label: 'Error', className: 'failed' },
  disabled: { label: 'Disabled', className: '' },
  // In-memory connection health is unknown until the API first contacts the server.
  unknown: { label: 'Not yet contacted', className: '' }
};

export function mcpStatusLabel(status) {
  return (MCP_STATUS[status] ?? MCP_STATUS.unknown).label;
}

export function mcpStatusClass(status) {
  return (MCP_STATUS[status] ?? MCP_STATUS.unknown).className;
}

/**
 * A downstream endpoint URL is operator-supplied. It is rendered as text only, and
 * userinfo, query, and fragment are dropped rather than echoed back into the page.
 */
function displayEndpoint(value) {
  if (typeof value !== 'string') return 'Unavailable';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return value; }
}

const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function renderMcpStatusPill(status) {
  const className = mcpStatusClass(status);
  return `<span class="status${className ? ` ${className}` : ''}">${escape(mcpStatusLabel(status))}</span>`;
}

/**
 * The single endpoint a user configures in an MCP client. The card names the
 * credential lane `/mcp-gateway` actually accepts and the two hard limitations an
 * operator hits first; the managed API-key lane is deliberately not shown as an option.
 */
function renderMcpGatewayCard(gateway) {
  const gatewayData = gateway ?? {};
  const endpoint = typeof gatewayData.publicUrl === 'string' && gatewayData.publicUrl
    ? gatewayData.publicUrl
    : (typeof gatewayData.endpoint === 'string' && gatewayData.endpoint ? gatewayData.endpoint : '/mcp-gateway');
  const lane = gatewayData.authMode === 'owner-bearer'
    ? 'Authenticates with your Cloud Harness owner bearer token.'
    : 'Authenticates with your Cloud Harness Access session.';
  return `
    <section class="panel mcp-gateway-card" aria-labelledby="mcp-gateway-heading">
      <h2 id="mcp-gateway-heading">Your Cloud Harness MCP Gateway</h2>
      <p class="mcp-endpoint"><span class="mono wrap">${escape(endpoint)}</span> <button type="button" class="copy" data-copy="${escape(endpoint)}">Copy</button></p>
      <p>Connect this single MCP endpoint to your AI client. Tools from your configured MCP servers are discovered and executed through Cloud Harness.</p>
      <p class="mcp-endpoint-lane">${escape(lane)} The managed API-key lane is not yet available for this endpoint.</p>
      <div class="page-note">
        <strong>Hard limitations.</strong>
        <ul>
          <li>HTTP redirects are refused. A vendor base URL that redirects must be configured as its final URL.</li>
          <li><code class="mono">stdio</code> downstream servers are unsupported; use <code class="mono">streamable-http</code> or <code class="mono">sse</code>.</li>
        </ul>
      </div>
    </section>
  `;
}

function mcpServerActions(server) {
  const id = escape(server.id);
  const generation = escape(server.generation);
  return `<div class="row-actions">
          <button class="mcp-edit" type="button" data-mcp-edit="${id}">Edit</button>
          <button class="mcp-toggle" type="button" data-mcp-toggle="${id}" data-next-enabled="${server.enabled ? 'false' : 'true'}" data-generation="${generation}">${server.enabled ? 'Disable' : 'Enable'}</button>
          <button class="mcp-test" type="button" data-mcp-test="${id}">Test</button>
          <button class="mcp-refresh" type="button" data-mcp-refresh="${id}">Refresh tools</button>
          <button class="danger mcp-delete" type="button" data-mcp-delete="${id}" data-generation="${generation}" data-mcp-name="${escape(server.name)}">Delete</button>
        </div>`;
}

export function renderMcpServersIndex(data) {
  const servers = Array.isArray(data?.servers) ? data.servers : (Array.isArray(data) ? data : []);
  const gateway = data?.gateway ?? data ?? {};
  const rows = servers.length ? servers.map((server) => `<tr>
        <th scope="row"><a href="/dashboard/mcp-servers/${encodeURIComponent(server.id)}">${escape(server.name)}</a><small class="mono wrap">${escape(server.id)}</small></th>
        <td class="mono">${escape(server.transport)}</td>
        <td>${renderMcpStatusPill(server.status)}</td>
        <td class="mono">${escape(count(server.toolCount))}</td>
        <td>${optionalTime(server.lastConnectedAt)}</td>
        <td>${server.enabled ? 'Enabled' : 'Disabled'}</td>
        <td>${mcpServerActions(server)}</td>
      </tr>`).join('') : '<tr><td colspan="7">No MCP servers configured.</td></tr>';
  const cards = servers.length ? servers.map((server) => {
    const details = `<dl><dt>Transport</dt><dd class="mono">${escape(server.transport)}</dd><dt>Status</dt><dd>${renderMcpStatusPill(server.status)}</dd><dt>Tools</dt><dd class="mono">${escape(count(server.toolCount))}</dd><dt>Last connected</dt><dd>${optionalTime(server.lastConnectedAt)}</dd><dt>Enabled</dt><dd>${server.enabled ? 'Enabled' : 'Disabled'}</dd></dl>`;
    return `<li><h3><a href="/dashboard/mcp-servers/${encodeURIComponent(server.id)}">${escape(server.name)}</a></h3>${details}${mcpServerActions(server)}</li>`;
  }).join('') : '<li class="empty"><h3>No MCP servers configured.</h3><p>Add a downstream MCP server to discover and execute its tools through Cloud Harness.</p></li>';
  return `
    ${renderMcpGatewayCard(gateway)}
    <div class="record-heading">
      <div><h2>MCP servers</h2><p>Downstream MCP integrations available to your signed-in identity.</p></div>
      <div class="row-actions"></div>
    </div>
    <section aria-labelledby="mcp-server-list-heading">
      <h2 id="mcp-server-list-heading" class="sr-only">MCP servers</h2>
      <div class="desktop-table">
        <table>
          <caption>${escape(servers.length)} MCP servers</caption>
          <thead><tr><th>Name</th><th>Transport</th><th>Status</th><th>Tools</th><th>Last connected</th><th>Enabled</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <ul class="mobile-list">${cards}</ul>
    </section>
  `;
}

function renderMcpOverviewPanel(server, gateway) {
  const description = server.description ? `<p class="wrap">${escape(server.description)}</p>` : '';
  const lastError = server.lastError ? `<p class="warning wrap">${escape(server.lastError)}</p>` : '';
  const headers = Array.isArray(server.headers) ? server.headers : [];
  const headerItems = headers.length ? headers.map((header) => {
    const reference = header.kind === 'secret'
      ? `<span class="mono wrap">${escape(header.secretRef)}</span> <span class="status">Write-only secret</span>`
      : `<span class="mono wrap">${escape(header.value ?? '')}</span>`;
    return `<li><strong class="mono">${escape(header.name)}</strong> ${reference}</li>`;
  }).join('') : '<li>No custom headers.</li>';
  return `
    <section class="panel" aria-labelledby="mcp-overview-heading">
      <h2 id="mcp-overview-heading">Overview</h2>
      ${description}
      <dl class="facts">
        <dt>Server ID</dt><dd class="mono wrap">${escape(server.id)}</dd>
        <dt>Transport</dt><dd class="mono">${escape(server.transport)}</dd>
        <dt>Endpoint</dt><dd class="wrap">${escape(displayEndpoint(server.endpoint))}</dd>
        <dt>Status</dt><dd>${renderMcpStatusPill(server.status)}</dd>
        <dt>Enabled</dt><dd>${server.enabled ? 'Enabled' : 'Disabled'}</dd>
        <dt>Tools</dt><dd class="mono">${escape(count(server.toolCount))}</dd>
        <dt>Last connected</dt><dd>${optionalTime(server.lastConnectedAt)}</dd>
        <dt>Last checked</dt><dd>${optionalTime(server.lastCheckedAt)}</dd>
        <dt>Default permission</dt><dd>${server.permissionDefault === 'deny' ? 'Deny' : 'Allow'}</dd>
        <dt>Generation</dt><dd class="mono">${escape(server.generation)}</dd>
      </dl>
      ${lastError}
      <h3>Headers</h3>
      <ul class="record-list">${headerItems}</ul>
    </section>
    ${renderMcpGatewayCard(gateway)}
  `;
}

function renderMcpToolsPanel(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const permission = (tool) => tool.permission === 'deny' ? '<span class="status failed">Deny</span>' : '<span class="status active">Allow</span>';
  const availability = (tool) => `<span class="status ${tool.availability === 'available' ? 'active' : 'failed'}">${escape(tool.availability === 'available' ? 'Available' : 'Unavailable')}</span>`;
  const schema = (tool) => `<details class="mcp-tool-detail"><summary>Input schema</summary><pre class="mono wrap">${escape(JSON.stringify(tool.inputSchema ?? {}, null, 2))}</pre></details>`;
  const rows = list.length ? list.map((tool) => `<tr>
        <th scope="row"><span class="mono wrap">${escape(tool.upstreamName)}</span><small class="mono wrap">${escape(tool.qualifiedName)}</small></th>
        <td class="wrap">${escape(tool.description ?? '')}</td>
        <td>${permission(tool)}</td>
        <td>${availability(tool)}</td>
        <td>${schema(tool)}</td>
      </tr>`).join('') : '<tr><td colspan="5">No tools discovered yet. Refresh tools to run discovery.</td></tr>';
  const cards = list.length ? list.map((tool) => `<li><h3 class="mono wrap">${escape(tool.upstreamName)}</h3><p class="wrap">${escape(tool.description ?? '')}</p><dl><dt>Permission</dt><dd>${permission(tool)}</dd><dt>Availability</dt><dd>${availability(tool)}</dd></dl>${schema(tool)}</li>`).join('') : '<li class="empty"><h3>No tools discovered yet.</h3><p>Refresh tools to run discovery.</p></li>';
  return `
    <section class="panel mcp-tools-panel" aria-labelledby="mcp-tools-heading">
      <h2 id="mcp-tools-heading">Tools</h2>
      <div class="inline-form">
        <label for="mcp-tool-search">Search tools</label>
        <input id="mcp-tool-search" name="q" type="search" autocomplete="off" spellcheck="false" placeholder="Filter by tool name or description">
        <button type="button" class="mcp-refresh" data-mcp-refresh>Refresh tools</button>
      </div>
      <div class="desktop-table">
        <table>
          <caption>${escape(list.length)} cached tools</caption>
          <thead><tr><th>Tool</th><th>Description</th><th>Permission</th><th>Availability</th><th>Schema</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <ul class="mobile-list">${cards}</ul>
    </section>
  `;
}

function renderMcpPermissionsPanel(server, tools) {
  const list = Array.isArray(tools) ? tools : [];
  const defaultDeny = server.permissionDefault === 'deny';
  const toolRows = list.length ? list.map((tool) => `<li class="permission-row"><label><span class="mono wrap">${escape(tool.upstreamName)}</span><select name="tool:${escape(tool.upstreamName)}"><option value="allow"${tool.permission === 'allow' ? ' selected' : ''}>Allow</option><option value="deny"${tool.permission === 'deny' ? ' selected' : ''}>Deny</option></select></label></li>`).join('') : '<li>No tools discovered yet. Refresh tools before setting per-tool overrides.</li>';
  return `
    <section class="panel" aria-labelledby="mcp-permissions-heading">
      <h2 id="mcp-permissions-heading">Permissions</h2>
      <p>Permissions apply to gateway execution. A deny-by-default server stays testable and refreshable.</p>
      <form id="mcp-permissions-form" class="stack-form">
        <input type="hidden" name="expectedGeneration" value="${escape(server.generation)}">
        <label for="mcp-permission-default">Server default</label>
        <select id="mcp-permission-default" name="permissionDefault"><option value="allow"${defaultDeny ? '' : ' selected'}>Allow</option><option value="deny"${defaultDeny ? ' selected' : ''}>Deny</option></select>
        <h3>Per-tool overrides</h3>
        <ul class="record-list mcp-permission-list">${toolRows}</ul>
        <div class="form-row-actions"><button type="submit" class="accent-btn">Save permissions</button></div>
        <p class="form-status" aria-live="polite"></p>
      </form>
    </section>
  `;
}

function renderMcpLogsPanel(traces, cursor) {
  const list = Array.isArray(traces) ? traces : [];
  const statusPill = (trace) => `<span class="status ${trace.status === 'success' ? 'active' : 'failed'}">${escape(trace.status)}</span>`;
  const detail = (trace) => `<details class="mcp-tool-detail"><summary>Detail</summary><pre class="mono wrap">${escape(JSON.stringify({ traceId: trace.id, operation: trace.operation, errorCode: trace.errorCode, errorMessage: trace.errorMessage, requestBytes: trace.requestBytes, responseBytes: trace.responseBytes }, null, 2))}</pre></details>`;
  const rows = list.length ? list.map((trace) => `<tr>
        <th scope="row">${time(trace.createdAt)}</th>
        <td class="mono wrap">${escape(trace.tool ?? trace.operation ?? '')}</td>
        <td class="mono wrap">${escape(trace.clientId ?? 'Unknown client')}</td>
        <td class="mono">${escape(count(trace.durationMs))} ms</td>
        <td>${statusPill(trace)}${detail(trace)}</td>
      </tr>`).join('') : '<tr><td colspan="5">No recorded gateway calls yet.</td></tr>';
  const cards = list.length ? list.map((trace) => `<li><h3>${time(trace.createdAt)}</h3><dl><dt>Tool</dt><dd class="mono wrap">${escape(trace.tool ?? trace.operation ?? '')}</dd><dt>Client</dt><dd class="mono wrap">${escape(trace.clientId ?? 'Unknown client')}</dd><dt>Duration</dt><dd class="mono">${escape(count(trace.durationMs))} ms</dd><dt>Status</dt><dd>${statusPill(trace)}</dd></dl>${detail(trace)}</li>`).join('') : '<li class="empty"><h3>No recorded gateway calls yet.</h3><p>Calls appear here after a client executes a tool.</p></li>';
  return `
    <section class="panel" aria-labelledby="mcp-logs-heading">
      <h2 id="mcp-logs-heading">Logs</h2>
      <p>Recent gateway calls for this server. Arguments, results, and credentials are never recorded here.</p>
      <div class="desktop-table">
        <table>
          <caption>${escape(list.length)} recorded calls</caption>
          <thead><tr><th>Time</th><th>Tool</th><th>Client</th><th>Duration</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <ul class="mobile-list">${cards}</ul>
      ${cursor ? `<button id="mcp-load-more-logs" type="button" data-cursor="${escape(cursor)}">Load more</button>` : ''}
    </section>
  `;
}

export function renderMcpServerDetail(server, tools, traces, activeTab = 'overview', cursor, gateway) {
  if (!server) return '<div class="empty"><h3>MCP server not found.</h3><p>It may have been deleted or belong to another identity.</p></div>';
  const tabs = [['overview', 'Overview'], ['tools', 'Tools'], ['permissions', 'Permissions'], ['logs', 'Logs']];
  const tabNav = `<div class="mcp-nav-tabs" role="tablist" aria-label="MCP server sections">${tabs.map(([key, label]) => `<button type="button" class="mcp-tab-btn${activeTab === key ? ' active' : ''}" data-mcp-tab="${key}" role="tab" aria-selected="${activeTab === key ? 'true' : 'false'}">${escape(label)}</button>`).join('')}</div>`;
  const toolCount = Array.isArray(tools) ? tools.length : count(server.toolCount);
  const panels = { overview: renderMcpOverviewPanel(server, gateway), tools: renderMcpToolsPanel(tools), permissions: renderMcpPermissionsPanel(server, tools), logs: renderMcpLogsPanel(traces, cursor) };
  return `
    <nav aria-label="Breadcrumb"><a href="/dashboard/mcp-servers">MCP servers</a><span>${escape(server.name)}</span></nav>
    <div class="record-heading">
      <div>
        <h2>${escape(server.name)}</h2>
        <div class="mcp-meta-bar">
          <span class="mono wrap">${escape(server.id)}</span>
          ${renderMcpStatusPill(server.status)}
          <span class="mono">${escape(server.transport)}</span>
          <span class="mono wrap">${escape(displayEndpoint(server.endpoint))}</span>
          <span>${server.enabled ? 'Enabled' : 'Disabled'}</span>
          <span class="mono">${escape(toolCount)} tools</span>
          ${time(server.lastConnectedAt ?? server.createdAt)}
        </div>
      </div>
      <div class="row-actions">
        <button class="mcp-edit" type="button" data-mcp-edit="${escape(server.id)}">Edit</button>
        <button class="mcp-toggle" type="button" data-mcp-toggle="${escape(server.id)}" data-next-enabled="${server.enabled ? 'false' : 'true'}" data-generation="${escape(server.generation)}">${server.enabled ? 'Disable' : 'Enable'}</button>
        <button class="mcp-test" type="button" data-mcp-test="${escape(server.id)}">Test</button>
        <button class="mcp-refresh" type="button" data-mcp-refresh="${escape(server.id)}">Refresh tools</button>
        <button class="danger mcp-delete" type="button" data-mcp-delete="${escape(server.id)}" data-generation="${escape(server.generation)}" data-mcp-name="${escape(server.name)}">Delete</button>
      </div>
    </div>
    ${tabNav}
    ${panels[activeTab] ?? panels.overview}
  `;
}

/**
 * Renders the command palette result list. Options must be direct children of the
 * `role="listbox"` element — a wrapper between them removes the options from the
 * accessibility tree. Every dynamic value passes through the local `escape`.
 */
export function renderPaletteResults(entries, activeIndex) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '<li class="palette-empty" role="presentation">No matching pages or resources.</li>';
  return list.map((entry, index) => {
    const selected = index === activeIndex;
    return `<li id="palette-opt-${index}" class="palette-option${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-palette-index="${index}" data-href="${escape(entry.href)}"><span class="palette-option-label">${escape(entry.label)}</span><span class="palette-option-group">${escape(entry.group)}</span><span class="palette-option-hint mono wrap">${escape(entry.hint)}</span></li>`;
  }).join('');
}
