const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const statusLabel = (status) => ({ CREATING: 'Creating', ACTIVE: 'Active', REAPING: 'Closing', CLOSED: 'Closed', FAILED: 'Failed', NETWORK_QUARANTINED: 'Quarantined' })[status] ?? 'Unknown';
const networkLabel = (profile) => profile === 'dependency-access' ? 'Dependency access' : profile === 'local-host' ? 'Local host' : 'No network';
const time = (value) => `<time datetime="${escape(value)}">${escape(new Date(value).toLocaleString())}</time>`;

export function renderWorkspaceIndex(workspaces, query) {
  const filtered = workspaces.filter((workspace) => {
    const term = query.q.toLowerCase();
    return (!query.status || workspace.status === query.status) && (!term || `${workspace.repositoryUrl} ${workspace.workspaceId}`.toLowerCase().includes(term));
  });
  if (!workspaces.length) return '<h2 id="workspace-list-heading">Workspace list</h2><div class="empty"><h3>No workspaces yet.</h3><p>Open one from an MCP client and it will appear here.</p></div>';
  if (!filtered.length) return '<h2 id="workspace-list-heading">Workspace list</h2><div class="empty"><h3>No workspaces match these filters.</h3><button id="clear-filters" type="button">Clear filters</button></div>';
  const rows = filtered.map((workspace) => `<tr><th scope="row"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a><small class="mono">${escape(workspace.workspaceId)}</small></th><td><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span></td><td>${time(workspace.lastActivityAt)}</td><td>${time(workspace.expiresAt)}</td><td>${networkLabel(workspace.networkProfile ?? workspace.networkMode)}</td></tr>`).join('');
  const cards = filtered.map((workspace) => `<li><h3><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a></h3><dl><dt>State</dt><dd>${statusLabel(workspace.status)}</dd><dt>Last activity</dt><dd>${time(workspace.lastActivityAt)}</dd><dt>Expires</dt><dd>${time(workspace.expiresAt)}</dd></dl></li>`).join('');
  return `<h2 id="workspace-list-heading">Workspace list</h2><div class="desktop-table"><table><caption>${filtered.length} workspaces</caption><thead><tr><th>Repository</th><th>State</th><th>Last activity</th><th>Expires</th><th>Network</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

export function renderWorkspaceDetail(workspace, dedicated = false, modal = false) {
  const heading = dedicated ? 'h1' : 'h2';
  const warning = (workspace.networkProfile === 'dependency-access' || workspace.networkMode === 'bridge') ? '<p class="warning">Executor network access is enabled for this workspace (public DNS/HTTP/HTTPS).</p>' : '';
  const close = modal ? '<button id="close-detail" class="drawer-close" type="button">Close workspace details</button>' : '';
  return `${close}<${heading} id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</${heading}><p class="mono wrap">${escape(workspace.workspaceId)}</p><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span><ol class="lifecycle" aria-label="Workspace lifecycle"><li><strong>Created</strong>${time(workspace.createdAt)}</li><li><strong>Last activity</strong>${time(workspace.lastActivityAt)}</li><li><strong>Expires</strong>${time(workspace.expiresAt)}</li></ol><dl class="facts"><dt>Repository</dt><dd class="wrap">${escape(workspace.repositoryUrl)}</dd><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd><dt>Network</dt><dd>${networkLabel(workspace.networkProfile ?? workspace.networkMode)}</dd></dl>${warning}<nav class="detail-actions" aria-label="Workspace sections"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/files">Files</a><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/runtime">Runtime</a></nav><div class="danger-zone"><button id="close-workspace" class="danger" type="button" ${workspace.version ? '' : 'disabled'}>Close workspace</button>${workspace.version ? '' : '<p>Close is unavailable until lifecycle fencing is ready.</p>'}</div>`;
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
    return `<li class="secret-reference"><div><strong>${escape(secret.name)}</strong>${descHtml}<span class="status">${escape(secret.state ?? 'unknown')}</span><small>Version ${escape(secret.version ?? secret.generation)} · Generation ${escape(secret.generation)}</small></div><form class="update-global-secret-desc-form inline-form" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>Description<input name="description" value="${escape(secret.description ?? '')}" maxlength="500" autocomplete="off"></label><button type="submit">Save desc</button><p class="form-status" aria-live="polite"></p></form><form class="rotate-global-secret-form inline-form" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}"><label>New write-only value<input name="value" type="password" autocomplete="new-password" data-write-only required></label><button type="submit">Rotate</button><p class="form-status" aria-live="polite"></p></form><button class="danger delete-global-secret" type="button" data-secret-name="${escape(secret.name)}" data-generation="${escape(secret.generation)}">Delete secret</button></li>`;
  }).join('') : '<li>No global secrets yet.</li>';
  const readinessWarning = readiness?.ready === false ? `<p class="warning">Secret storage unavailable: ${escape(readiness.error ?? 'Review runner readiness.')}</p>` : '';
  return `<div class="page-note"><strong>Retained global configuration metadata.</strong> Global secrets are automatically inherited by all newly opened workspaces for your signed-in identity. Environment-specific secrets override global secrets on key collision. Secret rotation and deletion apply to future workspace opens and do not retroactively modify running workspaces. Values are write-only and never displayed.</div>${readinessWarning}<div class="record-heading"><div><h2>Global Secrets</h2><p>Inherited by all workspaces for your signed-in identity.</p></div><div class="row-actions"><button id="open-global-bulk-import" type="button">Bulk import .env</button><button id="export-global-env-example" type="button">Export .env.example</button></div></div><section class="panel" aria-labelledby="global-secrets-heading"><h2 id="global-secrets-heading">Secret references</h2><ul class="record-list">${secretRows}</ul></section><section class="panel"><h2>Add global secret</h2><form id="create-global-secret-form" class="stack-form"><label for="global-secret-name">Secret name</label><input id="global-secret-name" name="name" required maxlength="100" autocomplete="off"><label for="global-secret-value">Write-only value</label><input id="global-secret-value" name="value" type="password" required autocomplete="new-password" data-write-only><label for="global-secret-desc">Description <span class="optional">Optional</span></label><input id="global-secret-desc" name="description" maxlength="500" autocomplete="off"><button type="submit">Create global secret</button><p class="form-status" aria-live="polite"></p></form></section>`;
}

export function renderArtifactIndex(artifacts, cursor) {
  const rows = artifacts.length ? artifacts.map((artifact) => `<tr><th scope="row">${escape(artifact.logicalName)}<small class="mono wrap">${escape(artifact.artifactId)}</small></th><td>${escape(formatBytes(artifact.sizeBytes))}</td><td class="mono wrap">${escape(artifact.sha256)}</td><td>${time(artifact.expiresAt)}</td><td><a class="secondary button download-artifact" href="/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download" download="${escape(artifact.logicalName)}">Download</a> <button class="danger delete-artifact" type="button" data-artifact-id="${escape(artifact.artifactId)}" data-generation="${escape(artifact.generation)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="5">No retained snapshots.</td></tr>';
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
  return `${readinessNote}<section class="panel" aria-labelledby="create-api-key-heading"><h2 id="create-api-key-heading">Create API key</h2><p class="warning"><strong>Full remote execution authority.</strong> This key grants full MCP access as your identity, including arbitrary command execution. It expires, cannot be recovered, and must be revoked if exposed.</p>${limitNote}<form id="create-api-key-form" class="stack-form"><label for="api-key-name">Key name</label><input id="api-key-name" name="name" required maxlength="100" autocomplete="off"${disabled}><label for="api-key-expiry">Expires after (days)</label><input id="api-key-expiry" name="expiryDays" type="number" inputmode="numeric" min="1" max="3650" step="1" value="30" required${disabled}><label class="checkbox-label"><input name="authorityAcknowledged" type="checkbox" required${disabled}><span>I understand this key permits full MCP and command-execution access and will be shown only once.</span></label><button id="create-api-key-submit" type="submit"${disabled}>Create API key</button><p class="form-status" aria-live="polite"></p></form></section><section aria-labelledby="api-key-list-heading"><div class="record-heading"><div><h2 id="api-key-list-heading">API keys</h2><p>${escape(activeCount)} active of 10 · ${escape(keys.length)} total</p></div></div><ul class="record-list api-key-list">${items}</ul></section>`;
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
        <button id="open-add-credential-btn" type="button">+ Add credential</button>
        <button id="open-add-profile-btn" class="accent-btn" type="button">+ Add profile</button>
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
    <div class="knowledge-tags-row" style="margin-block-end: var(--space-3);">${tagsHtml}</div>

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

    <div class="form-row" style="margin-block-start: var(--space-4);">
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
    <details style="margin-block-start: var(--space-3);">
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
