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
  const rows = filtered.map((workspace) => `<tr><th scope="row"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a><small class="mono">${escape(workspace.workspaceId)}</small></th><td><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span></td><td>${time(workspace.lastActivityAt)}</td><td>${time(workspace.expiresAt)}</td><td>${networkLabel(workspace.networkProfile)}</td></tr>`).join('');
  const cards = filtered.map((workspace) => `<li><h3><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}">${escape(repositoryName(workspace.repositoryUrl))}</a></h3><dl><dt>State</dt><dd>${statusLabel(workspace.status)}</dd><dt>Last activity</dt><dd>${time(workspace.lastActivityAt)}</dd><dt>Expires</dt><dd>${time(workspace.expiresAt)}</dd></dl></li>`).join('');
  return `<h2 id="workspace-list-heading">Workspace list</h2><div class="desktop-table"><table><caption>${filtered.length} workspaces</caption><thead><tr><th>Repository</th><th>State</th><th>Last activity</th><th>Expires</th><th>Network</th></tr></thead><tbody>${rows}</tbody></table></div><ul class="mobile-list">${cards}</ul>`;
}

export function renderWorkspaceDetail(workspace, dedicated = false, modal = false) {
  const heading = dedicated ? 'h1' : 'h2';
  const warning = workspace.networkProfile === 'dependency-access' ? '<p class="warning">Executor network access is enabled for this workspace (public DNS/HTTP/HTTPS).</p>' : '';
  const close = modal ? '<button id="close-detail" class="drawer-close" type="button">Close workspace details</button>' : '';
  return `${close}<${heading} id="workspace-detail-title">${escape(repositoryName(workspace.repositoryUrl))}</${heading}><p class="mono wrap">${escape(workspace.workspaceId)}</p><span class="status ${escape(workspace.status.toLowerCase())}">${statusLabel(workspace.status)}</span><ol class="lifecycle" aria-label="Workspace lifecycle"><li><strong>Created</strong>${time(workspace.createdAt)}</li><li><strong>Last activity</strong>${time(workspace.lastActivityAt)}</li><li><strong>Expires</strong>${time(workspace.expiresAt)}</li></ol><dl class="facts"><dt>Repository</dt><dd class="wrap">${escape(workspace.repositoryUrl)}</dd><dt>Ref</dt><dd>${escape(workspace.ref ?? 'Default branch')}</dd><dt>Network</dt><dd>${networkLabel(workspace.networkProfile)}</dd></dl>${warning}<nav class="detail-actions" aria-label="Workspace sections"><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/files">Files</a><a href="/dashboard/workspaces/${encodeURIComponent(workspace.workspaceId)}/runtime">Runtime</a></nav><div class="danger-zone"><button id="close-workspace" class="danger" type="button" ${workspace.version ? '' : 'disabled'}>Close workspace</button>${workspace.version ? '' : '<p>Close is unavailable until lifecycle fencing is ready.</p>'}</div>`;
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
  const rows = artifacts.length ? artifacts.map((artifact) => `<tr><th scope="row">${escape(artifact.logicalName)}<small class="mono wrap">${escape(artifact.artifactId)}</small></th><td>${escape(formatBytes(artifact.sizeBytes))}</td><td class="mono wrap">${escape(artifact.sha256)}</td><td>${time(artifact.expiresAt)}</td><td><a class="secondary button download-artifact" href="/dashboard/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download" download="${escape(artifact.logicalName)}">Download</a> <button class="danger delete-artifact" type="button" data-artifact-id="${escape(artifact.artifactId)}" data-generation="${escape(artifact.generation)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="5">No retained snapshots.</td></tr>';
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
  return `<div class="page-note"><strong>Instance-wide defaults.</strong> These values apply to workspaces opened without an explicit network profile. Saving here neither starts nor changes a running workspace.</div><section class="panel" aria-labelledby="settings-network-heading"><h2 id="settings-network-heading">Default network profile</h2><p>Choose the network posture for newly opened workspaces.</p><label for="settings-network-profile">Effective default</label><select id="settings-network-profile" name="defaultNetworkProfile">${options}<option value=""${stored ? '' : ' selected'}>Use runner default</option></select><dl class="facts"><dt>Effective profile</dt><dd>${escape(networkLabel(value))} <span class="mono">${escape(value)}</span></dd><dt>Source</dt><dd>${escape(source)}</dd>${readinessFact}</dl><p class="warning"><strong>Dependency access grants outbound network access to repository-controlled code.</strong> A dependency, build script, or agent command can then reach the network and exfiltrate any credential injected into the workspace, including a global GH_TOKEN. A fine-grained token scoped only to the repositories a workspace needs is safer than a broadly scoped credential. Check egress readiness before relying on it.</p><div class="form-row-actions"><button id="save-settings-network-profile" class="accent-btn" type="button">Save</button><button id="reset-settings-network-profile" type="button">Reset to runner default</button><button id="check-settings-network" type="button">Check egress readiness</button></div><p id="settings-status" class="status-message" aria-live="polite"></p></section>`;
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

  const library = `<form class="skills-toolbar" role="search" aria-label="Filter skills">
        <label for="skills-library-search">Search</label><input id="skills-library-search" name="q" placeholder="Filter by name or provider">
      </form>
      <div id="skills-bulk-bar" class="skills-bulk-bar" hidden><span id="skills-bulk-count"></span><button type="button" id="skills-bulk-archive">Archive</button><button type="button" id="skills-bulk-disable">Disable</button></div>
      <table id="skills-library-table" class="data-table"><caption class="sr-only">Installed skills</caption><thead><tr><th scope="col">Name</th><th scope="col">Provider</th><th scope="col">Tier</th><th scope="col">State</th><th scope="col">Select</th></tr></thead><tbody></tbody></table>
      <aside id="skill-detail" class="drawer" hidden>
        <div id="skill-detail-instructions"></div>
        <div id="skill-detail-files"></div>
        <div id="skill-detail-revisions"></div>
        <div id="skill-detail-usage"></div>
      </aside>
      <form id="skill-editor">
        <h3>Create a custom skill</h3>
        <label for="skill-editor-slug">Slug</label><input id="skill-editor-slug" name="slug" placeholder="my-skill">
        <label for="skill-editor-name">Display name</label><input id="skill-editor-name" name="displayName">
        <label for="skill-editor-instructions">Instructions</label><textarea id="skill-editor-instructions" name="instructions"></textarea>
        <button type="submit" id="skill-editor-save">Save skill</button><span id="skill-editor-status" role="status"></span>
      </form>`;

  const discover = `<div class="skills-search"><label for="skills-search-input">Search providers</label><input id="skills-search-input" name="q"><button type="button" id="skills-search-run">Search</button></div>
      <div id="skills-search-results"></div>
      <dialog id="skill-import-dialog" aria-labelledby="skill-import-heading">
        <h2 id="skill-import-heading">Import skill</h2>
        <label for="skill-import-source">Source</label><input id="skill-import-source" name="source" placeholder="owner/repository">
        <label for="skill-import-ref">Ref</label><input id="skill-import-ref" name="ref" placeholder="Full commit id (optional)">
        <!-- The UI contract pins this id; the operation it feeds takes a source kind, not an install
             scope, because an imported skill always lands in the owner tier. The label says what the
             value actually is so the operator is not offered a choice the runner cannot honour. -->
        <label for="skill-import-scope">Source kind</label><select id="skill-import-scope" name="sourceKind"><option value="skills-sh">skills.sh</option><option value="skillx">SkillX</option><option value="git">Git</option></select>
        <div id="skill-import-review"></div>
        <div id="skill-import-job" role="status"></div>
        <button type="button" id="skill-import-retry">Retry</button>
        <button type="button" id="skill-import-cancel">Cancel</button>
      </dialog>
      <pre id="skill-revision-diff" class="skills-diff" tabindex="0" aria-label="Revision diff"></pre>`;

  const sets = `<div id="skill-set-builder">
        <label for="skill-set-name">Name</label><input id="skill-set-name" name="name">
        <div id="skill-set-picker" role="group" aria-label="Available skills"></div>
        <ol id="skill-set-members"></ol>
        <button type="button" id="skill-set-save">Save set</button><span id="skill-set-status" role="status"></span>
      </div>`;

  const registry = `<table id="skills-registry-table" class="data-table"><caption class="sr-only">Registry and toolkit inventory</caption><thead><tr><th scope="col">Name</th><th scope="col">Cache state</th><th scope="col">Pinned commit</th><th scope="col">Skills</th><th scope="col">Lock</th></tr></thead><tbody></tbody></table>
      <p id="skills-registry-status" role="status" aria-live="polite"></p>`;

  return `<section id="skills-section" aria-labelledby="skills-heading">
      <h2 id="skills-heading" class="sr-only">Skills</h2>
      <div class="skills-tabs" role="tablist" aria-label="Skills views">${tab('library', 'Library', true)}${tab('discover', 'Discover', false)}${tab('sets', 'Skill Sets', false)}${tab('registry', 'Registry', false)}</div>
      ${panel('library', library, true)}${panel('discover', discover, false)}${panel('sets', sets, false)}${panel('registry', registry, false)}
    </section>`;
}

/**
 * Rows for the library table, injected into the skeleton's tbody once data arrives. Every value goes
 * through `escape`, because a skill's display name and slug are operator-supplied and a skill imported
 * from a provider carries a name this dashboard never authored.
 */
export function renderSkillsLibraryRows(skills) {
  const rows = Array.isArray(skills) ? skills : [];
  if (rows.length === 0) return '<tr><td colspan="5">No skills yet. Import one from Discover, or create a custom skill.</td></tr>';
  return rows.map((skill) => `<tr data-skill-id="${escape(skill.id)}">
      <th scope="row"><button type="button" class="link-btn" data-skill-detail="${escape(skill.id)}">${escape(skill.displayName)}</button><small class="mono">${escape(skill.slug)}</small></th>
      <td>${escape(skill.provider)}</td>
      <td>${escape(skill.kind)}</td>
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

/** Chips for the selected skill sets, so the launch dialog names what is about to be bound. */
export function renderSkillSetChips(names) {
  const list = Array.isArray(names) ? names : [];
  return list.map((name) => `<li>${escape(name)}</li>`).join('');
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
      ${time(revision.createdAt)}
      ${revision.id === currentRevisionId
        ? '<span class="status">current</span>'
        : `<button type="button" data-skill-restore="${escape(revision.id)}">Restore</button>`}
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
      <div class="row-actions"><button class="accent-btn" type="button" data-mcp-add aria-haspopup="dialog">Add MCP server</button></div>
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
