const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const statusLabel = (status) => ({ CREATING: 'Creating', ACTIVE: 'Active', REAPING: 'Closing', CLOSED: 'Closed', FAILED: 'Failed' })[status] ?? 'Unknown';
const networkLabel = (mode) => mode === 'bridge' ? 'Bridge enabled' : 'No network';
const time = (value) => `<time datetime="${escape(value)}">${escape(new Date(value).toLocaleString())}</time>`;

export function renderWorkspaceIndex(workspaces, query) {
  const filtered = workspaces.filter((workspace) => {
    const term = query.q.toLowerCase();
    return (!query.status || workspace.status === query.status) && (!term || `${workspace.repositoryUrl} ${workspace.workspaceId}`.toLowerCase().includes(term));
  });
  if (!workspaces.length) return '<h2 id="workspace-list-heading">Workspace list</h2><div class="empty"><h3>No workspaces yet.</h3><p>Open one from an MCP client and it will appear here.</p></div>';
  if (!filtered.length) return '<h2 id="workspace-list-heading">Workspace list</h2><div class="empty"><h3>No workspaces match these filters.</h3><button id="clear-filters" type="button">Clear filters</button></div>';
  const rows = filtered.map((workspace) => `<tr><th scope="row"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a><small class="mono">${escape(workspace.workspaceId)}</small></th><td><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span></td><td>${time(workspace.lastActivityAt)}</td><td>${time(workspace.expiresAt)}</td><td>${networkLabel(workspace.networkMode)}</td></tr>`).join('');
  const cards = filtered.map((workspace) => `<li><h3><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a></h3><dl><dt>State</dt><dd>${statusLabel(workspace.status)}</dd><dt>Last activity</dt><dd>${time(workspace.lastActivityAt)}</dd><dt>Expires</dt><dd>${time(workspace.expiresAt)}</dd></dl></li>`).join('');
  return `<h2 id="workspace-list-heading">Workspace list</h2><div class="desktop-table"><table><caption>${filtered.length} workspaces</caption><thead><tr><th>Repository</th><th>State</th><th>Last activity</th><th>Expires</th><th>Network</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

export function renderWorkspaceDetail(workspace, dedicated = false, modal = false) {
  const heading = dedicated ? 'h1' : 'h2';
  const warning = workspace.networkMode === 'bridge' ? '<p class="warning">Executor network access is enabled for this workspace.</p>' : '';
  const close = modal ? '<button id="close-detail" class="drawer-close" type="button">Close workspace details</button>' : '';
  return `${close}<${heading} id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</${heading}><p class="mono wrap">${escape(workspace.workspaceId)}</p><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span><ol class="lifecycle" aria-label="Workspace lifecycle"><li><strong>Created</strong>${time(workspace.createdAt)}</li><li><strong>Last activity</strong>${time(workspace.lastActivityAt)}</li><li><strong>Expires</strong>${time(workspace.expiresAt)}</li></ol><dl class="facts"><dt>Repository</dt><dd class="wrap">${escape(workspace.repositoryUrl)}</dd><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd><dt>Network</dt><dd>${networkLabel(workspace.networkMode)}</dd></dl>${warning}<nav class="detail-actions" aria-label="Workspace sections"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/files">Files</a><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/runtime">Runtime</a></nav><div class="danger-zone"><button id="close-workspace" class="danger" type="button" ${workspace.version ? '' : 'disabled'}>Close workspace</button>${workspace.version ? '' : '<p>Close is unavailable until lifecycle fencing is ready.</p>'}</div>`;
}

export function renderProjectIndex(projects) {
  const items = projects.length
    ? `<ul class="card-grid">${projects.map((project) => `<li class="panel"><h3><a href="/dashboard/projects/${encodeURIComponent(project.id)}">${escape(project.name)}</a></h3><p class="mono wrap">${escape(project.id)}</p><p>Generation ${escape(project.generation)}</p></li>`).join('')}</ul>`
    : '<div class="empty"><h3>No projects yet.</h3><p>Create a project to group retained environment metadata.</p></div>';
  return `<div class="page-note"><strong>Retained control-plane metadata.</strong> Projects and environments persist independently from volatile workspace runtime.</div><section aria-labelledby="project-list-heading"><h2 id="project-list-heading">Projects</h2>${items}</section><section class="panel" aria-labelledby="create-project-heading"><h2 id="create-project-heading">Create project</h2><form id="create-project-form" class="stack-form"><label for="project-name">Project name</label><input id="project-name" name="name" required maxlength="100"><button type="submit">Create project</button><p class="form-status" aria-live="polite"></p></form></section>`;
}

export function renderProjectDetail(project, environments) {
  const environmentItems = environments.length ? environments.map((environment) => {
    const secrets = Array.isArray(environment.secrets) ? environment.secrets : [];
    const secretRows = secrets.length ? secrets.map((secret) => `<li class="secret-reference"><div><strong>${escape(secret.name)}</strong><span class="status">${escape(secret.state ?? 'unknown')}</span><small>Version ${escape(secret.version ?? secret.generation)} · Generation ${escape(secret.generation)}</small></div><form class="rotate-secret-form inline-form" data-environment-id="${escape(environment.id)}" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>New write-only value<input name="value" type="password" autocomplete="new-password" data-write-only required></label><button type="submit">Rotate</button><p class="form-status" aria-live="polite"></p></form><button class="danger delete-secret" type="button" data-environment-id="${escape(environment.id)}" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}">Delete secret reference</button></li>`).join('') : '<li>No secret references.</li>';
    const readiness = environment.readiness?.ready === false ? `<p class="warning">Secret storage unavailable: ${escape(environment.readiness.error ?? 'Review runner readiness.')}</p>` : '';
    return `<li class="panel environment-card"><div class="record-heading"><div><h3>${escape(environment.name)}</h3><p class="mono wrap">${escape(environment.id)}</p></div><button class="danger delete-environment" type="button" data-environment-id="${escape(environment.id)}" data-generation="${escape(environment.generation)}">Delete environment</button></div>${readiness}<section aria-labelledby="secrets-${escape(environment.id)}"><h4 id="secrets-${escape(environment.id)}">Write-only secret references</h4><p>Values can be submitted or rotated, but are never returned or rendered after submission.</p><ul class="record-list">${secretRows}</ul><form class="create-secret-form stack-form" data-environment-id="${escape(environment.id)}"><label>Secret name<input name="name" required maxlength="100" autocomplete="off"></label><label>Write-only value<input name="value" type="password" required autocomplete="new-password" data-write-only></label><button type="submit">Create secret reference</button><p class="form-status" aria-live="polite"></p></form></section></li>`;
  }).join('') : '<li class="empty">No environments yet.</li>';
  return `<nav aria-label="Breadcrumb"><a href="/dashboard/projects">Projects</a><span>${escape(project.name)}</span></nav><div class="page-note"><strong>Retained configuration metadata.</strong> Secret values are write-only and never displayed. Workspace task and session state remains volatile.</div><div class="record-heading"><div><h2>${escape(project.name)}</h2><p class="mono wrap">${escape(project.id)}</p></div><button id="delete-project" class="danger" type="button" data-project-id="${escape(project.id)}" data-generation="${escape(project.generation)}">Delete project</button></div><section aria-labelledby="environment-list-heading"><h2 id="environment-list-heading">Environments</h2><ul class="environment-list">${environmentItems}</ul></section><section class="panel"><h2>Create environment</h2><form id="create-environment-form" class="stack-form"><label for="environment-name">Environment name</label><input id="environment-name" name="name" required maxlength="100"><button type="submit">Create environment</button><p class="form-status" aria-live="polite"></p></form></section>`;
}

export function renderArtifactIndex(artifacts, cursor) {
  const rows = artifacts.length ? artifacts.map((artifact) => `<tr><th scope="row">${escape(artifact.logicalName)}<small class="mono wrap">${escape(artifact.artifactId)}</small></th><td>${escape(formatBytes(artifact.sizeBytes))}</td><td class="mono wrap">${escape(artifact.sha256)}</td><td>${time(artifact.expiresAt)}</td><td><button class="danger delete-artifact" type="button" data-artifact-id="${escape(artifact.artifactId)}" data-generation="${escape(artifact.generation)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="5">No retained snapshots.</td></tr>';
  return `<div class="page-note"><strong>Retained artifact snapshots.</strong> These bounded copies persist until their displayed expiry or deletion. Tasks and sessions are volatile runtime state.</div><section class="panel" aria-labelledby="snapshot-heading"><h2 id="snapshot-heading">Create snapshot</h2><form id="snapshot-form" class="stack-form"><label for="snapshot-workspace">Workspace ID</label><input id="snapshot-workspace" name="workspaceId" required pattern="ws_[A-Za-z0-9_-]{20,80}"><label for="snapshot-path">Workspace path</label><input id="snapshot-path" name="path" required maxlength="1024"><label for="snapshot-name">Logical name</label><input id="snapshot-name" name="logicalName" required maxlength="128"><label for="snapshot-retention">Retention in seconds</label><input id="snapshot-retention" name="retentionSeconds" type="number" min="60" max="2592000" placeholder="Use server default"><button type="submit">Create retained snapshot</button><p class="form-status" aria-live="polite"></p></form></section><section aria-labelledby="artifact-list-heading"><h2 id="artifact-list-heading">Retained artifacts</h2><div class="desktop-table"><table><caption>${artifacts.length} snapshots</caption><thead><tr><th>Name</th><th>Size</th><th>SHA-256</th><th>Expires</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>${cursor ? `<button id="load-more-artifacts" type="button" data-cursor="${escape(cursor)}">Load more</button>` : ''}</section>`;
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
  return `${readinessNote}<section class="panel" aria-labelledby="create-api-key-heading"><h2 id="create-api-key-heading">Create API key</h2><p class="warning"><strong>Full remote execution authority.</strong> This key grants full MCP access as your identity, including arbitrary command execution. It expires, cannot be recovered, and must be revoked if exposed.</p>${limitNote}<form id="create-api-key-form" class="stack-form"><label for="api-key-name">Key name</label><input id="api-key-name" name="name" required maxlength="100" autocomplete="off"${disabled}><label for="api-key-expiry">Expires after (days)</label><input id="api-key-expiry" name="expiryDays" type="number" inputmode="numeric" min="1" max="365" step="1" value="30" required${disabled}><label class="checkbox-label"><input name="authorityAcknowledged" type="checkbox" required${disabled}><span>I understand this key permits full MCP and command-execution access and will be shown only once.</span></label><button id="create-api-key-submit" type="submit"${disabled}>Create API key</button><p class="form-status" aria-live="polite"></p></form></section><section aria-labelledby="api-key-list-heading"><div class="record-heading"><div><h2 id="api-key-list-heading">API keys</h2><p>${escape(activeCount)} active of 10 · ${escape(keys.length)} total</p></div></div><ul class="record-list api-key-list">${items}</ul></section>`;
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
  return `<div class="page-note"><strong>GitHub App authorization metadata.</strong> Provider private keys and minted tokens remain runner-only and are never rendered.</div>${callbackPending ? '<p class="status-message" role="status">Completing GitHub App connection…</p>' : ''}<section class="panel"><h2>Installation status</h2>${installationView}<button id="reconcile-github" type="button"${installations.length === 0 ? ' disabled' : ''}>${reconcileLabel}</button><p id="github-status-message" class="form-status" aria-live="polite"></p></section><section class="panel"><h2>Connect GitHub App</h2><form id="github-setup-form" class="stack-form"><label for="github-account-id">Expected account ID <span class="optional">Optional</span></label><input id="github-account-id" name="expectedAccountId" maxlength="100"><button type="submit">Connect GitHub App</button><p class="form-status" aria-live="polite"></p></form></section><section><h2>Authorized repositories</h2>${repositories}</section>`;
}
export function renderProfile(profile) {
  const identity = profile?.identity ?? {};
  const scopes = Array.isArray(profile?.scopes) ? profile.scopes : [];
  const scopeList = scopes.length ? `<ul class="record-list">${scopes.map((scope) => `<li class="mono">${escape(scope)}</li>`).join('')}</ul>` : '<p>No scopes reported.</p>';
  const value = (raw, extraClass = '') => raw ? `<dd${extraClass ? ` class="${extraClass}"` : ''}>${escape(raw)}</dd>` : '<dd>Not provided</dd>';
  return `<div class="page-note"><strong>Signed-in identity.</strong> These details come from your verified single sign-on assertion. Cloud Harness keeps no separate password for your account.</div><section class="panel" aria-labelledby="profile-account-heading"><h2 id="profile-account-heading">Account</h2><dl class="facts"><dt>Name</dt>${value(identity.name)}<dt>Email</dt>${value(identity.email, 'wrap')}<dt>Subject</dt>${value(identity.subject, 'mono wrap')}<dt>Identity provider</dt>${value(identity.issuer, 'mono wrap')}</dl></section><section class="panel" aria-labelledby="profile-session-heading"><h2 id="profile-session-heading">Session</h2><dl class="facts"><dt>Sign-in method</dt><dd>Single sign-on</dd><dt>Session expires</dt><dd>${optionalTime(profile?.sessionExpiresAt)}</dd></dl><h3>Granted scopes</h3>${scopeList}</section>`;
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

export function renderOverview(summary) {
  const metrics = summary.metrics.map((metric) => `<li class="metric"><span class="metric-label">${escape(metric.label)}</span><span class="metric-value${metric.small ? ' small' : ''}">${escape(metric.value)}</span>${metric.note ? `<span class="metric-note">${escape(metric.note)}</span>` : ''}</li>`).join('');
  const activity = summary.activity.length
    ? `<ul class="activity-list">${summary.activity.map((event) => `<li><strong>${escape(event.action)}</strong>${time(event.createdAt)}<span class="subject">${escape(event.subjectType)} <span class="mono wrap">${escape(event.subjectId)}</span></span></li>`).join('')}</ul>`
    : '<p>No retained audit events yet.</p>';
  const access = summary.access;
  const endpoint = access.endpoint
    ? `<dt>Static endpoint</dt><dd class="wrap"><span class="mono wrap">${escape(access.endpoint)}</span> <button type="button" class="copy" data-copy="${escape(access.endpoint)}">Copy</button></dd>`
    : '';
  return `<div class="overview"><ul class="metric-grid">${metrics}</ul><div class="overview-columns"><section class="panel" aria-labelledby="overview-activity-heading"><h2 id="overview-activity-heading">Recent activity</h2>${activity}</section><section class="panel" aria-labelledby="overview-access-heading"><h2 id="overview-access-heading">Access</h2><dl class="facts"><dt>Signed in as</dt><dd class="wrap">${escape(access.name)}</dd><dt>Email</dt><dd class="wrap">${escape(access.email)}</dd><dt>Session expires</dt><dd>${optionalTime(access.sessionExpiresAt)}</dd>${endpoint}</dl></section></div>${renderServerPanel(summary.server)}</div>`;
}
