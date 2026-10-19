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
    if (term && !`${workspace.repositoryUrl} ${workspace.workspaceId} ${repositoryAliases(workspace)}`.toLowerCase().includes(term)) return false;
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
  const rows = filtered.map((workspace) => `<tr><th scope="row"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a>${renderRepositoryCount(workspace)}<small class="mono">${escape(workspace.workspaceId)}</small></th><td><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span></td><td>${time(workspace.lastActivityAt)}</td><td>${time(workspace.expiresAt)}</td><td>${networkLabel(workspace.networkProfile)}</td></tr>`).join('');
  const cards = filtered.map((workspace) => `<li><h3><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a>${renderRepositoryCount(workspace)}</h3><dl><dt>State</dt><dd>${statusLabel(workspace.status)}</dd><dt>Last activity</dt><dd>${time(workspace.lastActivityAt)}</dd><dt>Expires</dt><dd>${time(workspace.expiresAt)}</dd></dl></li>`).join('');
  return `<h2 id="workspace-list-heading">Workspace list</h2><div class="desktop-table"><table><caption>${filtered.length} workspaces</caption><thead><tr><th>Repository</th><th>State</th><th>Last activity</th><th>Expires</th><th>Network</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

/** Contextual workspace sections. These are never global rail entries. */
export const WORKSPACE_TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'agents', label: 'Agents' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'automation', label: 'Automation' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'activity', label: 'Activity' }
];

const LIVE_WORKSPACE_TABS = new Set(['runtime', 'terminal', 'files', 'git', 'automation', 'deploy']);

/** The runner is the source of truth for lifecycle actions exposed to the browser. */
export function workspaceHasAction(workspace, action) {
  if (Array.isArray(workspace?.availableActions)) return workspace.availableActions.includes(action);
  // Compatibility fallback for an API/runner rolling upgrade.
  if (action === 'workspace_context') return workspace?.status === 'ACTIVE' || workspace?.status === 'NETWORK_QUARANTINED';
  if (action === 'workspace_lease_renew') return workspace?.status === 'ACTIVE' || workspace?.status === 'EXPIRED_RECOVERABLE';
  if (action === 'workspace_finalize') return workspace?.status === 'ACTIVE';
  if (action === 'workspace_recover') return workspace?.status === 'EXPIRED_RECOVERABLE' || workspace?.status === 'NETWORK_QUARANTINED';
  if (action === 'workspace_close') return !['CLOSED', 'FAILED'].includes(workspace?.status);
  if (action === 'workspace_open') return workspace?.status === 'CLOSED' || workspace?.status === 'FAILED';
  return false;
}

/** Tabs backed by executor/filesystem operations are meaningful only while the workspace is ACTIVE. */
export function workspaceTabAvailable(workspace, tab) {
  return !LIVE_WORKSPACE_TABS.has(tab) || workspace?.status === 'ACTIVE';
}

export function renderWorkspaceUnavailableTab(workspace, tab) {
  const label = WORKSPACE_TABS.find((item) => item.id === tab)?.label ?? 'Workspace';
  const status = statusLabel(workspace?.status);
  const detail = workspace?.status === 'FAILED'
    ? 'Setup failed before the workspace became active, and its temporary checkout has already been cleaned up. Review runner logs, fix the setup failure, then open a new workspace.'
    : workspace?.status === 'CLOSED'
      ? 'This workspace is closed and its checkout is no longer available. Open a new workspace to continue.'
      : workspace?.status === 'EXPIRED_RECOVERABLE'
        ? 'This workspace is in recoverable grace state. Recover it before using live runtime, filesystem, Git, automation, or deployment operations.'
        : workspace?.status === 'NETWORK_QUARANTINED'
          ? 'This workspace is quarantined. Reconcile the network policy and recover it before using this live operation.'
          : 'This workspace is not active yet. Wait for its lifecycle state to settle before using this live operation.';
  return '<section class="panel" aria-labelledby="workspace-tab-unavailable-heading">'
    + '<h2 id="workspace-tab-unavailable-heading">' + escape(label) + '</h2>'
    + '<p class="page-note"><strong>' + escape(label) + ' is unavailable while the workspace is ' + escape(status) + '.</strong> ' + escape(detail) + '</p>'
    + '</section>';
}

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
  if (workspace?.status === 'FAILED') reasons.push({ id: 'failed', label: 'Workspace setup failed', detail: 'The temporary checkout was cleaned up. Review the failure, fix the cause, then open a new workspace.' });
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
  const closeAllowed = workspaceHasAction(workspace, 'workspace_close');
  const canClose = closeAllowed && Number.isSafeInteger(generation) && generation > 0;
  const canRenew = workspaceHasAction(workspace, 'workspace_lease_renew');
  const canFinalize = workspaceHasAction(workspace, 'workspace_finalize');
  const canRecover = workspaceHasAction(workspace, 'workspace_recover');
  const canOpen = workspaceHasAction(workspace, 'workspace_open');
  const primaryActions = `${canRenew ? '<button id="renew-workspace-lease" class="accent-btn" type="button">Renew lease</button>' : ''}${canFinalize ? '<button id="finalize-workspace" type="button" data-dialog="finalize-workspace-dialog">Finalize workspace</button>' : ''}`;
  const secondaryActions = `${canRecover ? '<button id="recover-workspace" type="button">Recover workspace</button>' : ''}${closeAllowed ? `<button id="close-workspace" class="danger" type="button"${canClose ? '' : ' disabled'}>Close workspace</button>` : ''}`;
  const actions = canOpen
    ? '<div class="cockpit-actions"><a class="secondary button" href="/dashboard/workspaces">Open new workspace</a></div>'
    : `<div class="cockpit-actions">${primaryActions}${secondaryActions ? `<details class="row-edit"><summary>More actions</summary>${secondaryActions}</details>` : ''}</div>`;
  return `<div class="cockpit-header"><div class="record-heading"><div><h2 id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</h2><p>${renderCopyChip({ value: workspace.workspaceId, label: 'Workspace ID' })}</p></div><span class="status ${escape(String(workspace.status ?? '').toLowerCase())}">${escape(statusLabel(workspace.status))}</span></div><dl class="facts"><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd>${renderRepositoryFacts(workspace)}<dt>Network</dt><dd>${escape(networkLabel(workspace.networkProfile))}</dd><dt>Lease</dt><dd class="lease-${escape(lease.state)}">${escape(lease.label)}</dd><dt>Attention</dt><dd>${attention.length ? `${escape(attention.length)} item(s) need action` : 'Nothing needs attention'}</dd></dl>${actions}</div>`;
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

/**
 * Dashboard Terminal states, in the words the status line uses. The runner's lifecycle states map one to
 * one; `connecting`, `lost` and `error` are browser-side states. `lost` is the runner answering NOT_FOUND:
 * the PTY is gone (closed, timed out, or lost to a runner restart) and is never silently reconnected.
 */
export const TERMINAL_LOST_MESSAGE = 'This terminal is no longer available — it was closed, timed out, or the runner restarted. Terminals are not resumed after a runner restart.';
/** Moves keyboard focus out of the emulator; Tab and Escape themselves belong to the shell. */
export const TERMINAL_RELEASE_SHORTCUT = 'Ctrl+Shift+F6';

export function terminalStatusLabel(state = {}) {
  const phase = String(state.phase ?? state.status ?? 'idle');
  if (phase === 'connecting') return 'Connecting…';
  if (phase === 'running') return 'Running';
  if (phase === 'exited') return Number.isInteger(state.exitCode) ? `Exited (code ${state.exitCode})` : 'Exited';
  if (phase === 'closed') return 'Closed';
  if (phase === 'timed_out') return 'Timed out';
  if (phase === 'failed') return 'Failed';
  if (phase === 'lost') return 'No longer available';
  if (phase === 'error') return 'Could not connect';
  return 'Not started';
}

/** The sentence under the pill: what happened and what the operator can do next. */
export function terminalStatusDetail(state = {}) {
  const phase = String(state.phase ?? 'idle');
  if (phase === 'lost') return state.message ?? TERMINAL_LOST_MESSAGE;
  if (phase === 'timed_out') return 'The terminal reached its idle or lifetime limit and was ended. Start a new session to continue.';
  if (phase === 'failed') return `The terminal could not be kept running${state.terminal?.endReason ? `: ${state.terminal.endReason}` : '.'} Start a new session to continue.`;
  if (phase === 'exited') return 'The shell ended. Start a new session to continue.';
  if (phase === 'closed') return 'This terminal was closed. Start a new session to continue.';
  if (phase === 'error') return state.message ? `${state.message}` : 'The terminal could not be opened.';
  if (phase === 'connecting') return 'Opening a shell in this workspace.';
  if (phase === 'running') return state.message ?? '';
  return 'Open a terminal to run commands in this workspace.';
}

const terminalAge = (value, now) => {
  const started = Date.parse(value ?? '');
  if (!Number.isFinite(started)) return 'Unknown';
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
const terminalTime = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? time(value) : 'Unknown');
const terminalSize = (terminal) => (Number.isInteger(terminal?.cols) && Number.isInteger(terminal?.rows) ? `${terminal.cols}×${terminal.rows}` : 'Unknown');

/**
 * The cockpit Terminal tab. The emulator mounts into `#terminal-surface` only after the operator opens or
 * re-attaches a session, so visiting the tab never starts a shell by itself. Running terminals of this
 * workspace are offered for re-attach: output is replayed from the runner's bounded retention.
 */
export function renderTerminalPanel({ workspaceId = '', terminals = [], now = Date.now() } = {}) {
  const running = terminals.filter((terminal) => terminal?.status === 'running');
  const offers = running.length
    ? `<div id="terminal-reattach" class="terminal-reattach"><h3 id="terminal-reattach-heading">Running terminals</h3><p class="page-note">These shells are still running in this workspace. Re-attach to continue one; recent output is replayed.</p><ul class="record-list" aria-labelledby="terminal-reattach-heading">${running.map((terminal) => `<li><span><span class="mono">${escape(terminal.terminalId)}</span> <small>${escape(terminalSize(terminal))} · started ${escape(terminalAge(terminal.createdAt, now))} ago · idle expiry ${terminalTime(terminal.idleExpiresAt)}</small></span><button class="reattach-terminal" type="button" data-terminal-id="${escape(terminal.terminalId)}">Re-attach</button></li>`).join('')}</ul></div>`
    : '';
  return `<section id="terminal-panel" class="panel terminal-panel" aria-labelledby="terminal-heading" data-workspace-id="${escape(workspaceId)}">`
    + '<h2 id="terminal-heading">Terminal</h2>'
    + `<p class="page-note">An interactive shell inside this workspace's executor, with the same limits as agent commands. Keys typed in the terminal go to the shell, including Tab and Escape; press <kbd>${escape(TERMINAL_RELEASE_SHORTCUT)}</kbd> to move focus out of the terminal. <a href="/dashboard/terminals">All terminals</a></p>`
    + '<div class="terminal-toolbar">'
    + `<p class="terminal-status" role="status" aria-live="polite"><span id="terminal-state" class="status idle">${escape(terminalStatusLabel({ phase: 'idle' }))}</span> <span id="terminal-detail">${escape(terminalStatusDetail({ phase: 'idle' }))}</span></p>`
    + '<div class="row-actions"><button id="terminal-close" class="danger" type="button" disabled>Close</button><button id="terminal-new" class="accent-btn" type="button">New session</button></div>'
    + '</div>'
    + offers
    + '<div id="terminal-surface" class="terminal-surface" role="group" aria-label="Terminal" hidden></div>'
    + '</section>';
}

/**
 * The operator view: every live terminal across the principal's workspaces. Close confirms in the shared
 * dialog first; only a running terminal can be closed.
 */
export function renderTerminalsIndex({ terminals = [], workspaces = [], now = Date.now() } = {}) {
  const names = new Map(workspaces.map((workspace) => [workspace.workspaceId, repositoryName(workspace.repositoryUrl)]));
  if (!terminals.length) return '<section class="panel" aria-labelledby="terminals-heading"><h2 id="terminals-heading">Terminals</h2><div class="empty"><h3>No terminals are running.</h3><p>Open one from a workspace\'s Terminal tab.</p></div></section>';
  const workspaceLink = (terminal) => `<a href="/dashboard/workspaces/${encodeURIComponent(terminal.workspaceId)}/terminal">${escape(names.get(terminal.workspaceId) ?? terminal.workspaceId)}</a>`;
  const closeButton = (terminal) => `<button class="danger close-terminal" type="button" data-terminal-id="${escape(terminal.terminalId)}" data-workspace-id="${escape(terminal.workspaceId)}"${terminal.status === 'running' ? '' : ' disabled'}>Close</button>`;
  const pill = (terminal) => `<span class="status ${escape(String(terminal.status ?? 'unknown'))}">${escape(terminalStatusLabel({ phase: terminal.status, exitCode: terminal.exitCode }))}</span>`;
  const rows = terminals.map((terminal) => `<tr><th scope="row">${workspaceLink(terminal)}<small class="mono">${escape(terminal.terminalId)}</small></th><td>${pill(terminal)}</td><td>${escape(terminalSize(terminal))}</td><td>${escape(terminalAge(terminal.createdAt, now))}</td><td>${terminalTime(terminal.idleExpiresAt)}</td><td><div class="row-actions">${closeButton(terminal)}</div></td></tr>`).join('');
  const cards = terminals.map((terminal) => `<li><h3>${workspaceLink(terminal)}</h3><p class="mono">${escape(terminal.terminalId)}</p><dl><dt>Status</dt><dd>${pill(terminal)}</dd><dt>Size</dt><dd>${escape(terminalSize(terminal))}</dd><dt>Age</dt><dd>${escape(terminalAge(terminal.createdAt, now))}</dd><dt>Idle expiry</dt><dd>${terminalTime(terminal.idleExpiresAt)}</dd></dl><div class="row-actions">${closeButton(terminal)}</div></li>`).join('');
  return `<section class="panel" aria-labelledby="terminals-heading"><h2 id="terminals-heading">Terminals</h2><p class="page-note">Terminals live in runner memory: they end on idle expiry, at their lifetime limit, or when the runner restarts, and are never resumed. Ended terminals stay listed briefly so their final status can be read.</p><div class="desktop-table"><table><caption>${terminals.length} terminal(s)</caption><thead><tr><th>Workspace</th><th>Status</th><th>Size</th><th>Age</th><th>Idle expiry</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul></section>`;
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
/**
 * The runner lists grants in every state with uppercase statuses. Only an unexpired PENDING grant
 * can still be decided, so only it reads as pending, offers the two decisions, and counts toward the badge.
 */
const GRANT_STATUS_LABELS = { PENDING: ['Pending', 'pending'], APPROVED: ['Approved', 'approved'], REJECTED: ['Rejected', 'rejected'], CONSUMED: ['Used', 'consumed'], EXPIRED: ['Expired', 'expired'] };
export function grantIsActionable(grant, now = Date.now()) {
  if (String(grant?.status ?? '').toUpperCase() !== 'PENDING') return false;
  const expiresAt = Date.parse(String(grant?.expiresAt ?? ''));
  return Number.isNaN(expiresAt) || expiresAt > now;
}
export function renderApprovals({ grants = [], plans = [], packages = { enabled: false }, now = Date.now() } = {}) {
  const rows = grants.length
    ? grants.map((grant) => {
      const id = String(grant.id ?? '');
      const actionable = grantIsActionable(grant, now);
      const status = String(grant.status ?? '').toUpperCase();
      const [label, tone] = actionable ? GRANT_STATUS_LABELS.PENDING : status === 'PENDING' ? GRANT_STATUS_LABELS.EXPIRED : GRANT_STATUS_LABELS[status] ?? ['Unknown', 'unknown'];
      const actions = actionable ? `<div class="row-actions"><button class="accent-btn approve-grant" type="button" data-grant-id="${escape(id)}">Approve</button><button class="danger reject-grant" type="button" data-grant-id="${escape(id)}">Reject</button></div>` : '';
      return `<li class="panel approval-row"><div class="record-heading"><div><h3>${escape(String(grant.command ?? 'Requested operation'))}</h3><p class="mono wrap">${escape(String(grant.workspaceId ?? 'Workspace not reported'))}</p></div><span class="status ${tone}">${label}</span></div><dl class="facts"><dt>Requested</dt><dd>${grant.createdAt ? time(grant.createdAt) : 'Not reported'}</dd><dt>Expires</dt><dd>${grant.expiresAt ? time(grant.expiresAt) : 'Not reported'}</dd><dt>Working directory</dt><dd class="mono wrap">${escape(String(grant.cwd ?? 'Not reported'))}</dd><dt>Command digest</dt><dd class="mono wrap">${escape(String(grant.commandSha256 ?? 'Not reported'))}</dd></dl>${actions}</li>`;
    }).join('')
    : '<li class="empty"><h3>No approvals are waiting.</h3><p>Privilege requests appear here while they are pending. Decided and expired requests stay listed briefly, without actions.</p></li>';
  return `${renderResourcePage({
    note: '<div class="page-note"><strong>Privilege grants.</strong> Approving lets one command run in a workspace under your identity. Both decisions are audited.</div>',
    body: `<section aria-labelledby="approvals-heading"><h2 id="approvals-heading">Privilege requests</h2><ul class="record-list approval-list">${rows}</ul></section>${renderPackagePlans({ plans, enabled: packages.enabled === true, approvalMode: packages.approvalMode, now })}`
  })}`;
}

/*
 * Managed toolbox packages. Plans are decided on the Approvals page; installed releases, applies,
 * and rollback live on the Packages page. A plan approval is bound to its digest, so the digest the
 * operator sees is the one the approve action posts.
 */
export const PACKAGES_DISABLED_COPY = 'Managed packages are off. Operators enable them with PACKAGES_ENABLED=true.';
const PLAN_STATUS_LABELS = {
  PENDING_APPROVAL: ['Pending', 'pending'], APPROVED: ['Approved, awaiting apply', 'approved'], REJECTED: ['Rejected', 'rejected'],
  EXPIRED: ['Expired', 'expired'], CONSUMED: ['Applied', 'consumed']
};
const APPLY_STEPS = ['QUEUED', 'BUILDING', 'VERIFYING', 'PUBLISHING'];
const APPLY_STEP_LABELS = { QUEUED: 'Queued', BUILDING: 'Building', VERIFYING: 'Verifying', PUBLISHING: 'Publishing', SUCCEEDED: 'Succeeded', FAILED: 'Failed' };
const ECOSYSTEM_LABELS = { npm: 'npm', uv: 'Python (uv)' };

/** Binary units, because quotas are configured in powers of two. */
export function formatPackageBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${unit === 0 ? amount : amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** The leading and trailing characters identify a digest at a glance; the full value stays one focus away. */
export function shortDigest(value) {
  const digest = String(value ?? '');
  return digest.length > 20 ? `${digest.slice(0, 12)}…${digest.slice(-6)}` : digest;
}

function digestMarkup(value, label) {
  const digest = String(value ?? '');
  if (!digest) return 'Not reported';
  return `<code class="digest" tabindex="0" title="${escape(`${label}: ${digest}`)}"><span class="digest-short" aria-hidden="true">${escape(shortDigest(digest))}</span><span class="digest-full">${escape(digest)}</span></code>`;
}

const scopeLabel = (scope, workspaceId) => scope === 'workspace'
  ? `Workspace <span class="mono wrap">${escape(String(workspaceId ?? 'not reported'))}</span>`
  : 'Owner (every workspace)';
const workspaceCount = (ids) => {
  const count = Array.isArray(ids) ? ids.length : 0;
  return `${count} ${count === 1 ? 'workspace' : 'workspaces'}`;
};
const runtimeText = (runtime) => {
  if (!runtime || typeof runtime !== 'object') return 'Not reported';
  const parts = [['Node', runtime.node], ['npm', runtime.npm], ['Python', runtime.python], ['uv', runtime.uv]]
    .filter(([, version]) => typeof version === 'string' && version)
    .map(([name, version]) => `${name} ${version}`);
  return parts.length ? parts.join(' · ') : 'Not reported';
};
const listText = (values, empty) => Array.isArray(values) && values.length ? values.map((value) => escape(String(value))).join(', ') : empty;

/** Only an unexpired plan still waiting for a decision offers Approve and counts toward the badge. */
export function planIsActionable(plan, now = Date.now()) {
  if (String(plan?.status ?? '') !== 'PENDING_APPROVAL') return false;
  const expiresAt = Date.parse(String(plan?.expiresAt ?? ''));
  return Number.isNaN(expiresAt) || expiresAt > now;
}

/** An approved plan that is not yet applied can still be withdrawn. */
const planIsWithdrawable = (plan, now) => String(plan?.status ?? '') === 'APPROVED'
  && (Number.isNaN(Date.parse(String(plan?.expiresAt ?? ''))) || Date.parse(String(plan.expiresAt)) > now);

function planRisks(plan) {
  const risks = [];
  if (plan.lifecycleScripts) risks.push('Runs npm lifecycle scripts while building. Install scripts execute package code in the builder.');
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
  if (conflicts.length) {
    risks.push(`Binary name collisions: ${conflicts.map((conflict) => `${conflict.binary} (already provided by ${conflict.name}${conflict.scope === 'workspace' ? ' in a workspace' : ''})`).join(', ')}. The apply is refused until they are resolved.`);
  }
  if (plan.stale) risks.push('The package changed after this plan was made. Approval will be refused; create a new plan.');
  return risks;
}

function renderPlanRow(plan, now) {
  const planId = String(plan.planId ?? '');
  const actionable = planIsActionable(plan, now);
  const status = String(plan.status ?? '');
  const expiredOpen = (status === 'PENDING_APPROVAL' || status === 'APPROVED') && !actionable && !planIsWithdrawable(plan, now);
  const [label, tone] = expiredOpen ? PLAN_STATUS_LABELS.EXPIRED : PLAN_STATUS_LABELS[status] ?? ['Unknown', 'unknown'];
  const name = String(plan.name ?? 'package');
  const version = String(plan.version ?? '');
  const current = plan.currentRelease;
  const compare = current
    ? `<p class="package-compare"><span>Current <strong>${escape(String(current.version ?? 'unknown'))}</strong></span><span aria-hidden="true">→</span><span>Planned <strong>${escape(version)}</strong></span></p>`
    : `<p class="package-compare"><span>New install</span><span aria-hidden="true">→</span><span>Planned <strong>${escape(version)}</strong></span></p>`;
  const risks = planRisks(plan);
  const riskMarkup = risks.length ? `<ul class="package-risks" aria-label="Risks for ${escape(name)}">${risks.map((risk) => `<li>${escape(risk)}</li>`).join('')}</ul>` : '';
  const source = plan.source && typeof plan.source === 'object' ? plan.source : {};
  const actionData = `data-plan-id="${escape(planId)}" data-plan-digest="${escape(String(plan.planDigest ?? ''))}" data-plan-name="${escape(`${name}@${version}`)}"`;
  const actions = actionable
    ? `<div class="row-actions"><button class="accent-btn approve-plan" type="button" ${actionData}>Approve</button><button class="danger reject-plan" type="button" ${actionData}>Reject</button></div>`
    : planIsWithdrawable(plan, now) ? `<div class="row-actions"><button class="danger reject-plan" type="button" ${actionData}>Withdraw approval</button></div>` : '';
  return `<li class="panel approval-row package-plan"><div class="record-heading"><div><h3>${escape(name)}<span class="package-version">@${escape(version)}</span></h3><p>${escape(ECOSYSTEM_LABELS[plan.ecosystem] ?? String(plan.ecosystem ?? ''))} · ${scopeLabel(plan.scope, plan.workspaceId)}</p></div><span class="status ${tone}">${escape(label)}</span></div>${compare}${riskMarkup}<dl class="facts"><dt>Plan digest</dt><dd>${digestMarkup(plan.planDigest, 'Plan digest')}</dd><dt>Requested</dt><dd class="mono wrap">${escape(String(plan.requestedSpec ?? version))}</dd><dt>Source</dt><dd class="mono wrap">${escape(String(source.resolved ?? source.registry ?? 'Not reported'))}</dd><dt>Integrity</dt><dd>${plan.integrity ? digestMarkup(plan.integrity, 'Integrity') : 'Not reported by the registry'}</dd><dt>Dependencies</dt><dd>${escape(String(plan.dependencyCount ?? 'Not reported'))}</dd><dt>Estimated size</dt><dd>${escape(formatPackageBytes(plan.sizeEstimateBytes))}</dd><dt>Binaries</dt><dd class="mono wrap">${listText(plan.binaries, 'None')}</dd><dt>Lifecycle scripts</dt><dd>${plan.lifecycleScripts ? 'Allowed' : 'Not run'}</dd><dt>Affected</dt><dd>${escape(workspaceCount(plan.affectedWorkspaces))}</dd><dt>Runtime</dt><dd>${escape(runtimeText(plan.runtime))}</dd><dt>Created</dt><dd>${plan.createdAt ? time(plan.createdAt) : 'Not reported'}</dd><dt>Expires</dt><dd>${plan.expiresAt ? time(plan.expiresAt) : 'Not reported'}</dd>${plan.decidedBy ? `<dt>Decided by</dt><dd>${plan.decidedBy === 'policy' ? 'Policy (approval not required)' : 'Dashboard'}</dd>` : ''}</dl>${actions}</li>`;
}

/** The "Package plans" section of the Approvals page. */
export function renderPackagePlans({ plans = [], enabled = true, approvalMode = 'required', now = Date.now() } = {}) {
  if (!enabled) {
    return `<section aria-labelledby="package-plans-heading"><h2 id="package-plans-heading">Package plans</h2><p class="empty-note">${escape(PACKAGES_DISABLED_COPY)}</p></section>`;
  }
  const modeNote = approvalMode === 'not_required'
    ? '<div class="page-note"><strong>Approval not required.</strong> PACKAGES_APPROVAL_MODE=none, so plans are approved by policy and listed here for the record.</div>'
    : approvalMode === 'unavailable'
      ? '<div class="page-note"><strong>Approval unavailable.</strong> This runner cannot record Dashboard approvals, so applies are refused until PACKAGES_APPROVAL_MODE=none.</div>'
      : '<div class="page-note"><strong>Package plans.</strong> Approving lets an agent apply exactly the plan whose digest is shown. A changed plan is refused. Both decisions are audited.</div>';
  const rows = plans.length
    ? plans.map((plan) => renderPlanRow(plan, now)).join('')
    : '<li class="empty"><h3>No package plans are waiting.</h3><p>An agent creates a plan with packages_plan. It appears here until it is decided, applied, or expires.</p></li>';
  return `<section aria-labelledby="package-plans-heading"><h2 id="package-plans-heading">Package plans</h2>${modeNote}<ul class="record-list approval-list">${rows}</ul></section>`;
}

function releaseHealth(release) {
  if (!release) return ['Missing release', 'failed'];
  if (release.status === 'MISSING') return ['Missing on disk', 'failed'];
  if (release.stale) return ['Stale image', 'stale'];
  if (release.status === 'VERIFIED') return ['Verified', 'healthy'];
  return [String(release.status ?? 'Unknown'), 'unknown'];
}

function applySteps(state) {
  const failed = state === 'FAILED';
  const reached = state === 'SUCCEEDED' ? APPLY_STEPS.length : APPLY_STEPS.indexOf(state);
  return `<ol class="package-steps" aria-label="Apply progress">${APPLY_STEPS.map((step, index) => {
    const done = index < reached;
    const currentStep = index === reached && !failed;
    return `<li class="${done ? 'done' : currentStep ? 'current' : ''}"${currentStep ? ' aria-current="step"' : ''}>${escape(APPLY_STEP_LABELS[step])}</li>`;
  }).join('')}</ol>`;
}

function applyRow(apply, live) {
  const state = String(apply.state ?? '');
  const tone = state === 'SUCCEEDED' ? 'succeeded' : state === 'FAILED' ? 'failed' : 'running';
  const title = apply.name ? `${apply.name}@${apply.version ?? ''}` : String(apply.applyId ?? 'Apply');
  const error = state === 'FAILED' ? `<p class="status-error">${escape(String(apply.errorCode ?? 'FAILED'))}${apply.errorMessage ? `: ${escape(String(apply.errorMessage))}` : ''}</p>` : '';
  return `<li class="panel package-apply"><div class="record-heading"><div><h3>${escape(title)}</h3><p class="mono wrap">${escape(String(apply.applyId ?? ''))}</p></div><span class="status ${tone}">${escape(APPLY_STEP_LABELS[state] ?? state)}</span></div>${live ? applySteps(state) : ''}${error}<dl class="facts"><dt>Started</dt><dd>${apply.createdAt ? time(apply.createdAt) : 'Not reported'}</dd><dt>${apply.finishedAt ? 'Finished' : 'Updated'}</dt><dd>${time(apply.finishedAt ?? apply.updatedAt ?? apply.createdAt)}</dd></dl></li>`;
}

function historyTable(binding) {
  const history = Array.isArray(binding.history) ? binding.history : [];
  if (!history.length) return '<p class="empty-note">No history yet.</p>';
  const currentId = binding.release?.releaseId;
  const rows = history.map((entry) => {
    const isCurrent = entry.releaseId === currentId;
    const action = isCurrent
      ? '<span class="status active">Current</span>'
      : entry.available
        ? `<button class="danger rollback-package" type="button" data-binding-id="${escape(String(binding.bindingId ?? ''))}" data-release-id="${escape(String(entry.releaseId ?? ''))}" data-generation="${escape(String(binding.generation ?? ''))}" data-package="${escape(String(binding.name ?? ''))}" data-from-version="${escape(String(binding.release?.version ?? 'unknown'))}" data-to-version="${escape(String(entry.version ?? 'unknown'))}" data-affected="${escape(String(Array.isArray(binding.affectedWorkspaces) ? binding.affectedWorkspaces.length : 0))}">Roll back to ${escape(String(entry.version ?? 'this release'))}</button>`
        : '<span class="status">Unavailable</span>';
    return `<tr><th scope="row">${escape(String(entry.version ?? 'Unknown'))}<small class="mono wrap">${escape(String(entry.releaseId ?? ''))}</small></th><td>${escape(String(entry.generation ?? ''))}</td><td>${entry.reason === 'rollback' ? 'Rollback' : 'Apply'} · ${entry.actor === 'dashboard' ? 'Dashboard' : 'Agent'}</td><td>${entry.createdAt ? time(entry.createdAt) : 'Not reported'}</td><td>${action}</td></tr>`;
  }).join('');
  return `<div class="package-table package-history"><table><caption>History of ${escape(String(binding.name ?? 'this package'))}</caption><thead><tr><th scope="col">Version</th><th scope="col">Generation</th><th scope="col">Change</th><th scope="col">When</th><th scope="col">Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function bindingRow(binding, releases) {
  const release = binding.release ?? null;
  const detail = releases.find((candidate) => candidate.releaseId === release?.releaseId) ?? release ?? {};
  const [health, tone] = releaseHealth(release);
  const risks = [];
  if (detail.lifecycleScripts) risks.push('Built with npm lifecycle scripts enabled.');
  if (release?.status === 'MISSING') risks.push('The release directory is missing. New workspaces start without this tool until it is re-applied or rolled back.');
  if (release?.stale) risks.push('Built against an older executor image. Re-plan and apply to rebuild it.');
  const riskMarkup = risks.length ? `<ul class="package-risks" aria-label="Risks for ${escape(String(binding.name ?? ''))}">${risks.map((risk) => `<li>${escape(risk)}</li>`).join('')}</ul>` : '';
  return `<li class="panel package-binding"><div class="record-heading"><div><h3>${escape(String(binding.name ?? 'package'))}<span class="package-version">@${escape(String(release?.version ?? 'unknown'))}</span></h3><p>${escape(ECOSYSTEM_LABELS[binding.ecosystem] ?? String(binding.ecosystem ?? ''))} · ${scopeLabel(binding.scope, binding.workspaceId)}</p></div><span class="status ${tone}">${escape(health)}</span></div>${riskMarkup}<dl class="facts"><dt>Active release</dt><dd class="mono wrap">${escape(String(release?.releaseId ?? 'None'))}</dd><dt>Generation</dt><dd>${escape(String(binding.generation ?? ''))}</dd><dt>Disk usage</dt><dd>${escape(formatPackageBytes(detail.sizeBytes))}${Number.isFinite(detail.fileCount) && detail.fileCount > 0 ? ` · ${escape(String(detail.fileCount))} files` : ''}</dd><dt>Dependencies</dt><dd>${escape(String(detail.dependencyCount ?? 'Not reported'))}</dd><dt>Binaries</dt><dd class="mono wrap">${listText(release?.binaries, 'None')}</dd><dt>Source</dt><dd class="mono wrap">${escape(String(detail.source?.resolved ?? detail.source?.registry ?? 'Not reported'))}</dd><dt>Tree digest</dt><dd>${digestMarkup(release?.treeDigest, 'Tree digest')}</dd><dt>Runtime</dt><dd>${escape(runtimeText(detail.runtime))}</dd><dt>Affected</dt><dd>${escape(workspaceCount(binding.affectedWorkspaces))}</dd><dt>Installed</dt><dd>${release?.createdAt ? time(release.createdAt) : 'Not reported'}</dd></dl><div class="row-actions"><button class="danger remove-package" type="button" data-binding-id="${escape(String(binding.bindingId ?? ''))}" data-generation="${escape(String(binding.generation ?? ''))}" data-package="${escape(String(binding.name ?? ''))}" data-scope="${escape(String(binding.scope ?? ''))}" data-affected="${escape(String(Array.isArray(binding.affectedWorkspaces) ? binding.affectedWorkspaces.length : 0))}">Uninstall ${escape(String(binding.name ?? 'package'))}</button></div>${historyTable(binding)}</li>`;
}

export function renderPackages({ overview = {}, now = Date.now() } = {}) {
  if (!overview.enabled) {
    return renderResourcePage({
      note: `<div class="page-note"><strong>Managed packages are off.</strong> Operators enable them with PACKAGES_ENABLED=true.</div>`,
      body: '<ul class="record-list"><li class="empty"><h3>No managed packages.</h3><p>When the feature is on, agents plan installs with packages_plan and you approve them on the Approvals page.</p></li></ul>'
    });
  }
  const bindings = Array.isArray(overview.bindings) ? overview.bindings : [];
  const releases = Array.isArray(overview.releases) ? overview.releases : [];
  const inFlight = Array.isArray(overview.inFlight) ? overview.inFlight : [];
  const recent = Array.isArray(overview.recentApplies) ? overview.recentApplies : [];
  const pending = (Array.isArray(overview.pendingPlans) ? overview.pendingPlans : []).filter((plan) => planIsActionable(plan, now));
  const quotas = overview.quotas ?? {};
  const usage = overview.usage ?? {};
  const approval = overview.approvalMode === 'not_required' ? 'Not required (policy)' : overview.approvalMode === 'unavailable' ? 'Unavailable' : 'Required';
  const tiles = [
    ['Installed', `${Number(usage.bindings ?? bindings.length)} / ${escape(String(quotas.maxBindings ?? '?'))}`, 'Bindings in use'],
    ['Disk used', escape(formatPackageBytes(usage.ownerBytes)), `of ${escape(formatPackageBytes(quotas.maxOwnerBytes))} quota`],
    ['Applies running', String(inFlight.length), 'Builds in progress'],
    ['Plans waiting', String(pending.length), pending.length ? 'Review on Approvals' : 'Nothing to decide', pending.length ? '/dashboard/approvals' : '']
  ].map(([label, value, note, href]) => {
    const body = `<span class="metric-label">${escape(label)}</span><span class="metric-value">${value}</span><span class="metric-note">${note}</span>`;
    return `<li class="metric">${href ? `<a href="${href}">${body}</a>` : body}</li>`;
  }).join('');
  const note = `<div class="page-note"><strong>Managed packages.</strong> Approval: ${escape(approval)}. Ecosystems: ${escape((overview.ecosystems ?? []).join(', ') || 'none')}. npm lifecycle scripts: ${overview.lifecycleScripts === 'allow' ? 'allowed on request' : 'denied'}. Per-release limit ${escape(formatPackageBytes(quotas.maxReleaseBytes))}. A change reaches a running workspace only when it is recreated.</div>`;
  const inFlightSection = `<section aria-labelledby="package-applies-heading"><h2 id="package-applies-heading">Applies</h2><ul class="record-list">${inFlight.length || recent.length
    ? `${inFlight.map((apply) => applyRow(apply, true)).join('')}${recent.map((apply) => applyRow(apply, false)).join('')}`
    : '<li class="empty"><h3>No applies yet.</h3><p>An approved plan is applied by an agent with packages_apply; its progress appears here.</p></li>'}</ul></section>`;
  const installed = `<section aria-labelledby="package-bindings-heading"><h2 id="package-bindings-heading">Installed packages</h2><ul class="record-list">${bindings.length
    ? bindings.map((binding) => bindingRow(binding, releases)).join('')
    : '<li class="empty"><h3>No packages installed.</h3><p>Installed releases, their health, and their rollback history appear here.</p></li>'}</ul></section>`;
  const releaseRows = releases.map((release) => {
    const [health, tone] = releaseHealth(release);
    return `<tr><th scope="row">${escape(String(release.name ?? ''))}<small class="mono wrap">${escape(String(release.releaseId ?? ''))}</small></th><td>${escape(String(release.version ?? ''))}</td><td>${escape(formatPackageBytes(release.sizeBytes))}</td><td><span class="status ${tone}">${escape(health)}</span></td><td>${release.createdAt ? time(release.createdAt) : 'Not reported'}</td></tr>`;
  }).join('');
  const releaseSection = releases.length
    ? `<section aria-labelledby="package-releases-heading"><h2 id="package-releases-heading">Retained releases</h2><div class="package-table"><table><caption class="sr-only">Retained package releases</caption><thead><tr><th scope="col">Package</th><th scope="col">Version</th><th scope="col">Size</th><th scope="col">Health</th><th scope="col">Built</th></tr></thead><tbody>${releaseRows}</tbody></table></div></section>`
    : '';
  return renderResourcePage({
    note,
    body: `<div class="packages-page"><ul class="metric-grid">${tiles}</ul>${inFlightSection}${installed}${releaseSection}</div>`
  });
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
    return `<g class="chart-bar" tabindex="0" role="listitem" aria-label="${escape(`${point.label}: ${value}${unit}${note}`)}"><title>${escape(`${point.label}: ${value}${unit}${note}`)}</title><text x="0" y="${y + 14}" class="bar-label">${escape(String(point.label))}</text><rect x="150" y="${y + 3}" width="${Math.max(barWidth, 1)}" height="12" rx="2" class="bar-fill"/><text x="360" y="${y + 14}" class="bar-value">${escape(String(value))}${escape(unit)}</text></g>`;
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
    return `<g class="chart-bar" tabindex="0" role="listitem" aria-label="${escape(description)}"><title>${escape(description)}</title>${segments}<text x="${index * 34 + 17}" y="${height - 8}" text-anchor="middle" class="chart-tick">${escape(String(point.tick ?? ''))}</text></g>`;
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
  return `${close}<${heading} id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</${heading}><p class="mono wrap">${escape(workspace.workspaceId)}</p><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span><ol class="lifecycle" aria-label="Workspace lifecycle"><li><strong>Created</strong>${time(workspace.createdAt)}</li><li><strong>Last activity</strong>${time(workspace.lastActivityAt)}</li><li><strong>Expires</strong>${time(workspace.expiresAt)}</li></ol><dl class="facts"><dt>Repository</dt><dd class="wrap">${escape(workspace.repositoryUrl)}</dd><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd>${renderRepositoryFacts(workspace)}<dt>Network</dt><dd>${networkLabel(workspace.networkProfile)}</dd></dl>${warning}<nav class="detail-actions" aria-label="Workspace sections"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/files">Files</a><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/runtime">Runtime</a></nav><div class="danger-zone"><button id="close-workspace" class="danger" type="button" ${workspace.version ? '' : 'disabled'}>Close workspace</button>${workspace.version ? '' : '<p>Close is unavailable until lifecycle fencing is ready.</p>'}</div>`;
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

/** Human duration for OAuth lifetimes: whole days, then hours, then minutes. */
export function oauthDurationLabel(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Unknown';
  const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds >= 3_600 && seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

const OAUTH_STATE_LABELS = {
  unconfigured: 'Not managed by Cloud Harness (no provider integration)',
  unmanaged: 'Set outside Cloud Harness; left unchanged',
  managed: 'Managed by Cloud Harness',
  drifted: 'Changed outside Cloud Harness since the last save'
};

/**
 * Inbound MCP OAuth session controls. Every value shown as effective comes from
 * the provider read-back; the controls render only what the provider supports,
 * and a bounded provider never shows "forever".
 */
export function renderOAuthSettings(view, loadError) {
  if (!view) {
    return `<section class="panel" aria-labelledby="settings-oauth-heading"><h2 id="settings-oauth-heading">MCP OAuth sessions</h2><p class="warning">${escape(loadError ?? 'OAuth session settings are temporarily unavailable.')}</p><p id="settings-oauth-status" class="status-message" aria-live="polite"></p></section>`;
  }
  const capabilities = view.capabilities ?? {};
  const effective = view.effective;
  const management = view.management ?? {};
  const desired = management.desired;
  const maxSeconds = capabilities.maxGrantSeconds;
  const maximumLabel = capabilities.supportsUnboundedGrant ? 'until revoked' : maxSeconds ? oauthDurationLabel(maxSeconds) : 'provider maximum';
  const grantFact = effective
    ? effective.grantSeconds === null
      ? effective.grantExplicitlyConfigured ? 'Set in the provider (format not recognised)' : 'Provider default (not set explicitly)'
      : `${escape(oauthDurationLabel(effective.grantSeconds))}${effective.grantIsProviderMaximum ? ' — provider maximum' : ''}`
    : 'Not available';
  const tokenFact = effective ? (effective.tokenLifetimeSeconds === null ? 'Provider default' : escape(oauthDurationLabel(effective.tokenLifetimeSeconds))) : 'Not available';
  const managedNote = management.updatedAt
    ? ` — ${management.updatedBy === 'startup-default' ? 'default applied automatically at first start' : 'last saved here'} ${time(management.updatedAt)}`
    : '';
  const lastSync = view.lastSync
    ? `${time(view.lastSync.at)} — ${view.lastSync.ok ? 'OK' : `failed (<span class="mono">${escape(view.lastSync.errorCode ?? 'unknown')}</span>)`}`
    : 'Never';
  const facts = `<dl class="facts"><dt>Provider</dt><dd>${escape(view.provider?.label ?? 'Not configured')}</dd><dt>Stay signed in</dt><dd>${effective?.grantIsProviderMaximum ? 'On — provider maximum' : effective ? 'Custom duration' : 'Not available'}</dd><dt>Grant duration (effective)</dt><dd>${grantFact}</dd><dt>Access-token lifetime (effective)</dt><dd>${tokenFact}</dd><dt>Management</dt><dd>${escape(OAUTH_STATE_LABELS[management.state] ?? 'Unknown')}${managedNote}</dd><dt>Last provider sync</dt><dd>${lastSync}</dd></dl>`;
  const notice = view.readOnlyReason ? `<p class="warning">${escape(view.readOnlyReason)}</p>` : '';
  const intro = '<p>How long an MCP client such as ChatGPT or Claude stays connected after one sign-in. Access tokens stay short and refresh silently; every refresh re-checks your access policy, so revoking access still takes effect at the next refresh. This is separate from the browser session for this dashboard.</p>';
  let form = '';
  if (capabilities.canWriteGrantConfiguration) {
    const persistent = desired ? desired.grant?.mode === 'provider-maximum' : (effective?.grantIsProviderMaximum ?? true) || (management.state === 'unmanaged' && effective?.grantSeconds === null);
    const currentSeconds = desired?.grant?.mode === 'custom' ? desired.grant.seconds : effective?.grantSeconds ?? null;
    const presets = Array.isArray(capabilities.grantPresetsSeconds) ? capabilities.grantPresetsSeconds : [];
    const presetSelected = !persistent && currentSeconds !== null && presets.includes(currentSeconds);
    const options = presets.map((seconds) => `<option value="${escape(seconds)}"${presetSelected && seconds === currentSeconds ? ' selected' : ''}>${escape(oauthDurationLabel(seconds))}</option>`).join('');
    const customSelected = !persistent && !presetSelected;
    const customHours = customSelected && currentSeconds ? Math.round(currentSeconds / 3_600) : 24;
    const bounds = capabilities.tokenLifetime ?? { minSeconds: 60, maxSeconds: 3_600, defaultSeconds: 900 };
    const tokenSeconds = desired?.tokenLifetimeSeconds ?? effective?.tokenLifetimeSeconds ?? bounds.defaultSeconds;
    const tokenMinutes = Math.min(bounds.maxSeconds, Math.max(bounds.minSeconds, tokenSeconds)) / 60;
    const minHours = Math.ceil((capabilities.minGrantSeconds ?? 3_600) / 3_600);
    const maxHours = maxSeconds ? Math.floor(maxSeconds / 3_600) : '';
    const adopt = management.state === 'unmanaged' || management.state === 'drifted'
      ? `<button id="adopt-settings-oauth" type="button">Adopt default: stay signed in, ${escape(oauthDurationLabel(bounds.defaultSeconds))} tokens</button>`
      : '';
    form = `<form id="settings-oauth-form" class="stack-form" novalidate><label class="checkbox-label" for="settings-oauth-persistent"><input id="settings-oauth-persistent" type="checkbox"${persistent ? ' checked' : ''}><span>Stay signed in — use the provider maximum (${escape(maximumLabel)})</span></label><label for="settings-oauth-grant">Grant duration</label><select id="settings-oauth-grant"${persistent ? ' disabled' : ''}>${options}<option value="custom"${customSelected ? ' selected' : ''}>Custom</option></select><label for="settings-oauth-grant-hours">Custom duration (hours)</label><input id="settings-oauth-grant-hours" type="number" inputmode="numeric" step="1" min="${escape(minHours)}"${maxHours ? ` max="${escape(maxHours)}"` : ''} value="${escape(customHours)}"${persistent || !customSelected ? ' disabled' : ''}><details><summary>Advanced</summary><label for="settings-oauth-token-minutes">Access-token lifetime (minutes)</label><input id="settings-oauth-token-minutes" type="number" inputmode="numeric" step="1" min="${escape(bounds.minSeconds / 60)}" max="${escape(bounds.maxSeconds / 60)}" value="${escape(tokenMinutes)}"><p>Keep this short. ${escape(oauthDurationLabel(bounds.defaultSeconds))} is the default; a longer token does not reduce sign-ins, it only delays policy re-checks.</p></details><div class="form-row-actions"><button id="save-settings-oauth" class="accent-btn" type="submit">Save OAuth settings</button>${adopt}<button id="reload-settings-oauth" type="button">Reload from provider</button></div></form>`;
  } else if (view.provider?.id !== 'none') {
    form = '<div class="form-row-actions"><button id="reload-settings-oauth" type="button">Reload from provider</button></div>';
  }
  return `<section class="panel" aria-labelledby="settings-oauth-heading"><h2 id="settings-oauth-heading">MCP OAuth sessions</h2>${intro}${facts}${notice}${form}<p id="settings-oauth-status" class="status-message" aria-live="polite"></p></section>`;
}

/**
 * The four workspace lifecycle settings in display order. `unit` is the unit the operator edits:
 * the quota is a count and the durations are whole minutes over the runner's integer seconds.
 */
export const WORKSPACE_LIFECYCLE_FIELDS = [
  { name: 'maxActiveWorkspacesPerOwner', id: 'settings-lifecycle-max-active', label: 'Max active workspaces per principal', unit: 'count' },
  { name: 'idleTtlSeconds', id: 'settings-lifecycle-idle', label: 'Idle timeout (minutes)', unit: 'minutes' },
  { name: 'wallTtlSeconds', id: 'settings-lifecycle-wall', label: 'Maximum workspace lifetime (minutes)', unit: 'minutes' },
  { name: 'recoverableGraceSeconds', id: 'settings-lifecycle-grace', label: 'Recoverable grace before auto-close (minutes)', unit: 'minutes' }
];

const LIFECYCLE_SOURCE_LABELS = { setting: 'Dashboard override', environment: 'Runner environment', default: 'Built-in default' };

const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A view from a runner that predates the lifecycle settings, or a malformed one, renders no panel. */
export function isWorkspaceLifecycleView(view) {
  if (!view || typeof view !== 'object' || !Number.isInteger(view.revision) || !view.settings || typeof view.settings !== 'object') return false;
  return WORKSPACE_LIFECYCLE_FIELDS.every(({ name }) => {
    const setting = view.settings[name];
    return setting && isCount(setting.value) && isCount(setting.runnerValue) && isCount(setting.min) && isCount(setting.max);
  });
}

/** The editable bounds of a field in its display unit; minute bounds stay inside the runner's second bounds. */
export function workspaceLifecycleFieldBounds(field, setting) {
  if (field.unit === 'count') return { min: setting.min, max: setting.max };
  return { min: Math.ceil(setting.min / 60), max: Math.floor(setting.max / 60) };
}

/** A runner value that is not a whole minute (the environment allows 30 s idle) shows as a decimal and is only sent if edited. */
export function workspaceLifecycleDisplayValue(field, seconds) {
  return field.unit === 'count' ? String(seconds) : String(Math.round((seconds / 60) * 100) / 100);
}

/** A duration in seconds as the operator reads it. */
export function lifecycleDurationLabel(seconds) {
  if (!isCount(seconds)) return 'unknown';
  if (seconds % 60 !== 0) return `${seconds} s`;
  const minutes = seconds / 60;
  return minutes >= 120 && minutes % 60 === 0 ? `${minutes} min (${minutes / 60} h)` : `${minutes} min`;
}

const bytesLabel = (bytes) => {
  if (!isCount(bytes)) return 'unknown memory';
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${Math.round(gib * 100) / 100} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
};

const lifecycleValueLabel = (field, seconds) => field.unit === 'count' ? String(seconds) : lifecycleDurationLabel(seconds);

/**
 * Workspace limits and lifecycle. Every value shown as effective is the runner's read-back; the form edits
 * the Dashboard overrides and a reset hands each field back to the runner value printed beside it.
 */
export function renderWorkspaceLifecycleSettings(view) {
  if (!isWorkspaceLifecycleView(view)) return '';
  const { settings } = view;
  const usage = view.usage ?? {};
  const ceilings = view.executorCeilings ?? {};
  const reaper = lifecycleDurationLabel(view.reaperIntervalSeconds);
  const quota = settings.maxActiveWorkspacesPerOwner.value;
  const idle = settings.idleTtlSeconds.value;
  const wall = settings.wallTtlSeconds.value;
  const grace = settings.recoverableGraceSeconds.value;

  const field = (definition, help) => {
    const setting = settings[definition.name];
    const bounds = workspaceLifecycleFieldBounds(definition, setting);
    const value = workspaceLifecycleDisplayValue(definition, setting.value);
    const source = LIFECYCLE_SOURCE_LABELS[setting.source] ?? 'Unknown';
    const range = definition.unit === 'count' ? `${bounds.min}–${bounds.max}` : `${bounds.min}–${bounds.max} min`;
    return `<div class="lifecycle-field"><label for="${definition.id}">${escape(definition.label)}</label><input id="${definition.id}" name="${definition.name}" type="number" inputmode="numeric" step="1" min="${escape(bounds.min)}" max="${escape(bounds.max)}" value="${escape(value)}" data-initial="${escape(value)}" required aria-describedby="${definition.id}-meta ${definition.id}-error"><p id="${definition.id}-meta" class="field-meta">Source: ${escape(source)} · Runner value: ${escape(lifecycleValueLabel(definition, setting.runnerValue))} · Allowed: ${escape(range)}</p><p id="${definition.id}-error" class="field-error"></p>${help}</div>`;
  };

  const ceilingText = `${bytesLabel(ceilings.memoryBytes)} memory, ${escape(ceilings.cpus ?? 'unknown')} CPU, ${escape(ceilings.pids ?? 'unknown')} pids`;
  const atLimit = isCount(ceilings.memoryBytes) && isCount(ceilings.cpus) && isCount(ceilings.pids)
    ? ` At the current limit of ${escape(quota)}, one principal alone could reach ${escape(bytesLabel(ceilings.memoryBytes * quota))} memory, ${escape(Math.round(ceilings.cpus * quota * 100) / 100)} CPU and ${escape(ceilings.pids * quota)} pids.`
    : '';
  const quotaHelp = `<dl class="facts"><dt>Your active workspaces</dt><dd><span class="mono">${escape(usage.counted ?? 0)} / ${escape(usage.limit ?? quota)}</span> counted against the effective limit</dd><dt>Expired, recoverable</dt><dd>${escape(usage.recoverable ?? 0)} (not counted; their checkouts still use disk)</dd></dl><p class="warning">Each executor is capped at ${ceilingText}. These are ceilings, not reservations, and they multiply with every concurrent workspace, so this per-principal quota does not guarantee the host has capacity.${atLimit}</p><p class="field-help">The limit is enforced at the next open, recover, or lease renew. Lowering it below current usage blocks new opens but never closes an existing workspace.</p>`;
  const idleHelp = '<p class="field-help">A workspace expires after this long without activity. Tool calls that operate on the workspace refresh the idle lease: exec, files, git, shell, session, and task operations, <span class="mono">workspace_lease_renew</span>, and resuming with <span class="mono">workspace_recover</span>. <span class="mono">workspace_list</span>, <span class="mono">workspace_status</span>, and Dashboard polling or metadata reads do not keep a workspace alive.</p>';
  const wallHelp = `<p class="field-help">A hard deadline counted from creation; activity never extends it. The effective active lifetime is the earlier of the idle expiry and this deadline (now: idle ${escape(lifecycleDurationLabel(idle))}, hard deadline ${escape(lifecycleDurationLabel(wall))}). The idle timeout may not exceed the lifetime.</p>`;
  const graceHelp = `<p class="field-help">How long an expired workspace stays recoverable before the reaper may close it. It closes at about expiry + grace + up to one reaper interval (${escape(reaper)}).</p><div id="settings-lifecycle-ack-block" class="lifecycle-ack"${grace === 0 ? '' : ' hidden'}><p><strong>A grace of 0 closes clean expired workspaces on the next reaper pass.</strong> There is no window to recover them after expiry.</p><label class="checkbox-label" for="settings-lifecycle-ack"><input id="settings-lifecycle-ack" name="acknowledgeImmediateClose" type="checkbox" aria-describedby="settings-lifecycle-ack-error"><span>I understand expired workspaces close without a recovery window</span></label><p id="settings-lifecycle-ack-error" class="field-error"></p></div>`;

  const timeline = `<ol class="lifecycle lifecycle-states" aria-label="Workspace lifecycle states"><li><strong class="mono">ACTIVE</strong>Counts against the quota. Expires at the earlier of ${escape(lifecycleDurationLabel(idle))} idle or ${escape(lifecycleDurationLabel(wall))} after creation.</li><li><strong class="mono">EXPIRED_RECOVERABLE</strong>Frees its active slot, but its checkout still uses disk. Recoverable with <span class="mono">workspace_recover</span> for ${escape(lifecycleDurationLabel(grace))}.</li><li><strong class="mono">CLOSED</strong>Auto-closed at about expiry + ${escape(lifecycleDurationLabel(grace))} + up to ${escape(reaper)}. Auto-close never deletes uncommitted, untracked, stashed, or unpushed work, nor a workspace with running agents (Git-ignored files are not checked): those stay recoverable until closed explicitly with <span class="mono">workspace_close</span> or recovered.</li></ol><dl class="facts"><dt>Retained by auto-close</dt><dd>${escape(usage.autoCloseDeferred ?? 0)} of your workspaces</dd><dt>Last changed</dt><dd>${view.updatedAt ? time(view.updatedAt) : 'Never changed in this dashboard'} <span class="mono">rev ${escape(view.revision)}</span></dd></dl>`;

  const disclosure = '<p class="page-note"><strong>Not retroactive.</strong> Idle timeout, lifetime, and grace changes apply only to newly opened workspaces; open workspaces keep the policy they were opened with. The quota applies to the next open, recover, or renew. These are separate from the MCP OAuth session lifetime and from agent task TTLs.</p>';

  const form = `<form id="settings-lifecycle-form" class="stack-form lifecycle-form" novalidate>${field(WORKSPACE_LIFECYCLE_FIELDS[0], quotaHelp)}${field(WORKSPACE_LIFECYCLE_FIELDS[1], idleHelp)}${field(WORKSPACE_LIFECYCLE_FIELDS[2], wallHelp)}${field(WORKSPACE_LIFECYCLE_FIELDS[3], graceHelp)}<div class="form-row-actions"><button id="save-settings-lifecycle" class="accent-btn" type="submit">Save lifecycle settings</button><button id="reset-settings-lifecycle" type="button">Reset to runner values</button></div></form>`;

  return `<section id="settings-lifecycle-panel" class="panel" aria-labelledby="settings-lifecycle-heading"><h2 id="settings-lifecycle-heading">Workspace limits &amp; lifecycle</h2><p>Instance-wide quota and lifetimes for workspaces. Effective values below are what the runner reports.</p>${disclosure}${timeline}${form}<p id="settings-lifecycle-status" class="status-message" aria-live="polite"></p></section>`;
}

export function renderSettings(data, readiness, oauth, typesafe) {
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
  return `<div class="page-note"><strong>Instance-wide defaults.</strong> These values apply to workspaces opened without an explicit network profile. Saving here neither starts nor changes a running workspace.</div><section class="panel" aria-labelledby="settings-network-heading"><h2 id="settings-network-heading">Default network profile</h2><p>Choose the network posture for newly opened workspaces.</p><label for="settings-network-profile">Effective default</label><select id="settings-network-profile" name="defaultNetworkProfile">${options}<option value=""${stored ? '' : ' selected'}>Use runner default</option></select><dl class="facts"><dt>Effective profile</dt><dd>${escape(networkLabel(value))} <span class="mono">${escape(value)}</span></dd><dt>Source</dt><dd>${escape(source)}</dd>${readinessFact}</dl><p class="warning"><strong>Dependency access grants outbound network access to repository-controlled code.</strong> A dependency, build script, or agent command can then reach the network and exfiltrate any credential injected into the workspace, including a global GH_TOKEN. A fine-grained token scoped only to the repositories a workspace needs is safer than a broadly scoped credential. Check egress readiness before relying on it.</p><div class="form-row-actions"><button id="save-settings-network-profile" class="accent-btn" type="button">Save</button><button id="reset-settings-network-profile" type="button">Reset to runner default</button><button id="check-settings-network" type="button">Check egress readiness</button></div><p id="settings-status" class="status-message" aria-live="polite"></p></section>${renderWorkspaceLifecycleSettings(data?.workspaceLifecycle)}${oauth ? renderOAuthSettings(oauth.view, oauth.error) : ''}${typesafe ? renderTypesafeSettings(typesafe) : ''}`;
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

const workspaceRepositories = (workspace) => Array.isArray(workspace.repositories) ? workspace.repositories : [];
const repositoryAliases = (workspace) => workspaceRepositories(workspace).map((entry) => entry.alias).join(' ');
// A multi-repository workspace is titled by its primary repository; the count tells the rest apart.
const renderRepositoryCount = (workspace) => workspaceRepositories(workspace).length > 1 ? ` <span class="tag-badge">${escape(workspaceRepositories(workspace).length)} repositories</span>` : '';
const renderRepositoryFacts = (workspace) => {
  const entries = workspaceRepositories(workspace);
  if (entries.length < 2) return '';
  const items = entries.map((entry) => `<li><strong>${escape(entry.alias)}</strong> <span class="mono">${escape(entry.path)}</span> ${escape(repositoryName(entry.repositoryUrl))}${entry.ref ? ` @ ${escape(entry.ref)}` : ''}${entry.access === 'read-only' ? ' <span class="tag-badge">Read-only</span>' : ''}${entry.primary ? ' <span class="tag-badge">Primary</span>' : ''}</li>`).join('');
  return `<dt>Repositories</dt><dd><ul class="repository-list">${items}</ul></dd>`;
};
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
 * The TypeSafe panel shows only what the server backs: the per-owner key (write-only, so the field is a
 * password input that never renders a stored value back), its removal, and the read-only status the
 * runner reports. `view` is `{ status, credential, error }`, where `credential` is the owner's
 * TypeSafe credential metadata (never a value). When a read failed, `error` is shown and the key form is
 * withheld, because without the credential list the panel cannot tell a first save from a rotation.
 */
export function renderTypesafeSettings(view = {}) {
  const status = view.status;
  const credential = view.credential;
  const configured = Boolean(credential) || status?.configured === true;
  const facts = status
    ? `<dl class="facts"><dt>API key</dt><dd>${configured ? 'Configured' : 'Not configured'}</dd><dt>Egress</dt><dd>${status.enabled === true ? 'Enabled' : 'Off'}</dd><dt>Endpoint</dt><dd class="mono">${escape(status.endpoint ?? '')}</dd><dt>Model</dt><dd class="mono">${escape(status.model ?? '')}</dd>${credential ? `<dt>Key version</dt><dd>${escape(credential.activeVersion)}</dd>` : ''}</dl>`
    : '';
  const unavailable = view.error ? `<p class="warning">${escape(view.error)}</p>` : '';
  const egressOff = status && status.enabled !== true
    ? '<p class="warning"><strong>The operator turned TypeSafe egress off instance-wide</strong> with <span class="mono">TYPESAFE_EGRESS=off</span>. A stored key is kept, but nothing is sent until the operator removes that setting.</p>'
    : '';
  const remove = credential
    ? `<button type="button" id="typesafe-remove" class="danger" data-credential-id="${escape(credential.id)}" data-generation="${escape(credential.generation)}">Remove key</button>`
    : '';
  return `<section id="typesafe-panel" class="panel" aria-labelledby="typesafe-heading"><h2 id="typesafe-heading">TypeSafe integration</h2><p>Your TypeSafe API key enables skill suggestions and the optional Decision Plane. The key is write-only: it is encrypted by the runner and never shown again.</p>${unavailable}${facts}${egressOff}${view.error ? '' : `<form class="stack-form" id="typesafe-form" novalidate><label for="typesafe-key">${credential ? 'Replacement API key' : 'API key'} (write-only, never shown again)</label><input id="typesafe-key" name="value" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096" required><div class="form-row-actions"><button type="submit" id="typesafe-save" class="accent-btn"${credential ? ` data-credential-id="${escape(credential.id)}" data-generation="${escape(credential.generation)}"` : ''}>${credential ? 'Replace key' : 'Save key'}</button>${remove}</div></form>`}<p id="typesafe-status" class="status-message" aria-live="polite"></p></section>`;
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
    </div>
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
 * credential lanes `/mcp-gateway` accepts — the session/bearer lane and, when the
 * deployment publishes it, the managed API-key lane — and the two hard limitations an
 * operator hits first.
 */
function renderMcpGatewayCard(gateway) {
  const gatewayData = gateway ?? {};
  const endpoint = typeof gatewayData.publicUrl === 'string' && gatewayData.publicUrl
    ? gatewayData.publicUrl
    : (typeof gatewayData.endpoint === 'string' && gatewayData.endpoint ? gatewayData.endpoint : '/mcp-gateway');
  const lane = gatewayData.authMode === 'owner-bearer'
    ? 'Authenticates with your Cloud Harness owner bearer token.'
    : 'Authenticates with your Cloud Harness Access session.';
  const apiKeyEndpoint = typeof gatewayData.apiKeyPublicUrl === 'string' && gatewayData.apiKeyPublicUrl
    ? gatewayData.apiKeyPublicUrl
    : '';
  const apiKeyLane = apiKeyEndpoint
    ? `<p class="mcp-endpoint-lane">Clients that send a static header use the managed API-key lane instead: point them at this endpoint with a key from <a href="/dashboard/api-keys">API keys</a> as the bearer token.</p>
      <p class="mcp-endpoint"><span class="mono wrap">${escape(apiKeyEndpoint)}</span> <button type="button" class="copy" data-copy="${escape(apiKeyEndpoint)}">Copy</button></p>`
    : (gatewayData.authMode === 'owner-bearer' ? '' : '<p class="mcp-endpoint-lane">The managed API-key lane is not enabled on this deployment.</p>');
  return `
    <section class="panel mcp-gateway-card" aria-labelledby="mcp-gateway-heading">
      <h2 id="mcp-gateway-heading">Your Cloud Harness MCP Gateway</h2>
      <p class="mcp-endpoint"><span class="mono wrap">${escape(endpoint)}</span> <button type="button" class="copy" data-copy="${escape(endpoint)}">Copy</button></p>
      <p>Connect this single MCP endpoint to your AI client. Tools from your configured MCP servers are discovered and executed through Cloud Harness.</p>
      <p>Your client sees five tools no matter how many servers you add. An agent finds the right tool without loading every schema:</p>
      <ol class="mcp-hub-steps">
        <li><code class="mono">search</code> finds a <code class="mono">server.tool</code> from a plain description of the need, across every enabled server it may use.</li>
        <li><code class="mono">inspect</code> returns that one tool's input schema and permission.</li>
        <li><code class="mono">execute</code> runs it, re-checking permission on every call.</li>
        <li><code class="mono">permissions</code> and <code class="mono">status</code> report what is allowed and which servers are connected.</li>
      </ol>
      <p class="mcp-endpoint-lane">${escape(lane)}</p>
      ${apiKeyLane}
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
        <td class="mono nowrap">${escape(server.transport)}</td>
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
  // The registered servers are what this page is for, so they lead; the gateway card
  // is the one-time client setup and follows them.
  return `
    <section class="mcp-server-list" aria-labelledby="mcp-server-list-heading">
      <div class="record-heading">
        <div><h2 id="mcp-server-list-heading">Registered servers</h2><p>Each server's tools are served through your gateway endpoint below.</p></div>
      </div>
      <div class="desktop-table">
        <table>
          <caption>${escape(servers.length)} MCP servers</caption>
          <thead><tr><th>Name</th><th>Transport</th><th>Status</th><th>Tools</th><th>Last connected</th><th>Enabled</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <ul class="mobile-list">${cards}</ul>
    </section>
    ${renderMcpGatewayCard(gateway)}
  `;
}

const MCP_OAUTH_LABELS = {
  not_configured: 'Not configured',
  authorization_required: 'Authorization required',
  authorizing: 'Authorizing',
  connected: 'Connected',
  reauthorization_required: 'Reauthorization required',
  error: 'Error'
};

function renderMcpOAuthSection(server, status) {
  if (!server.oauth) return '';
  const state = status?.state ?? 'authorization_required';
  const label = MCP_OAUTH_LABELS[state] ?? MCP_OAUTH_LABELS.error;
  const connected = state === 'connected';
  const connectLabel = connected ? 'Reconnect' : (state === 'reauthorization_required' ? 'Reauthorize' : 'Connect');
  const facts = status ? `<dl class="facts">
        ${status.issuer ? `<dt>Issuer</dt><dd class="mono wrap">${escape(status.issuer)}</dd>` : ''}
        ${status.grantedScopes ? `<dt>Granted scopes</dt><dd class="mono wrap">${escape(status.grantedScopes)}</dd>` : ''}
        ${status.registrationMode ? `<dt>Registration</dt><dd class="mono">${escape(status.registrationMode)}</dd>` : ''}
        ${status.authorizedAt ? `<dt>Authorized</dt><dd>${time(status.authorizedAt)}</dd>` : ''}
        ${status.expiresAt ? `<dt>Access token expires</dt><dd>${time(status.expiresAt)}</dd>` : ''}
        ${status.redirectUrl ? `<dt>Redirect URL</dt><dd class="mono wrap">${escape(status.redirectUrl)}</dd>` : ''}
      </dl>` : '';
  const error = status?.lastError ? `<p class="warning wrap">${escape(status.lastError)}</p>` : '';
  // Without a redirect URL an interactive step cannot complete, so Connect is not offered.
  const interactive = !status || Boolean(status.redirectUrl);
  const setup = interactive ? '' : '<p class="wrap">Connecting needs <code>MCP_DOWNSTREAM_OAUTH_REDIRECT_URL</code> set to this dashboard\'s <code>/dashboard/mcp-oauth/callback</code> URL.</p>';
  const connect = interactive
    ? `<button class="accent-btn" type="button" data-mcp-oauth-connect="${escape(server.id)}">${escape(connectLabel)}</button>` : '';
  // A stored grant can always be disconnected, even when Connect is unavailable.
  const disconnect = status && (status.issuer || (state !== 'authorization_required' && state !== 'not_configured'))
    ? `<button class="danger" type="button" data-mcp-oauth-disconnect="${escape(server.id)}">Disconnect</button>` : '';
  const actions = connect || disconnect ? `<div class="row-actions">${connect}${disconnect}</div>` : '';
  return `
    <section class="panel" aria-labelledby="mcp-oauth-heading">
      <h2 id="mcp-oauth-heading">OAuth</h2>
      <p><span class="status${connected ? ' connected' : ''}">${escape(label)}</span></p>
      ${error}
      ${setup}
      ${facts}
      ${actions}
    </section>`;
}

function renderMcpOverviewPanel(server, gateway, oauthStatus) {
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
    ${renderMcpOAuthSection(server, oauthStatus)}
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

export function renderMcpServerDetail(server, tools, traces, activeTab = 'overview', cursor, gateway, oauthStatus) {
  if (!server) return '<div class="empty"><h3>MCP server not found.</h3><p>It may have been deleted or belong to another identity.</p></div>';
  const tabs = [['overview', 'Overview'], ['tools', 'Tools'], ['permissions', 'Permissions'], ['logs', 'Logs']];
  const tabNav = `<div class="mcp-nav-tabs" role="tablist" aria-label="MCP server sections">${tabs.map(([key, label]) => `<button type="button" class="mcp-tab-btn${activeTab === key ? ' active' : ''}" data-mcp-tab="${key}" role="tab" aria-selected="${activeTab === key ? 'true' : 'false'}">${escape(label)}</button>`).join('')}</div>`;
  const toolCount = Array.isArray(tools) ? tools.length : count(server.toolCount);
  const panels = { overview: renderMcpOverviewPanel(server, gateway, oauthStatus), tools: renderMcpToolsPanel(tools), permissions: renderMcpPermissionsPanel(server, tools), logs: renderMcpLogsPanel(traces, cursor) };
  return `
    <nav aria-label="Breadcrumb"><a href="/dashboard/mcp-servers">MCP servers</a><span>${escape(server.name)}</span></nav>
    <div class="record-heading">
      <div>
        <h2 class="sr-only">${escape(server.name)}</h2>
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

/*
 * Webhook automations. The data shapes are the Dashboard BFF payloads owned by
 * `packages/contracts/src/automations-api.ts`. Repository, label, result, error and
 * outcome strings come from a provider webhook or the agent, so every one is treated
 * as untrusted text: escaped on output, and a provider URL becomes a link only when it
 * parses as https.
 */
export const AUTOMATION_SECTIONS = [
  { id: 'runs', label: 'Runs', route: '/dashboard/automations' },
  { id: 'rules', label: 'Rules', route: '/dashboard/automations/rules' },
  { id: 'connections', label: 'Connections', route: '/dashboard/automations/connections' },
  { id: 'deliveries', label: 'Deliveries', route: '/dashboard/automations/deliveries' },
  { id: 'metrics', label: 'Metrics', route: '/dashboard/automations/metrics' }
];
export const AUTOMATION_WORKFLOW_STATES = ['QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'];
export const AUTOMATION_DELIVERY_STATES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'QUARANTINED'];
export const AUTOMATION_PUBLISH_STATES = ['NONE', 'PENDING', 'DELIVERED', 'FAILED'];
/** Mirrors `AutomationProviderSchema`; the connection fixes a rule's provider. */
export const AUTOMATION_PROVIDERS = [['github', 'GitHub'], ['linear', 'Linear'], ['jira', 'Jira'], ['custom', 'Custom webhook']];
/** Mirrors `AutomationEventTypeSchema`, grouped by provider, for the Test event form. */
export const AUTOMATION_PROVIDER_EVENT_TYPES = {
  github: ['github.issue.label_added', 'github.pull_request.label_added'],
  linear: ['linear.issue.label_added', 'linear.issue.state_changed'],
  jira: ['jira.issue.label_added', 'jira.issue.status_changed'],
  custom: ['custom.event']
};
/** The state trigger each provider's match uses beside `label_added`. */
export const AUTOMATION_STATE_TRIGGERS = { linear: ['state_changed', 'Moved to a workflow state'], jira: ['status_changed', 'Moved to a status'] };
export const AUTOMATION_METRICS_WINDOWS = [1, 7, 30];
export const automationProviderLabel = (provider) => AUTOMATION_PROVIDERS.find(([id]) => id === provider)?.[1] ?? String(provider ?? 'Unknown');
/** A rule's provider: GitHub matches stored before the provider tag carry none. */
export const automationMatchProvider = (match) => (typeof match?.provider === 'string' ? match.provider : 'github');
const AUTOMATION_TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
/** Mirrors `AgentProxyOperationSchema`; the first five are the contract's read-only default. */
// Mirrors the contract's read-only automation operation set; the runner rejects anything else.
export const AUTOMATION_PROXY_OPERATIONS = ['files_list', 'files_read', 'grep_search', 'symbols_search', 'symbols_references'];
export const AUTOMATION_DEFAULT_PROXY_OPERATIONS = [...AUTOMATION_PROXY_OPERATIONS];
export const AUTOMATION_GITHUB_EVENTS = [['issues', 'Issues'], ['pull_request', 'Pull requests']];
export const AUTOMATION_SENDER_TYPES = ['User', 'Bot', 'Organization'];
export const AUTOMATION_RULE_DEFAULTS = { ttlSeconds: 900, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 2_000_000, cooldownSeconds: 300, maxConcurrent: 1 };
export const AUTOMATIONS_DISABLED_COPY = 'Automations are disabled on this instance (set AUTOMATIONS_ENABLED=true on api and runner).';

const AUTOMATION_WORKFLOW_STATE = {
  QUEUED: ['Queued', 'queued'], STARTING: ['Starting', 'creating'], RUNNING: ['Running', 'running'], COMPLETED: ['Completed', 'succeeded'],
  FAILED: ['Failed', 'failed'], CANCELLED: ['Cancelled', ''], EXPIRED: ['Expired', 'expired']
};
const AUTOMATION_DELIVERY_STATE = { RECEIVED: ['Received', 'info'], PROCESSED: ['Processed', 'succeeded'], IGNORED: ['Ignored', ''], QUARANTINED: ['Quarantined', 'failed'] };
const AUTOMATION_PUBLISH_STATE = { NONE: ['Not published', ''], PENDING: ['Publishing', 'pending'], DELIVERED: ['Comment posted', 'succeeded'], FAILED: ['Publish failed', 'failed'] };
const automationPill = (table, value) => {
  const [label, className] = table[value] ?? ['Unknown', ''];
  return `<span class="status${className ? ` ${className}` : ''}">${escape(label)}</span>`;
};
const automationList = (value) => (Array.isArray(value) ? value : []);
const automationText = (value, empty = '—') => (value === null || value === undefined || value === '' ? empty : escape(value));

export function automationWorkflowStateLabel(state) {
  return (AUTOMATION_WORKFLOW_STATE[state] ?? ['Unknown'])[0];
}

export function automationWorkflowIsTerminal(state) {
  return AUTOMATION_TERMINAL_STATES.has(state);
}

/** The section a pathname selects, or `undefined` for a path this page does not own. */
export function automationSectionForPath(pathname) {
  const path = String(pathname ?? '').replace(/\/$/, '');
  if (/^\/dashboard\/automations\/runs\/wfl_[a-f0-9]{32}$/.test(path)) return 'runs';
  return AUTOMATION_SECTIONS.find((section) => section.route === path)?.id;
}

/**
 * Which blocked state an error puts the page in. The BFF answers 503 both when the
 * feature is switched off and when the runner is briefly unreachable; only the first
 * is a configuration the operator must change, so the two read differently.
 */
export function automationBlockedState(error) {
  if (error?.status === 403) return 'denied';
  if (error?.status !== 503) return undefined;
  const message = String(error.message ?? '').toLowerCase();
  return message.startsWith('automations are disabled') || message.startsWith('automations are not available') ? 'disabled' : 'unavailable';
}

export function renderAutomationBlocked(state) {
  if (state === 'disabled') {
    return `<div class="empty automation-blocked" role="status"><h3>Automations are disabled on this instance</h3><p>${escape(AUTOMATIONS_DISABLED_COPY)}</p><p>Set <code>AUTOMATIONS_ENABLED=true</code> for both the api and runner services and restart them to create connections and rules.</p></div>`;
  }
  if (state === 'denied') {
    return '<div class="empty automation-blocked" role="status"><h3>You cannot manage automations</h3><p>Your signed-in identity does not have permission to view or change webhook automations on this instance.</p></div>';
  }
  return '<div class="empty automation-blocked" role="status"><h3>Automations are temporarily unavailable</h3><p>The runner did not answer. Try again in a moment.</p><button type="button" data-automation-retry>Try again</button></div>';
}

export function renderAutomationLoading() {
  return '<p class="empty-note" role="status">Loading automations…</p>';
}

/** Section links for the shell's `#context-nav`; the current section carries `aria-current`. */
export function renderAutomationTabs(current) {
  return AUTOMATION_SECTIONS.map((section) => `<a href="${escape(section.route)}"${section.id === current ? ' aria-current="page"' : ''}>${escape(section.label)}</a>`).join('');
}

/** A provider resource URL becomes a link only when it is a well-formed https URL. */
export function automationResourceHref(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch { return undefined; }
}

/** The payload URL GitHub posts to: the dashboard's public origin plus the connection's relative path. */
export function automationWebhookUrl(origin, webhookPath) {
  const path = String(webhookPath ?? '');
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  try { return new URL(path, String(origin ?? '')).toString(); } catch { return path; }
}

/**
 * The source a run or delivery is about: `owner/name#12` for GitHub, and the provider
 * reference with the checked-out repository (`ENG-12 · acme/widgets`) for the others.
 */
export function automationResourceText(item) {
  const repository = item?.repository || '';
  const ref = item?.resourceRef || (item?.resourceNumber ? `#${item.resourceNumber}` : '');
  if (!ref) return repository || 'Unknown resource';
  if (ref.startsWith('#')) return `${repository || 'Unknown repository'}${ref}`;
  return repository ? `${ref} · ${repository}` : ref;
}

function automationResource(workflow) {
  const text = automationResourceText(workflow);
  const href = automationResourceHref(workflow?.resourceUrl);
  return href ? `<a class="mono" href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>` : `<span class="mono">${escape(text)}</span>`;
}

const automationWorkspacePath = (workspaceId) => `/dashboard/workspaces/${encodeURIComponent(workspaceId)}/agents`;
/** Tables show a short id; the link's accessible name and the detail view carry the full one. */
const automationIdText = (value, full) => (full ? String(value) : `${String(value).slice(0, 14)}…`);
function automationWorkspaceLinks(workflow, full = false) {
  if (!workflow?.workspaceId) return '<span>Not opened</span>';
  const path = escape(automationWorkspacePath(workflow.workspaceId));
  const agent = workflow.agentId ? `<br><a class="mono wrap" href="${path}" aria-label="Open agent ${escape(workflow.agentId)}">${escape(automationIdText(workflow.agentId, full))}</a>` : '';
  return `<a class="mono wrap" href="${path}" aria-label="Open workspace ${escape(workflow.workspaceId)}">${escape(automationIdText(workflow.workspaceId, full))}</a>${agent}`;
}

function automationUsage(usage) {
  if (!usage) return 'Not reported';
  return `${escape(countOf(usage.inputTokens))} in · ${escape(countOf(usage.outputTokens))} out · ${escape(costOf(usage.costMicros))}`;
}

const automationRunPath = (id) => `/dashboard/automations/runs/${encodeURIComponent(id)}`;
const automationShortId = (id) => String(id ?? '').slice(0, 12);

export function renderAutomationRuns({ workflows = [], rules = [], filters = {} } = {}) {
  const list = automationList(workflows);
  const ruleNames = new Map(automationList(rules).map((rule) => [rule.id, rule.name]));
  const ruleName = (workflow) => escape(ruleNames.get(workflow.ruleId) ?? workflow.ruleId);
  const stateOptions = AUTOMATION_WORKFLOW_STATES.map((state) => `<option value="${state}"${filters.state === state ? ' selected' : ''}>${escape(automationWorkflowStateLabel(state))}</option>`).join('');
  const ruleOptions = automationList(rules).map((rule) => `<option value="${escape(rule.id)}"${filters.ruleId === rule.id ? ' selected' : ''}>${escape(rule.name)}</option>`).join('');
  const runLink = (workflow) => `<a class="mono" href="${escape(automationRunPath(workflow.id))}" aria-label="Open run ${escape(workflow.id)}">${escape(automationShortId(workflow.id))}</a>`;
  const statePill = (workflow) => `${automationPill(AUTOMATION_WORKFLOW_STATE, workflow.state)}${workflow.agentStatus ? `<small class="mono">${escape(workflow.agentStatus)}</small>` : ''}`;
  const rows = list.length ? list.map((workflow) => `<tr>
        <th scope="row">${runLink(workflow)}</th>
        <td>${statePill(workflow)}</td>
        <td>${automationResource(workflow)}</td>
        <td class="mono">${escape(workflow.label)}</td>
        <td>${ruleName(workflow)}</td>
        <td>${automationWorkspaceLinks(workflow)}</td>
        <td class="mono wrap">${automationText(workflow.errorCode)}</td>
        <td>${automationPill(AUTOMATION_PUBLISH_STATE, workflow.publishState)}</td>
        <td class="nowrap">${automationUsage(workflow.usage)}</td>
        <td>${time(workflow.createdAt)}<small>Updated ${time(workflow.updatedAt)}</small></td>
      </tr>`).join('') : '<tr><td colspan="10">No automation runs yet.</td></tr>';
  const cards = list.length ? list.map((workflow) => `<li><h3>${automationResource(workflow)}</h3><dl><dt>Run</dt><dd>${runLink(workflow)}</dd><dt>State</dt><dd>${statePill(workflow)}</dd><dt>Label</dt><dd class="mono wrap">${escape(workflow.label)}</dd><dt>Rule</dt><dd>${ruleName(workflow)}</dd><dt>Workspace</dt><dd>${automationWorkspaceLinks(workflow)}</dd><dt>Error</dt><dd class="mono wrap">${automationText(workflow.errorCode)}</dd><dt>Publish</dt><dd>${automationPill(AUTOMATION_PUBLISH_STATE, workflow.publishState)}</dd><dt>Usage</dt><dd>${automationUsage(workflow.usage)}</dd><dt>Created</dt><dd>${time(workflow.createdAt)}</dd></dl></li>`).join('')
    : '<li class="empty"><h3>No automation runs yet.</h3><p>A run starts when a delivery matches an enabled rule.</p></li>';
  const publishOptions = AUTOMATION_PUBLISH_STATES.map((state) => `<option value="${state}"${filters.publishState === state ? ' selected' : ''}>${escape(AUTOMATION_PUBLISH_STATE[state][0])}</option>`).join('');
  return renderResourcePage({
    filters: `<form id="automation-runs-filter" aria-label="Filter runs"><label for="automation-runs-state">State</label><select id="automation-runs-state" name="state"><option value="">All states</option>${stateOptions}</select><label for="automation-runs-rule">Rule</label><select id="automation-runs-rule" name="ruleId"><option value="">All rules</option>${ruleOptions}</select><label for="automation-runs-publish">Publish</label><select id="automation-runs-publish" name="publishState"><option value="">Any publish state</option>${publishOptions}</select><button type="submit">Apply filters</button></form>`,
    body: `<section class="automation-runs" aria-labelledby="automation-runs-heading"><div class="record-heading"><div><h2 id="automation-runs-heading">Runs</h2><p>Each run opens one workspace and runs one agent for a delivery that matched a rule. Filter by Failed or Publish failed to triage runs that need attention.</p></div></div><div class="desktop-table"><table><caption>${escape(list.length)} automation runs</caption><thead><tr><th>Run</th><th>State</th><th>Resource</th><th>Label</th><th>Rule</th><th>Workspace / agent</th><th>Error</th><th>Publish</th><th>Usage</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul></section>`
  });
}

export function renderAutomationRunDetail({ workflow, result = null, transitions = [], ruleName } = {}) {
  if (!workflow) return '<div class="empty"><h3>Automation run not found.</h3><p>It may have been purged after the retention window or belong to another identity.</p></div>';
  const cancel = automationWorkflowIsTerminal(workflow.state) ? '' : `<div class="row-actions"><button class="danger" type="button" data-automation-cancel="${escape(workflow.id)}">Cancel run</button></div>`;
  const resultBody = typeof result === 'string' && result
    ? `<pre class="automation-result"><code>${escape(result)}</code></pre>`
    : `<p class="empty-note">${automationWorkflowIsTerminal(workflow.state) ? 'This run recorded no result.' : 'The result appears here when the agent finishes.'}</p>`;
  const steps = automationList(transitions);
  const timeline = steps.length ? steps.map((step) => `<li class="activity-event"><div class="record-heading"><span class="mono">${time(step.at)}</span>${automationPill(AUTOMATION_WORKFLOW_STATE, step.toState)}</div><p><strong>${step.fromState ? `${escape(automationWorkflowStateLabel(step.fromState))} → ` : ''}${escape(automationWorkflowStateLabel(step.toState))}</strong></p><p class="activity-meta">${step.actor === 'owner' ? 'Owner' : 'System'}${step.code ? ` · <span class="mono wrap">${escape(step.code)}</span>` : ''}</p></li>`).join('')
    : '<li class="empty">No transitions recorded.</li>';
  return `
    <nav aria-label="Breadcrumb"><a href="/dashboard/automations">Automations</a><span>Run ${escape(automationShortId(workflow.id))}</span></nav>
    <div class="record-heading">
      <div><h2 id="automation-run-heading">${automationResource(workflow)}</h2><p>${automationPill(AUTOMATION_WORKFLOW_STATE, workflow.state)} ${renderCopyChip({ value: workflow.id, label: 'Run ID' })}</p></div>
      ${cancel}
    </div>
    <section class="panel" aria-labelledby="automation-run-facts-heading">
      <h2 id="automation-run-facts-heading">Run</h2>
      <dl class="facts">
        <dt>Label</dt><dd class="mono wrap">${escape(workflow.label)}</dd>
        <dt>Event</dt><dd class="mono">${escape(workflow.eventType)}</dd>
        <dt>Rule</dt><dd>${escape(ruleName ?? workflow.ruleId)} <span class="mono">(generation ${escape(workflow.ruleGeneration)})</span></dd>
        <dt>Delivery</dt><dd class="mono wrap">${escape(workflow.deliveryId)}</dd>
        <dt>Workspace / agent</dt><dd>${automationWorkspaceLinks(workflow, true)}</dd>
        <dt>Agent status</dt><dd class="mono">${automationText(workflow.agentStatus, 'Not started')}</dd>
        <dt>Error</dt><dd class="mono wrap">${automationText(workflow.errorCode, 'None')}</dd>
        <dt>Publish</dt><dd>${automationPill(AUTOMATION_PUBLISH_STATE, workflow.publishState)}</dd>
        <dt>Usage</dt><dd>${automationUsage(workflow.usage)}</dd>
        <dt>Created</dt><dd>${time(workflow.createdAt)}</dd>
        <dt>Updated</dt><dd>${time(workflow.updatedAt)}</dd>
        <dt>Finished</dt><dd>${workflow.terminalAt ? time(workflow.terminalAt) : 'Not finished'}</dd>
      </dl>
    </section>
    <section class="panel" aria-labelledby="automation-result-heading">
      <h2 id="automation-result-heading">Result</h2>
      <p>The agent's answer, shown as plain text exactly as recorded.</p>
      ${resultBody}
    </section>
    <section class="panel" aria-labelledby="automation-transitions-heading">
      <h2 id="automation-transitions-heading">Transitions</h2>
      <ol class="activity-list automation-transitions">${timeline}</ol>
    </section>
  `;
}

const automationEventsText = (events) => automationList(events).map((event) => (AUTOMATION_GITHUB_EVENTS.find(([id]) => id === event)?.[1] ?? event)).join(', ');

/** One rule's trigger in a sentence, for every provider's match shape. */
export function automationMatchSummary(rule) {
  const match = rule?.match ?? {};
  const provider = automationMatchProvider(match);
  const filters = `${match.ignoreBots === false ? ' · bots allowed' : ''}${automationList(match.actorAllowlist).length ? ` · ${escape(match.actorAllowlist.length)} allowed actors` : ''}`;
  const labelText = match.label ? `label <span class="mono">${escape(match.label)}</span>` : '';
  if (provider === 'github') {
    return `<span class="mono wrap">${escape(match.repository)}</span><small>${escape(automationEventsText(match.events))} · ${labelText}${filters}</small>`;
  }
  const checkout = rule?.action?.repository ? ` · checks out <span class="mono">${escape(rule.action.repository)}</span>` : '';
  if (provider === 'custom') {
    return `<span class="mono wrap">${escape(match.event)}</span><small>Custom event${labelText ? ` · ${labelText}` : ''}${checkout}</small>`;
  }
  const scope = provider === 'jira' ? match.projectKey : match.teamKey;
  const target = provider === 'jira' ? match.toStatus : match.toState;
  const trigger = match.trigger === 'label_added' ? labelText : `moved to ${target ? `<span class="mono">${escape(target)}</span>` : 'any state'}`;
  return `<span class="mono wrap">${escape(automationProviderLabel(provider))} ${escape(scope ?? 'any team')}</span><small>${trigger}${filters}${checkout}</small>`;
}

function automationRuleActions(rule) {
  const id = escape(rule.id);
  const generation = escape(rule.generation);
  return `<div class="row-actions">
          <button type="button" data-automation-rule-edit="${id}">Edit</button>
          <button type="button" data-automation-rule-toggle="${id}" data-next-enabled="${rule.enabled ? 'false' : 'true'}" data-generation="${generation}">${rule.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" data-automation-rule-test="${id}">Test event</button>
          <button class="danger" type="button" data-automation-rule-delete="${id}" data-generation="${generation}" data-rule-name="${escape(rule.name)}">Delete</button>
        </div>`;
}

export function renderAutomationRules({ rules = [], connections = [], profiles = [] } = {}) {
  const list = automationList(rules);
  const connectionNames = new Map(automationList(connections).map((connection) => [connection.id, connection.name]));
  const profileNames = new Map(automationList(profiles).map((profile) => [profile.id, profile.displayName]));
  const enabledPill = (rule) => `<span class="status${rule.enabled ? ' enabled' : ''}">${rule.enabled ? 'Enabled' : 'Disabled'}</span>`;
  const match = (rule) => automationMatchSummary(rule);
  const agent = (rule) => `${escape(profileNames.get(rule.action?.profileId) ?? rule.action?.profileId)}<small>${rule.action?.publishComment ? 'Posts a comment' : 'No comment'} · ${escape(automationList(rule.action?.proxyOperations).length)} operations</small>`;
  const connection = (rule) => escape(connectionNames.get(rule.connectionId) ?? rule.connectionId);
  const rows = list.length ? list.map((rule) => `<tr>
        <th scope="row">${escape(rule.name)}<small class="mono wrap">${escape(rule.id)}</small></th>
        <td class="wrap">${connection(rule)}</td>
        <td>${match(rule)}</td>
        <td class="wrap">${agent(rule)}</td>
        <td>${enabledPill(rule)}</td>
        <td>${time(rule.updatedAt)}</td>
        <td>${automationRuleActions(rule)}</td>
      </tr>`).join('') : '<tr><td colspan="7">No rules yet.</td></tr>';
  const cards = list.length ? list.map((rule) => `<li><h3>${escape(rule.name)}</h3><dl><dt>Connection</dt><dd>${connection(rule)}</dd><dt>Match</dt><dd>${match(rule)}</dd><dt>Agent</dt><dd>${agent(rule)}</dd><dt>Status</dt><dd>${enabledPill(rule)}</dd></dl>${automationRuleActions(rule)}</li>`).join('')
    : '<li class="empty"><h3>No rules yet.</h3><p>A rule says which event starts an agent, and what that agent is told to do.</p></li>';
  const note = automationList(connections).length
    ? ''
    : '<div class="page-note"><strong>Create a connection first.</strong> Rules listen to a webhook connection (GitHub, Linear, Jira or a custom sender). <a href="/dashboard/automations/connections">Open Connections</a> to create one.</div>';
  const profileNote = automationList(profiles).length
    ? ''
    : '<p class="warning" role="status">No model profiles are available. Add one on <a href="/dashboard/models">Models &amp; Budgets</a> before saving a rule.</p>';
  return `${renderResourcePage({
    note: `${note}${profileNote}`,
    body: `<section class="automation-rules" aria-labelledby="automation-rules-heading"><div class="record-heading"><div><h2 id="automation-rules-heading">Rules</h2><p>Rules match exactly on their connection's provider: a GitHub repository and label, a Linear team or Jira project label or state change, or a custom event name. New rules start disabled until you enable them.</p></div></div><div class="desktop-table"><table><caption>${escape(list.length)} automation rules</caption><thead><tr><th>Name</th><th>Connection</th><th>Match</th><th>Agent</th><th>Status</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul></section>`
  })}<div id="automation-dialog-host"></div>`;
}

const automationChecked = (value) => (value ? ' checked' : '');
const automationNumberField = ({ id, name, label, value, min, max, step = 1, help }) => `<label for="${id}">${escape(label)}<input id="${id}" name="${name}" type="number" inputmode="${step === 1 ? 'numeric' : 'decimal'}" min="${min}" max="${max}" step="${step}" value="${escape(value)}" required></label>${help ? `<p class="field-help">${escape(help)}</p>` : ''}`;
const automationTextField = ({ id, name, label, value, required = false, maxlength = 100, placeholder = '', help }) => `<label for="${id}">${escape(label)}<input id="${id}" name="${name}"${required ? ' required' : ''} maxlength="${maxlength}" autocomplete="off" spellcheck="false"${placeholder ? ` placeholder="${escape(placeholder)}"` : ''} value="${escape(value ?? '')}"></label>${help ? `<p class="field-help">${help}</p>` : ''}`;
const automationProviderOf = (connections, connectionId) => automationList(connections).find((connection) => connection.id === connectionId)?.provider ?? 'github';

/** The bot and actor filters every provider except custom shares. */
function automationActorFields(match, provider) {
  const github = provider === 'github';
  const bots = github ? "Ignore bot senders (this harness's own GitHub App is always ignored when its slug is configured)" : 'Ignore bot and integration actors';
  return `<label class="checkbox-label"><input type="checkbox" name="ignoreBots"${automationChecked(match.ignoreBots !== false)}><span>${escape(bots)}</span></label>
      ${automationTextField({ id: 'automation-rule-actors', name: 'actorAllowlist', label: 'Allowed actors (optional)', value: automationList(match.actorAllowlist).join(', '), maxlength: 13000, placeholder: github ? 'octocat, hubot' : 'user id or email',
    help: github ? 'Comma-separated GitHub logins. Leave empty to let anyone who can label trigger the rule.' : `Comma-separated ${provider === 'jira' ? 'Jira account ids' : 'Linear user ids or emails'}. Leave empty to let anyone trigger the rule.` })}`;
}

/**
 * The provider-specific "When" fields of a rule, plus the checkout repository every non-GitHub
 * rule must pin. The dialog swaps this block when a new rule's connection changes provider.
 */
export function renderAutomationRuleMatchFields(provider = 'github', match = {}, action = {}) {
  if (provider === 'github') {
    const events = automationList(match.events).length ? match.events : ['issues'];
    const eventBoxes = AUTOMATION_GITHUB_EVENTS.map(([id, label]) => `<label class="checkbox-label"><input type="checkbox" name="events" value="${id}"${automationChecked(events.includes(id))}><span>${escape(label)} <code class="mono">${id}</code></span></label>`).join('');
    return `<label for="automation-rule-repository">Repository<input id="automation-rule-repository" name="repository" required maxlength="140" autocomplete="off" spellcheck="false" placeholder="owner/name" value="${escape(match.repository ?? '')}"></label>
      <p class="field-help">Exact GitHub <code>owner/name</code>, without <code>.git</code>.</p>
      <div role="group" aria-label="Events">${eventBoxes}</div>
      <label for="automation-rule-label">Added label<input id="automation-rule-label" name="label" required maxlength="100" autocomplete="off" value="${escape(match.label ?? '')}"></label>
      ${automationActorFields(match, provider)}`;
  }
  const checkout = automationTextField({ id: 'automation-rule-checkout', name: 'checkoutRepository', label: 'Repository to check out', value: action.repository, required: true, maxlength: 140, placeholder: 'owner/name',
    help: `The GitHub <code>owner/name</code> the workspace opens. ${escape(automationProviderLabel(provider))} events never choose a repository.` });
  if (provider === 'custom') {
    return `${automationTextField({ id: 'automation-rule-event', name: 'event', label: 'Event name', value: match.event, required: true, maxlength: 64, placeholder: 'deploy.finished', help: 'Exact <code>event</code> field of the signed payload: letters, digits and <code>. _ : -</code>.' })}
      ${automationTextField({ id: 'automation-rule-label', name: 'label', label: 'Label (optional)', value: match.label, help: 'When set, the event must also carry this label.' })}
      ${checkout}`;
  }
  const [stateTrigger, stateLabel] = AUTOMATION_STATE_TRIGGERS[provider] ?? ['state_changed', 'Moved to a state'];
  const jira = provider === 'jira';
  const trigger = match.trigger === stateTrigger ? stateTrigger : 'label_added';
  const triggerOptions = [['label_added', 'Label added'], [stateTrigger, stateLabel]].map(([id, label]) => `<option value="${id}"${trigger === id ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const scope = jira
    ? automationTextField({ id: 'automation-rule-scope', name: 'projectKey', label: 'Project key', value: match.projectKey, required: true, maxlength: 20, placeholder: 'ENG', help: 'The <code>ENG</code> of <code>ENG-123</code>.' })
    : automationTextField({ id: 'automation-rule-scope', name: 'teamKey', label: 'Team key (optional)', value: match.teamKey, maxlength: 16, placeholder: 'ENG', help: 'The <code>ENG</code> of <code>ENG-123</code>. Leave empty to match every team the webhook covers.' });
  return `${scope}
      <label for="automation-rule-trigger">Trigger<select id="automation-rule-trigger" name="trigger">${triggerOptions}</select></label>
      ${automationTextField({ id: 'automation-rule-label', name: 'label', label: 'Added label', value: match.label, help: 'Used when the trigger is Label added.' })}
      ${automationTextField({ id: 'automation-rule-to-state', name: 'toState', label: jira ? 'Status (optional)' : 'Workflow state (optional)', value: jira ? match.toStatus : match.toState, help: `Used when the trigger is ${escape(stateLabel)}. Leave empty to match any ${jira ? 'status' : 'state'}.` })}
      ${automationActorFields(match, provider)}
      ${checkout}`;
}

/** The create/edit form for one rule. An edit cannot move a rule to another connection, so that field is fixed. */
export function renderAutomationRuleDialog({ rule, connections = [], profiles = [] } = {}) {
  const editing = Boolean(rule);
  const match = rule?.match ?? {};
  const action = rule?.action ?? {};
  const provider = editing ? automationMatchProvider(match) : automationProviderOf(connections, automationList(connections)[0]?.id);
  const budget = { ...AUTOMATION_RULE_DEFAULTS, ...(action.budget ?? {}) };
  const operations = automationList(action.proxyOperations).length ? action.proxyOperations : AUTOMATION_DEFAULT_PROXY_OPERATIONS;
  const connectionOptions = automationList(connections).map((connection) => `<option value="${escape(connection.id)}" data-provider="${escape(connection.provider ?? 'github')}"${rule?.connectionId === connection.id ? ' selected' : ''}>${escape(connection.name)} · ${escape(automationProviderLabel(connection.provider ?? 'github'))}${connection.enabled ? '' : ' (disabled)'}</option>`).join('');
  const profileList = automationList(profiles);
  const missingProfile = action.profileId && !profileList.some((profile) => profile.id === action.profileId)
    ? `<option value="${escape(action.profileId)}" selected>${escape(action.profileId)} (not found)</option>` : '';
  const profileOptions = profileList.map((profile) => `<option value="${escape(profile.id)}"${action.profileId === profile.id ? ' selected' : ''}>${escape(profile.displayName)} (${escape(profile.id)})${profile.status && profile.status !== 'ACTIVE' ? ` - ${escape(String(profile.status).toLowerCase())}` : ''}</option>`).join('');
  const operationBoxes = AUTOMATION_PROXY_OPERATIONS.map((operation) => `<label class="checkbox-label"><input type="checkbox" name="proxyOperations" value="${operation}"${automationChecked(operations.includes(operation))}><span><code class="mono">${operation}</code></span></label>`).join('');
  const costUsd = Number.isFinite(budget.maxCostMicros) ? String(budget.maxCostMicros / 1_000_000) : '2';
  const body = `
    <input type="hidden" name="ruleId" value="${escape(rule?.id ?? '')}">
    <input type="hidden" name="expectedGeneration" value="${escape(rule?.generation ?? '')}">
    <label for="automation-rule-name">Rule name<input id="automation-rule-name" name="name" required maxlength="100" autocomplete="off" value="${escape(rule?.name ?? '')}"></label>
    <label for="automation-rule-connection">Connection<select id="automation-rule-connection" name="connectionId" required${editing ? ' disabled' : ''}>${connectionOptions}</select></label>
    ${editing ? '<p class="field-help">A rule stays on the connection it was created for.</p>' : ''}
    <fieldset class="automation-fieldset"><legend>When</legend>
      <div id="automation-rule-match" class="automation-match" data-provider="${escape(provider)}">${renderAutomationRuleMatchFields(provider, match, action)}</div>
    </fieldset>
    <fieldset class="automation-fieldset"><legend>Then</legend>
      <label for="automation-rule-ref">Branch or tag (optional)<input id="automation-rule-ref" name="ref" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Default branch" value="${escape(action.ref ?? '')}"></label>
      <label for="automation-rule-profile">Model profile<select id="automation-rule-profile" name="profileId" required>${missingProfile}${profileOptions}</select></label>
      <label for="automation-rule-instructions">Instructions<textarea id="automation-rule-instructions" name="instructions" required maxlength="16000" spellcheck="true">${escape(action.instructions ?? '')}</textarea></label>
      <p class="field-help">The agent also receives the source issue, pull request or ticket title and body as untrusted context.</p>
      <div role="group" aria-label="Allowed operations">${operationBoxes}</div>
      <label class="checkbox-label"><input type="checkbox" name="publishComment"${automationChecked(action.publishComment === true)}><span>Post the agent's answer as one comment on the source issue, pull request or ticket</span></label>
      <p class="field-help">Linear and Jira comments need the connection's outbound credential.</p>
    </fieldset>
    <fieldset class="automation-fieldset"><legend>Limits</legend>
      ${automationNumberField({ id: 'automation-rule-ttl', name: 'ttlSeconds', label: 'Time limit (seconds)', value: budget.ttlSeconds, min: 60, max: 7200 })}
      ${automationNumberField({ id: 'automation-rule-input-tokens', name: 'maxInputTokens', label: 'Max input tokens', value: budget.maxInputTokens, min: 1, max: 2000000 })}
      ${automationNumberField({ id: 'automation-rule-output-tokens', name: 'maxOutputTokens', label: 'Max output tokens', value: budget.maxOutputTokens, min: 1, max: 2000000 })}
      ${automationNumberField({ id: 'automation-rule-cost', name: 'maxCostUsd', label: 'Max cost (USD)', value: costUsd, min: 0, max: 100, step: 0.000001 })}
      ${automationNumberField({ id: 'automation-rule-cooldown', name: 'cooldownSeconds', label: 'Cooldown (seconds)', value: action.cooldownSeconds ?? AUTOMATION_RULE_DEFAULTS.cooldownSeconds, min: 0, max: 86400, help: 'A repeat trigger on the same resource is ignored for this long after a run ends.' })}
      ${automationNumberField({ id: 'automation-rule-concurrency', name: 'maxConcurrent', label: 'Max concurrent runs', value: action.maxConcurrent ?? AUTOMATION_RULE_DEFAULTS.maxConcurrent, min: 1, max: 5 })}
    </fieldset>
    <label class="checkbox-label"><input type="checkbox" name="enabled"${automationChecked(rule?.enabled === true)}><span>Enabled</span></label>`;
  return renderFormDialog({
    id: 'automation-rule-dialog', title: editing ? 'Edit rule' : 'New rule',
    description: 'A matching delivery opens a workspace and runs one agent with these instructions.',
    formId: 'automation-rule-form', submitId: 'automation-rule-submit', submitLabel: editing ? 'Save rule' : 'Create rule', body
  });
}

/** The sample's scope prefilled from the rule: team or project key, or the custom event name. */
const automationPreviewScope = (provider, match) => (provider === 'jira' ? match.projectKey : provider === 'custom' ? match.event : match.teamKey) ?? '';

/**
 * A sample delivery checked against one saved rule without starting anything. GitHub keeps its
 * original sample; every other provider sends the normalized sample the runner matches on.
 */
export function renderAutomationPreviewDialog(rule, provider = automationMatchProvider(rule?.match)) {
  const match = rule?.match ?? {};
  const intro = { id: 'automation-preview-dialog', title: 'Test event', description: `Check whether a sample delivery would match "${rule?.name ?? 'this rule'}". Nothing is started.`, formId: 'automation-preview-form', submitId: 'automation-preview-submit', submitLabel: 'Test event' };
  const head = `<input type="hidden" name="ruleId" value="${escape(rule?.id ?? '')}"><input type="hidden" name="provider" value="${escape(provider)}">`;
  const result = '<div id="automation-preview-result" class="automation-preview-result" aria-live="polite"></div>';
  if (provider === 'github') {
    const firstEvent = automationList(match.events)[0] ?? 'issues';
    const eventOptions = AUTOMATION_GITHUB_EVENTS.map(([id, label]) => `<option value="${id}"${id === firstEvent ? ' selected' : ''}>${escape(label)}</option>`).join('');
    const senderOptions = AUTOMATION_SENDER_TYPES.map((type) => `<option value="${type}">${type}</option>`).join('');
    return renderFormDialog({
      ...intro,
      body: `${head}
      <label for="automation-preview-event">Event<select id="automation-preview-event" name="event">${eventOptions}</select></label>
      <label for="automation-preview-repository">Repository<input id="automation-preview-repository" name="repository" required autocomplete="off" spellcheck="false" value="${escape(match.repository ?? '')}"></label>
      <label for="automation-preview-label">Added label<input id="automation-preview-label" name="label" required maxlength="100" autocomplete="off" value="${escape(match.label ?? '')}"></label>
      <label for="automation-preview-sender">Sender login<input id="automation-preview-sender" name="senderLogin" required maxlength="45" autocomplete="off" spellcheck="false" placeholder="octocat"></label>
      <label for="automation-preview-sender-type">Sender type<select id="automation-preview-sender-type" name="senderType">${senderOptions}</select></label>
      ${result}`
    });
  }
  const stateTrigger = AUTOMATION_STATE_TRIGGERS[provider]?.[0];
  const eventTypes = AUTOMATION_PROVIDER_EVENT_TYPES[provider] ?? [];
  const selected = stateTrigger && match.trigger === stateTrigger ? eventTypes.find((type) => type.endsWith(stateTrigger)) : eventTypes[0];
  const eventOptions = eventTypes.map((type) => `<option value="${escape(type)}"${type === selected ? ' selected' : ''}>${escape(type)}</option>`).join('');
  const stateFields = stateTrigger ? `
      ${automationTextField({ id: 'automation-preview-from-state', name: 'fromState', label: 'From state (optional)', value: '' })}
      ${automationTextField({ id: 'automation-preview-to-state', name: 'toState', label: 'To state (optional)', value: provider === 'jira' ? match.toStatus : match.toState, help: 'Used by state and status events.' })}` : '';
  const scopeLabel = provider === 'jira' ? 'Project key' : provider === 'custom' ? 'Event name' : 'Team key';
  return renderFormDialog({
    ...intro,
    body: `${head}
      <label for="automation-preview-event-type">Event type<select id="automation-preview-event-type" name="eventType">${eventOptions}</select></label>
      ${automationTextField({ id: 'automation-preview-scope', name: 'scope', label: scopeLabel, value: automationPreviewScope(provider, match) || (provider === 'linear' ? 'ENG' : ''), required: true, maxlength: 200 })}
      ${automationTextField({ id: 'automation-preview-label', name: 'label', label: provider === 'custom' ? 'Label (optional)' : 'Added label (optional)', value: match.label })}
      ${stateFields}
      ${automationTextField({ id: 'automation-preview-actor', name: 'actorLogin', label: 'Actor', value: '', required: true, maxlength: 254, placeholder: 'user id or email' })}
      <label class="checkbox-label"><input type="checkbox" name="actorIsBot"><span>The actor is a bot or integration</span></label>
      ${result}`
  });
}

export function renderAutomationPreviewResult(preview) {
  const matched = preview?.matched === true;
  return `<p><span class="status${matched ? ' succeeded' : ' failed'}">${matched ? 'Would match' : 'Would not match'}</span> <span class="wrap">${escape(preview?.reason ?? '')}</span></p>`;
}

const automationCountsText = (counts) => (counts
  ? AUTOMATION_DELIVERY_STATES.map((state) => `${escape(countOf(counts[state] ?? 0))} ${escape(AUTOMATION_DELIVERY_STATE[state][0].toLowerCase())}`).join(' · ')
  : 'Not reported');

/** Health facts for one connection, or one line saying health could not be read. */
function automationHealthFacts(health, available) {
  if (!available) return '<dt>Health</dt><dd>Not available right now</dd>';
  if (!health) return '';
  const quarantine = health.lastQuarantine
    ? `<span class="mono wrap">${escape(health.lastQuarantine.reason)}</span><small>${time(health.lastQuarantine.at)}</small>`
    : 'None';
  return `<dt>Last 24 hours</dt><dd>${automationCountsText(health.last24h)}</dd><dt>Last 7 days</dt><dd>${automationCountsText(health.last7d)}</dd><dt>Last quarantine</dt><dd>${quarantine}</dd>`;
}

/** Whether results can be posted back: GitHub uses the harness App, the others a stored credential. */
function automationOutboundText(connection) {
  if (connection.provider === 'github') return 'Uses the GitHub App when one is installed';
  if (connection.provider === 'custom') return 'Not supported';
  return connection.outboundConfigured ? '<span class="status enabled">Configured</span>' : '<span class="status">Not configured</span>';
}

function automationConnectionCard(connection, origin, health, healthAvailable) {
  const id = escape(connection.id);
  const generation = escape(connection.generation);
  const url = automationWebhookUrl(origin, connection.webhookPath);
  const baseUrl = connection.config?.baseUrl ? `<dt>Jira site</dt><dd class="mono wrap">${escape(connection.config.baseUrl)}</dd>` : '';
  return `<li class="panel automation-connection"><div class="record-heading"><div><h3>${escape(connection.name)}</h3><p><span class="status${connection.enabled ? ' enabled' : ''}">${connection.enabled ? 'Enabled' : 'Disabled'}</span> <span>${escape(automationProviderLabel(connection.provider))}</span></p></div><div class="row-actions">
        <button type="button" data-automation-connection-toggle="${id}" data-next-enabled="${connection.enabled ? 'false' : 'true'}" data-generation="${generation}">${connection.enabled ? 'Disable' : 'Enable'}</button>
        <button type="button" data-automation-connection-rotate="${id}" data-generation="${generation}" data-connection-name="${escape(connection.name)}">Rotate secret</button>
        <button class="danger" type="button" data-automation-connection-delete="${id}" data-generation="${generation}" data-connection-name="${escape(connection.name)}">Delete</button>
      </div></div><dl class="facts"><dt>Provider</dt><dd class="mono">${escape(connection.provider)}</dd><dt>Webhook URL</dt><dd>${renderCopyChip({ value: url, label: 'Webhook URL' })}</dd><dt>Webhook path</dt><dd class="mono wrap">${escape(connection.webhookPath)}</dd>${baseUrl}<dt>Post back</dt><dd>${automationOutboundText(connection)}</dd><dt>Connection ID</dt><dd class="mono wrap">${id}</dd><dt>Secret rotated</dt><dd>${optionalTime(connection.secretRotatedAt)}</dd><dt>Last delivery</dt><dd>${optionalTime(health?.lastDeliveryAt ?? connection.lastDeliveryAt)}</dd>${automationHealthFacts(health, healthAvailable)}<dt>Created</dt><dd>${optionalTime(connection.createdAt)}</dd></dl></li>`;
}

/** A write-only credential input: a password field with no value attribute, cleared after submit. */
const automationSecretField = ({ id, name, label, help }) => `<label for="${id}">${escape(label)}<input id="${id}" name="${name}" type="password" minlength="8" maxlength="1024" autocomplete="new-password" spellcheck="false" data-write-only></label><p class="field-help">${escape(help)}</p>`;

/** The create form: provider fields sit in disabled, hidden fieldsets so only the chosen provider's fields submit. */
function renderAutomationConnectionDialog() {
  const providerOptions = AUTOMATION_PROVIDERS.map(([id, label]) => `<option value="${id}"${id === 'github' ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const body = `<label for="automation-connection-name">Connection name<input id="automation-connection-name" name="name" required maxlength="100" autocomplete="off" placeholder="acme GitHub"></label>
    <label for="automation-connection-provider">Provider<select id="automation-connection-provider" name="provider" required>${providerOptions}</select></label>
    <fieldset class="automation-fieldset" data-automation-provider-fields="linear" hidden disabled><legend>Linear</legend>
      ${automationSecretField({ id: 'automation-connection-linear-key', name: 'apiKey', label: 'API key (optional)', help: 'Only used to post the agent\'s answer back as a comment. Stored sealed in the runner and never shown again.' })}
    </fieldset>
    <fieldset class="automation-fieldset" data-automation-provider-fields="jira" hidden disabled><legend>Jira</legend>
      <label for="automation-connection-jira-site">Site URL<input id="automation-connection-jira-site" name="baseUrl" type="url" required maxlength="300" autocomplete="off" spellcheck="false" placeholder="https://example.atlassian.net"></label>
      <label for="automation-connection-jira-email">Account email (optional)<input id="automation-connection-jira-email" name="email" type="email" maxlength="254" autocomplete="off" spellcheck="false"></label>
      ${automationSecretField({ id: 'automation-connection-jira-token', name: 'apiToken', label: 'API token (optional)', help: 'Set with the account email to post answers back as comments. Stored sealed in the runner and never shown again.' })}
    </fieldset>`;
  return renderFormDialog({
    id: 'automation-connection-dialog', title: 'New connection',
    description: 'The signing secret is shown once after the connection is created and cannot be recovered.',
    formId: 'automation-connection-form', submitId: 'automation-connection-submit', submitLabel: 'Create connection', body
  });
}

/**
 * `health` is the `connection_health` list, or `null` when it could not be read; the page still
 * renders every connection either way.
 */
export function renderAutomationConnections({ connections = [], origin = '', health = [] } = {}) {
  const list = automationList(connections);
  const healthAvailable = health !== null;
  const byId = new Map(automationList(health).map((entry) => [entry.connectionId, entry]));
  const items = list.length ? list.map((connection) => automationConnectionCard(connection, origin, byId.get(connection.id), healthAvailable)).join('')
    : '<li class="empty"><h3>No connections yet.</h3><p>Create a webhook connection to get a payload URL and a signing secret for GitHub, Linear, Jira or your own sender.</p></li>';
  return `${renderResourcePage({
    body: `<section aria-labelledby="automation-connections-heading"><div class="record-heading"><div><h2 id="automation-connections-heading">Connections</h2><p>Each connection is one webhook endpoint for one provider, with its own signing secret. Deliveries with a bad signature are refused and not recorded.</p></div></div><ul class="record-list automation-connection-list">${items}</ul></section>`
  })}${renderAutomationConnectionDialog()}`;
}

/** Where to paste the URL and secret, per provider. */
function automationSecretInstructions(connection) {
  const name = `<strong>${escape(connection?.name ?? 'this connection')}</strong>`;
  switch (connection?.provider) {
    case 'linear':
      return `<p>In Linear, a webhook made on the settings page signs with Linear's own secret, so create the webhook for ${name} through Linear's GraphQL API instead: as a workspace admin, call <code>webhookCreate</code> with this URL as <code>url</code>, this secret as <code>secret</code>, <code>resourceTypes: ["Issue"]</code>, and a <code>teamId</code> or <code>allPublicTeams: true</code>. After a rotation, set the new secret with <code>webhookUpdate</code>. Linear posts <code>application/json</code>.</p>`;
    case 'jira':
      return `<p>In Jira, as an admin, open <strong>Settings → System → WebHooks → Create a WebHook</strong> for ${name}, paste this URL and this secret into its <strong>Secret</strong> field, and select the <strong>Issue updated</strong> event. Jira posts <code>application/json</code>.</p>`;
    case 'custom':
      return `<p>Your sender posts <code>application/json</code> to this URL for ${name} with the <code>x-cloudharness-delivery</code>, <code>x-cloudharness-timestamp</code> and <code>x-cloudharness-signature</code> headers, signed with this secret.</p>`;
    default:
      return `<p>In GitHub, open the repository's <strong>Settings → Webhooks → Add webhook</strong> for ${name}. Use content type <code>application/json</code> and select the <strong>Issues</strong> and/or <strong>Pull requests</strong> events.</p>`;
  }
}

/**
 * The one-time reveal for a new or rotated signing secret. The secret itself is never
 * rendered into markup: the loader writes it into the read-only field afterwards and
 * clears it on dismissal, the same rule the API-key reveal follows.
 */
export function renderAutomationSecretPanel({ connection, origin = '', rotated = false } = {}) {
  const url = automationWebhookUrl(origin, connection?.webhookPath);
  const provider = automationProviderLabel(connection?.provider ?? 'github');
  return `<section id="automation-secret-panel" class="panel automation-secret-panel" aria-labelledby="automation-secret-heading" tabindex="-1">
      <h2 id="automation-secret-heading">${rotated ? 'Copy the new signing secret now' : 'Copy the webhook secret now'}</h2>
      <p class="warning"><strong>This secret is shown once.</strong> It cannot be recovered after you dismiss this panel or leave the page. ${rotated ? `The previous secret no longer verifies deliveries, so update the ${escape(provider)} webhook now.` : 'Rotate the secret if you lose it.'}</p>
      ${automationSecretInstructions(connection)}
      <label for="automation-webhook-url">Payload URL</label>
      <div class="automation-copy-row"><input id="automation-webhook-url" class="mono" readonly value="${escape(url)}"><button type="button" id="copy-automation-webhook-url">Copy URL</button></div>
      <label for="automation-webhook-secret">Secret</label>
      <div class="automation-copy-row"><input id="automation-webhook-secret" class="mono" readonly autocomplete="off" spellcheck="false"><button type="button" id="copy-automation-webhook-secret">Copy secret</button></div>
      <p id="automation-secret-status" class="form-status" aria-live="polite"></p>
      <div class="row-actions"><button type="button" class="accent-btn" id="dismiss-automation-secret">I saved the secret</button></div>
    </section>`;
}

const automationDeliveryReplay = (delivery) => (delivery.replayable
  ? `<button type="button" data-automation-delivery-replay="${escape(delivery.id)}" data-state="${escape(delivery.state)}">Replay</button>`
  : '');

export function renderAutomationDeliveries({ deliveries = [], connections = [], filters = {} } = {}) {
  const list = automationList(deliveries);
  const connectionNames = new Map(automationList(connections).map((connection) => [connection.id, connection.name]));
  const connectionOptions = automationList(connections).map((connection) => `<option value="${escape(connection.id)}"${filters.connectionId === connection.id ? ' selected' : ''}>${escape(connection.name)}</option>`).join('');
  const stateOptions = AUTOMATION_DELIVERY_STATES.map((state) => `<option value="${state}"${filters.state === state ? ' selected' : ''}>${escape(state === 'QUARANTINED' ? 'Quarantined (dead letter)' : AUTOMATION_DELIVERY_STATE[state][0])}</option>`).join('');
  const resource = (delivery) => (delivery.repository || delivery.resourceRef ? `<span class="mono wrap">${escape(automationResourceText(delivery))}</span>` : '—');
  const event = (delivery) => `<span class="mono">${escape(delivery.providerEvent)}</span>${delivery.eventType ? `<small class="mono">${escape(delivery.eventType)}</small>` : ''}`;
  const empty = filters.state ? 'No deliveries in this state.' : 'No deliveries received yet.';
  const rows = list.length ? list.map((delivery) => `<tr>
        <th scope="row">${time(delivery.receivedAt)}</th>
        <td class="wrap">${escape(connectionNames.get(delivery.connectionId) ?? delivery.connectionId)}</td>
        <td>${event(delivery)}</td>
        <td>${resource(delivery)}</td>
        <td class="mono wrap">${automationText(delivery.label)}</td>
        <td>${automationPill(AUTOMATION_DELIVERY_STATE, delivery.state)}</td>
        <td class="mono wrap">${automationText(delivery.outcome)}</td>
        <td class="mono">${escape(countOf(delivery.workflowsCreated))}</td>
        <td class="mono wrap">${escape(delivery.providerDeliveryId)}</td>
        <td>${automationDeliveryReplay(delivery)}</td>
      </tr>`).join('') : `<tr><td colspan="10">${empty}</td></tr>`;
  const cards = list.length ? list.map((delivery) => `<li><h3>${time(delivery.receivedAt)}</h3><dl><dt>Event</dt><dd>${event(delivery)}</dd><dt>Resource</dt><dd>${resource(delivery)}</dd><dt>Label</dt><dd class="mono wrap">${automationText(delivery.label)}</dd><dt>State</dt><dd>${automationPill(AUTOMATION_DELIVERY_STATE, delivery.state)}</dd><dt>Outcome</dt><dd class="mono wrap">${automationText(delivery.outcome)}</dd><dt>Runs</dt><dd class="mono">${escape(countOf(delivery.workflowsCreated))}</dd></dl>${delivery.replayable ? `<div class="row-actions">${automationDeliveryReplay(delivery)}</div>` : ''}</li>`).join('')
    : `<li class="empty"><h3>${empty}</h3><p>Deliveries appear once a provider posts to a connection's webhook URL with a valid signature.</p></li>`;
  return renderResourcePage({
    filters: `<form id="automation-deliveries-filter" aria-label="Filter deliveries"><label for="automation-deliveries-connection">Connection</label><select id="automation-deliveries-connection" name="connectionId"><option value="">All connections</option>${connectionOptions}</select><label for="automation-deliveries-state">State</label><select id="automation-deliveries-state" name="state"><option value="">All states</option>${stateOptions}</select><button type="submit">Apply filter</button></form>`,
    body: `<section aria-labelledby="automation-deliveries-heading"><div class="record-heading"><div><h2 id="automation-deliveries-heading">Recent deliveries</h2><p>Signed inbound webhooks, newest first. Deliveries are kept for 30 days. Quarantined deliveries verified but could not be read. Replay matches a stored event against the rules as they are now; a rule that already ran for that delivery is skipped.</p></div></div><div class="desktop-table"><table><caption>${escape(list.length)} deliveries</caption><thead><tr><th>Received</th><th>Connection</th><th>Event</th><th>Resource</th><th>Label</th><th>State</th><th>Outcome</th><th>Runs</th><th>Delivery ID</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul></section>`
  });
}

const automationRate = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'No finished runs');
const automationLatency = (value) => {
  if (!Number.isFinite(value)) return '—';
  return value < 1_000 ? `${value} ms` : value < 120_000 ? `${(value / 1_000).toFixed(1)} s` : `${(value / 60_000).toFixed(1)} min`;
};
const automationOutcomes = (entry) => `${escape(countOf(entry.completed))} completed · ${escape(countOf(entry.failed))} failed · ${escape(countOf(entry.cancelled + entry.expired))} cancelled or expired${entry.active ? ` · ${escape(countOf(entry.active))} active` : ''}`;
const automationTokens = (entry) => `${escape(countOf(entry.inputTokens))} in · ${escape(countOf(entry.outputTokens))} out`;
const automationLatencyText = (entry) => `p50 ${escape(automationLatency(entry.latencyP50Ms))} · p95 ${escape(automationLatency(entry.latencyP95Ms))}`;

function automationMetricsTable({ id, title, caption, entries, nameOf }) {
  const rows = entries.map((entry) => `<tr>
        <th scope="row">${nameOf(entry)}</th>
        <td class="mono">${escape(countOf(entry.workflows))}</td>
        <td>${automationOutcomes(entry)}</td>
        <td class="mono">${escape(automationRate(entry.successRate))}</td>
        <td class="mono">${escape(costOf(entry.costMicros))}</td>
        <td class="mono nowrap">${automationTokens(entry)}</td>
        <td class="mono nowrap">${automationLatencyText(entry)}</td>
      </tr>`).join('');
  const cards = entries.map((entry) => `<li><h3>${nameOf(entry)}</h3><dl><dt>Runs</dt><dd class="mono">${escape(countOf(entry.workflows))}</dd><dt>Outcomes</dt><dd>${automationOutcomes(entry)}</dd><dt>Success rate</dt><dd class="mono">${escape(automationRate(entry.successRate))}</dd><dt>Cost</dt><dd class="mono">${escape(costOf(entry.costMicros))}</dd><dt>Tokens</dt><dd class="mono">${automationTokens(entry)}</dd><dt>Latency</dt><dd class="mono">${automationLatencyText(entry)}</dd></dl></li>`).join('');
  return `<section class="panel" aria-labelledby="${id}"><h2 id="${id}">${escape(title)}</h2><div class="desktop-table"><table><caption>${escape(caption)}</caption><thead><tr><th>${escape(title === 'By provider' ? 'Provider' : 'Rule')}</th><th>Runs</th><th>Outcomes</th><th>Success rate</th><th>Cost</th><th>Tokens</th><th>Latency</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul></section>`;
}

/**
 * Outcomes, cost and latency of runs created in the chosen window, per provider and per rule.
 * `error` renders the read failure in place, keeping the window picker usable.
 */
export function renderAutomationMetrics({ metrics, windowDays = 7, error } = {}) {
  const windowOptions = AUTOMATION_METRICS_WINDOWS.map((days) => `<option value="${days}"${Number(windowDays) === days ? ' selected' : ''}>${days === 1 ? 'Last 24 hours' : `Last ${days} days`}</option>`).join('');
  const filters = `<form id="automation-metrics-filter" aria-label="Metrics window"><label for="automation-metrics-window">Window</label><select id="automation-metrics-window" name="windowDays">${windowOptions}</select><button type="submit">Apply</button></form>`;
  const providers = automationList(metrics?.providers);
  const rules = automationList(metrics?.rules);
  const intro = `<div class="record-heading"><div><h2 id="automation-metrics-heading">Metrics</h2><p>Runs created${metrics?.since ? ` since ${time(metrics.since)}` : ' in the window'}. Success rate counts completed runs among finished ones; latency is the time from a run's creation to its end, for completed runs only.</p></div></div>`;
  const body = error
    ? `<div class="empty" role="alert"><h3>Metrics could not be loaded.</h3><p>${escape(error.message ?? 'The request could not be completed.')}</p><button type="button" data-automation-retry>Try again</button></div>`
    : providers.length
    ? `${automationMetricsTable({ id: 'automation-metrics-providers', title: 'By provider', caption: `${providers.length} providers`, entries: providers, nameOf: (entry) => escape(automationProviderLabel(entry.provider)) })}${automationMetricsTable({ id: 'automation-metrics-rules', title: 'By rule', caption: `${rules.length} rules, busiest first`, entries: rules, nameOf: (entry) => `${escape(entry.name)}<small>${escape(automationProviderLabel(entry.provider))}${entry.deleted ? ' · deleted' : ''}</small>` })}`
    : '<div class="empty" role="status"><h3>No runs in this window.</h3><p>Metrics appear once a delivery matches an enabled rule and starts a run.</p></div>';
  return renderResourcePage({ filters, body: `<section class="automation-metrics" aria-labelledby="automation-metrics-heading">${intro}${body}</section>` });
}
