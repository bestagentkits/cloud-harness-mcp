import { api } from './dashboard-api.js';
import {
  renderApiKeyIndex, renderArtifactIndex, renderAuditIndex, renderFile, renderFileList, renderGitHub, renderOverview, renderOverviewSkeleton,
  renderProjectDetail, renderProfile, renderProjectIndex, renderRuntime, renderWorkspaceDetail, renderWorkspaceIndex, repositoryName
} from './dashboard-render.js';

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapModalFocus(container, event) {
  if (event.key !== 'Tab') return;
  const items = [...container.querySelectorAll(focusableSelector)].filter((item) => !item.hidden);
  if (!items.length) { event.preventDefault(); container.focus(); return; }
  const first = items[0]; const last = items.at(-1);
  if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
}

export function createModalController({ panel, backgrounds, trigger, initialFocus, onOpen, onClose }) {
  let active = false;
  const keydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    trapModalFocus(panel, event);
  };
  function open() {
    if (active) return;
    active = true;
    for (const element of backgrounds) element.inert = true;
    panel.hidden = false; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    panel.addEventListener('keydown', keydown); onOpen?.();
    (initialFocus() ?? panel).focus({ preventScroll: true });
  }
  function close() {
    if (!active) return;
    active = false;
    panel.removeEventListener('keydown', keydown); panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); panel.hidden = true;
    for (const element of backgrounds) element.inert = false;
    onClose?.(); trigger.focus({ preventScroll: true });
  }
  return { open, close, get active() { return active; } };
}

export function createAsyncDialogController({ dialog, cancelButton, actionButton, status, reportError }) {
  let submitting = false; let options; let invoker;
  const restore = () => invoker?.focus({ preventScroll: true });
  function open(next, source) {
    options = next; invoker = source; actionButton.textContent = options.label; status.textContent = '';
    dialog.showModal(); cancelButton.focus();
  }
  function cancel() { if (!submitting && dialog.open) { dialog.close(); restore(); } }
  async function submit() {
    if (submitting || !dialog.open) return;
    submitting = true; dialog.setAttribute('aria-busy', 'true'); cancelButton.disabled = true; actionButton.disabled = true;
    actionButton.textContent = options.pendingLabel; status.textContent = options.pendingLabel;
    try { await options.action(); if (dialog.open) dialog.close(); }
    catch (error) { if (dialog.open) dialog.close(); restore(); reportError(error); }
    finally {
      submitting = false; dialog.removeAttribute('aria-busy'); cancelButton.disabled = false; actionButton.disabled = false;
      actionButton.textContent = options.label; status.textContent = '';
    }
  }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); cancel(); });
  cancelButton.addEventListener('click', cancel); actionButton.addEventListener('click', () => void submit());
  return { open, cancel, submit, get submitting() { return submitting; } };
}

export function conflictRecovery(localContent, actions) {
  return { reviewLatest: () => actions.reviewLatest(), copyChanges: () => actions.copyChanges(localContent), cancel: () => actions.cancel() };
}

export function githubCallbackParameters(search) {
  const parameters = new URLSearchParams(search); const state = parameters.get('state'); const installationId = parameters.get('installation_id');
  return state && installationId ? { state, installationId } : undefined;
}

export function resetWriteOnlyFields(form) {
  for (const field of form.querySelectorAll('input[data-write-only]')) field.value = '';
}

export function apiKeyCreateInput(form) {
  const values = new FormData(form);
  const name = String(values.get('name') ?? '').trim();
  const expiresInDays = Number(values.get('expiryDays'));
  if (!name || name.length > 100 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw new Error('Enter a key name and an expiry from 1 to 365 whole days.');
  }
  return { name, expiresInDays };
}

export function createApiKeyRevealController({ dialog, secretField, copyButton, acknowledgeButton, status, clipboard, reportError }) {
  let apiKey; let invoker;
  function clear() { apiKey = undefined; secretField.value = ''; status.textContent = ''; }
  function dismiss(restoreFocus = true) {
    clear();
    if (dialog.open) dialog.close();
    if (restoreFocus) invoker?.focus({ preventScroll: true });
    invoker = undefined;
  }
  function open(value, source) {
    if (typeof value !== 'string' || !/^chm_key_apk_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(value)) {
      throw new Error('The new API key was unavailable. Create a replacement key.');
    }
    clear(); apiKey = value; invoker = source; secretField.value = value;
    dialog.showModal(); copyButton.focus({ preventScroll: true });
  }
  async function copy() {
    const value = apiKey;
    if (!value) return;
    try {
      await clipboard.writeText(value);
      if (apiKey === value && dialog.open) status.textContent = 'API key copied. Save it before closing this window.';
    } catch {
      dismiss();
      reportError(new Error('The API key could not be copied and was cleared. Create a replacement key.'));
    }
  }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
  copyButton.addEventListener('click', () => void copy());
  acknowledgeButton.addEventListener('click', () => dismiss());
  return { open, copy, dismiss, clear: () => dismiss(false) };
}

export async function submitPatchEdit({ workspaceId, file, oldText, newText, request, onSaved, onConflict, onError }) {
  try {
    await request(`/workspaces/${encodeURIComponent(workspaceId)}/files/content`, {
      method: 'PATCH',
      body: JSON.stringify({ path: file.path, oldText, newText, expectedSha256: file.sha256 })
    });
    await onSaved();
  } catch (error) {
    if (error.status === 409) {
      onConflict({ oldText, newText, copyText: `Text to replace:\n${oldText}\n\nReplacement text:\n${newText}` });
      return;
    }
    onError(error);
  }
}

export async function submitPatchForm({ form, workspaceId, file, request, onSaved, onConflict, onError }) {
  const values = new FormData(form);
  const oldText = String(values.get('oldText') ?? ''); const newText = String(values.get('newText') ?? '');
  const conflictInvoker = form.querySelector('#old-text');
  await submitPatchEdit({
    workspaceId, file, oldText, newText, request, onSaved,
    onConflict: (changes) => onConflict(changes, conflictInvoker), onError
  });
}

export async function renderWorkspaceDrawer({ trigger, detail, content, fetchWorkspace, modal }) {
  const id = new URL(trigger.href).pathname.split('/').at(-1);
  const item = await fetchWorkspace(id);
  content.querySelector('[aria-current="true"]')?.removeAttribute('aria-current');
  trigger.setAttribute('aria-current', 'true');
  detail.innerHTML = renderWorkspaceDetail(item, false, modal);
  const heading = detail.querySelector('#workspace-detail-title');
  if (!heading) throw new Error('Workspace detail heading is unavailable.');
  heading.setAttribute('tabindex', '-1');
  return { id, item, heading };
}

export function initializeDashboard() {
  const content = document.querySelector('#content'); const detail = document.querySelector('#detail'); const main = document.querySelector('#main');
  const sidebar = document.querySelector('#product-nav'); const alertBox = document.querySelector('#alert'); const announcer = document.querySelector('#announcer');
  const dialog = document.querySelector('#confirm-dialog'); const menuButton = document.querySelector('#menu-button');
  const revealDialog = document.querySelector('#api-key-reveal-dialog');
  const pathMatch = location.pathname.match(/^\/dashboard\/workspaces\/(ws_[A-Za-z0-9_-]{20,80})(?:\/(files|runtime))?$/);
  const projectMatch = location.pathname.match(/^\/dashboard\/projects\/(prj_[A-Za-z0-9_-]{20,80})$/);
  if (matchMedia('(max-width: 47.9375rem)').matches) sidebar.hidden = true;
  const confirm = createAsyncDialogController({ dialog, cancelButton: dialog.querySelector('[data-cancel]'), actionButton: document.querySelector('#confirm-action'), status: document.querySelector('#confirm-status'), reportError: showError });
  const apiKeyReveal = createApiKeyRevealController({
    dialog: revealDialog, secretField: document.querySelector('#api-key-secret'), copyButton: document.querySelector('#copy-api-key'),
    acknowledgeButton: document.querySelector('#acknowledge-api-key'), status: document.querySelector('#api-key-copy-status'),
    clipboard: globalThis.navigator.clipboard, reportError: showError
  });
  const setBusy = (busy) => content.setAttribute('aria-busy', String(busy));
  const announce = (message) => { announcer.textContent = message; toast(message); };
  function toast(message, kind = '') {
    const region = document.querySelector('#toasts');
    if (!region) return;
    const node = document.createElement('div');
    node.className = kind ? `toast ${kind}` : 'toast';
    node.textContent = message;
    region.appendChild(node);
    globalThis.setTimeout(() => node.remove(), 4200);
  }
  let apiKeyPageData;
  function showError(error) {
    alertBox.hidden = false;
    alertBox.textContent = error.status === 401 ? 'Your dashboard session ended. Sign in again.'
      : error.status === 409 ? 'This item changed after you opened it. Review the latest version before trying again.' : error.message;
    setBusy(false);
  }
  const requestBody = (value) => JSON.stringify(value);
  function setTitle(title, help) {
    document.querySelector('#page-title').textContent = title; document.querySelector('#page-help').textContent = help;
    document.title = `${title} | Cloud Harness`;
  }
  function selectNavigation(section) {
    for (const link of sidebar.querySelectorAll('a[data-section]')) {
      if (link.dataset.section === section) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.querySelector('#context-nav').innerHTML = '';
  }
  async function load() {
    alertBox.hidden = true; setBusy(true);
    try {
      if (location.pathname === '/dashboard' || location.pathname === '/dashboard/') await loadIndex();
      else if (location.pathname === '/dashboard/overview') await loadOverview();
      else if (location.pathname === '/dashboard/projects') await loadProjects();
      else if (projectMatch) await loadProject(projectMatch[1]);
      else if (location.pathname === '/dashboard/artifacts') await loadArtifacts();
      else if (location.pathname === '/dashboard/audit') await loadAudit();
      else if (location.pathname === '/dashboard/api-keys') await loadApiKeys();
      else if (location.pathname === '/dashboard/github') await loadGitHub();
      else if (location.pathname === '/dashboard/profile') await loadProfile();
      else if (pathMatch?.[2] === 'files') await loadFiles(pathMatch[1]);
      else if (pathMatch?.[2] === 'runtime') await loadRuntime(pathMatch[1]);
      else if (pathMatch) await loadWorkspace(pathMatch[1]);
      else throw Object.assign(new Error('Dashboard page not found.'), { status: 404 });
      setBusy(false); main.focus({ preventScroll: true });
    } catch (error) { showError(error); }
  }
  async function loadOverview() {
    selectNavigation('overview');
    setTitle('Overview', 'A live summary of your workspaces, credentials, and recent activity.');
    document.querySelector('#command-surface').hidden = true;
    content.innerHTML = renderOverviewSkeleton();
    const [ws, keys, auditResult, github, profile] = await Promise.allSettled([
      api('/workspaces'), api('/api-keys'), api('/audit?limit=50'), api('/github'), api('/profile')
    ]);
    const data = (result) => result.status === 'fulfilled' ? result.value.data : undefined;
    const workspaces = data(ws)?.workspaces ?? [];
    const keyData = data(keys);
    const apiKeys = Array.isArray(keyData?.keys) ? keyData.keys : [];
    const events = data(auditResult)?.events ?? [];
    const installation = data(github)?.installation;
    const identity = data(profile)?.identity ?? {};
    const endpoint = keyData?.readiness?.ready === true ? (keyData.readiness.publicUrl ?? keyData.publicUrl) : undefined;
    const account = installation?.accountLogin ?? installation?.accountId;
    content.innerHTML = renderOverview({
      metrics: [
        { label: 'Active workspaces', value: workspaces.filter((item) => item.status === 'ACTIVE').length, note: `${workspaces.length} total` },
        { label: 'API keys', value: `${apiKeys.filter((item) => item.state === 'ACTIVE').length}/10`, note: 'Active of limit' },
        { label: 'GitHub', value: installation ? 'Connected' : 'Not connected', small: true, note: installation ? (account ?? 'Installation bound') : 'No installation bound' },
        { label: 'Recent events', value: events.length, note: 'Retained audit records' }
      ],
      activity: events.slice(0, 6).map((event) => ({ action: event.action, subjectType: event.subjectType, subjectId: event.subjectId, createdAt: event.createdAt })),
      access: {
        name: identity.name ?? 'Not provided',
        email: identity.email ?? 'Not provided',
        sessionExpiresAt: data(profile)?.sessionExpiresAt,
        endpoint: typeof endpoint === 'string' && /^https:\/\//.test(endpoint) ? endpoint : undefined
      }
    });
  }
  async function loadIndex() {
    selectNavigation('workspaces');
    setTitle('Workspaces', 'TTL-limited coding environments available to your signed-in identity.'); document.querySelector('#command-surface').hidden = false;
    const parameters = new URLSearchParams(location.search); const query = { q: parameters.get('q') ?? '', status: parameters.get('status') ?? '' };
    document.querySelector('#search').value = query.q; document.querySelector('#status').value = query.status;
    const result = await api('/workspaces'); content.innerHTML = renderWorkspaceIndex(result.data.workspaces, query);
    detail.hidden = true; document.querySelector('.app-shell').classList.remove('has-detail');
    document.querySelector('#clear-filters')?.addEventListener('click', () => { location.href = '/dashboard'; });
    bindWorkspaceDrawerLinks(); document.querySelector('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
  async function submitForm(form, pendingLabel, action, onSuccess) {
    const button = form.querySelector('button[type="submit"]'); const status = form.querySelector('.form-status'); const original = button.textContent;
    form.setAttribute('aria-busy', 'true'); button.disabled = true; button.textContent = pendingLabel; if (status) status.textContent = pendingLabel;
    try { await action(); if (status) status.textContent = ''; await onSuccess(); }
    catch (error) { showError(error); }
    finally { form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = original; }
  }
  async function loadProjects() {
    selectNavigation('projects'); setTitle('Projects', 'Retained project and environment metadata for your signed-in identity.'); document.querySelector('#command-surface').hidden = true;
    const result = await api('/projects'); content.innerHTML = renderProjectIndex(result.data.projects);
    document.querySelector('#create-project-form').addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
      void submitForm(form, 'Creating…', async () => api('/projects', { method: 'POST', body: requestBody({ name: values.get('name'), expectedGeneration: 0 }) }), async () => { announce('Project created.'); await loadProjects(); });
    });
  }
  async function loadProject(projectId) {
    selectNavigation('projects'); document.querySelector('#command-surface').hidden = true;
    const [projectsResult, environmentsResult] = await Promise.all([api('/projects'), api(`/projects/${encodeURIComponent(projectId)}/environments`)]);
    const project = projectsResult.data.projects.find((item) => item.id === projectId);
    if (!project) throw Object.assign(new Error('Project not found or no longer available.'), { status: 404 });
    const environments = await Promise.all(environmentsResult.data.environments.map(async (environment) => {
      const result = await api(`/environments/${encodeURIComponent(environment.id)}/secrets`);
      return { ...environment, secrets: result.data.secrets, readiness: result.data.readiness };
    }));
    setTitle(project.name, 'Retained environments and write-only secret references.'); content.innerHTML = renderProjectDetail(project, environments);
    bindProjectControls(project);
  }
  function bindProjectControls(project) {
    document.querySelector('#create-environment-form').addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
      void submitForm(form, 'Creating…', async () => api(`/projects/${encodeURIComponent(project.id)}/environments`, { method: 'POST', body: requestBody({ name: values.get('name'), expectedGeneration: 0 }) }), async () => { announce('Environment created.'); await loadProject(project.id); });
    });
    for (const form of document.querySelectorAll('.create-secret-form')) form.addEventListener('submit', (event) => {
      event.preventDefault(); const current = event.currentTarget; const values = new FormData(current); const name = values.get('name'); const value = values.get('value'); resetWriteOnlyFields(current);
      void submitForm(current, 'Creating…', async () => api(`/environments/${encodeURIComponent(current.dataset.environmentId)}/secrets`, { method: 'POST', body: requestBody({ name, value, expectedGeneration: 0 }) }), async () => { announce('Secret reference created. Value was not retained in the page.'); await loadProject(project.id); });
    });
    for (const form of document.querySelectorAll('.rotate-secret-form')) form.addEventListener('submit', (event) => {
      event.preventDefault(); const current = event.currentTarget; const values = new FormData(current); const value = values.get('value'); resetWriteOnlyFields(current);
      void submitForm(current, 'Rotating…', async () => api(`/environments/${encodeURIComponent(current.dataset.environmentId)}/secrets/${encodeURIComponent(current.dataset.secretName)}`, { method: 'PUT', body: requestBody({ value, expectedGeneration: Number(current.dataset.generation) }) }), async () => { announce('Secret rotated. Value was not retained in the page.'); await loadProject(project.id); });
    });
    for (const button of document.querySelectorAll('.delete-secret')) button.addEventListener('click', (event) => confirmAction({ title: 'Delete secret reference?', description: 'Delete this write-only reference and its encrypted value?', target: button.dataset.secretName, label: 'Delete secret', pendingLabel: 'Deleting…', action: async () => { await api(`/environments/${encodeURIComponent(button.dataset.environmentId)}/secrets/${encodeURIComponent(button.dataset.secretName)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) }); announce('Secret reference deleted.'); await loadProject(project.id); } }, event.currentTarget));
    for (const button of document.querySelectorAll('.delete-environment')) button.addEventListener('click', (event) => confirmAction({ title: 'Delete environment?', description: 'Delete this environment and its retained metadata?', target: button.dataset.environmentId, label: 'Delete environment', pendingLabel: 'Deleting…', action: async () => { await api(`/environments/${encodeURIComponent(button.dataset.environmentId)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) }); announce('Environment deleted.'); await loadProject(project.id); } }, event.currentTarget));
    document.querySelector('#delete-project').addEventListener('click', (event) => confirmAction({ title: 'Delete project?', description: 'Delete this project and its retained environment metadata?', target: project.name, label: 'Delete project', pendingLabel: 'Deleting…', action: async () => { await api(`/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: project.generation }) }); location.href = '/dashboard/projects'; } }, event.currentTarget));
  }
  async function loadArtifacts() {
    selectNavigation('artifacts'); setTitle('Artifacts', 'Bounded retained snapshots created from workspace files.'); document.querySelector('#command-surface').hidden = true;
    const parameters = new URLSearchParams(location.search); const cursor = parameters.get('cursor');
    const result = await api(`/artifacts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); content.innerHTML = renderArtifactIndex(result.data.artifacts, result.cursor);
    const form = document.querySelector('#snapshot-form'); form.addEventListener('submit', (event) => {
      event.preventDefault(); const values = new FormData(form); const retention = String(values.get('retentionSeconds') ?? '').trim();
      const body = { workspaceId: values.get('workspaceId'), path: values.get('path'), logicalName: values.get('logicalName'), ...(retention ? { retentionSeconds: Number(retention) } : {}), expectedGeneration: 0 };
      void submitForm(form, 'Creating snapshot…', async () => api('/artifacts', { method: 'POST', body: requestBody(body) }), async () => { announce('Retained artifact snapshot created.'); location.href = '/dashboard/artifacts'; });
    });
    for (const button of document.querySelectorAll('.delete-artifact')) button.addEventListener('click', (event) => confirmAction({ title: 'Delete retained artifact?', description: 'Delete this bounded snapshot before its retention expiry?', target: button.dataset.artifactId, label: 'Delete artifact', pendingLabel: 'Deleting…', action: async () => { await api(`/artifacts/${encodeURIComponent(button.dataset.artifactId)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) }); await loadArtifacts(); announce('Artifact deleted.'); } }, event.currentTarget));
    document.querySelector('#load-more-artifacts')?.addEventListener('click', (event) => { location.href = `/dashboard/artifacts?cursor=${encodeURIComponent(event.currentTarget.dataset.cursor)}`; });
  }
  async function loadAudit() {
    selectNavigation('audit'); setTitle('Audit', 'Retained redacted control-plane events.'); document.querySelector('#command-surface').hidden = true;
    const parameters = new URLSearchParams(location.search); const cursor = parameters.get('cursor');
    const result = await api(`/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); content.innerHTML = renderAuditIndex(result.data.events, result.cursor);
    document.querySelector('#load-more-audit')?.addEventListener('click', (event) => { location.href = `/dashboard/audit?cursor=${encodeURIComponent(event.currentTarget.dataset.cursor)}`; });
  }
  async function loadApiKeys() {
    selectNavigation('api-keys'); setTitle('API keys', 'Expiring credentials for static MCP clients that cannot complete browser OAuth.');
    document.querySelector('#command-surface').hidden = true;
    const result = await api('/api-keys'); apiKeyPageData = result.data; content.innerHTML = renderApiKeyIndex(apiKeyPageData); bindApiKeyControls();
  }
  function bindApiKeyControls() {
    const form = document.querySelector('#create-api-key-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault(); const current = event.currentTarget; const invoker = current.querySelector('button[type="submit"]'); let created;
      void submitForm(current, 'Creating key…', async () => {
        created = await api('/api-keys', { method: 'POST', body: requestBody(apiKeyCreateInput(current)) });
        if (typeof created?.data?.apiKey !== 'string') throw new Error('The new API key was unavailable. Create a replacement key.');
      }, async () => {
        const apiKey = created.data.apiKey; const metadata = created.data.key;
        created = undefined;
        const previousKeys = Array.isArray(apiKeyPageData?.keys) ? apiKeyPageData.keys : [];
        current.reset(); apiKeyPageData = { ...apiKeyPageData, keys: [metadata, ...previousKeys.filter((key) => key.id !== metadata.id)] };
        content.innerHTML = renderApiKeyIndex(apiKeyPageData); bindApiKeyControls();
        apiKeyReveal.open(apiKey, document.querySelector('#create-api-key-submit') ?? invoker);
        announce('API key created. Copy it now; it will not be shown again.');
      });
    });
    for (const button of document.querySelectorAll('.revoke-api-key')) button.addEventListener('click', (event) => confirmAction({
      title: 'Revoke API key?', description: 'This key will stop authenticating on the next request. Revocation cannot be undone.',
      target: button.dataset.keyName, label: 'Revoke API key', pendingLabel: 'Revoking…',
      action: async () => {
        await api(`/api-keys/${encodeURIComponent(button.dataset.keyId)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) });
        announce('API key revoked.'); await loadApiKeys();
      }
    }, event.currentTarget));
  }
  async function loadGitHub() {
    selectNavigation('github'); setTitle('GitHub', 'GitHub App installation and repository authorization status.'); document.querySelector('#command-surface').hidden = true;
    const callback = githubCallbackParameters(location.search);
    if (callback) {
      content.innerHTML = renderGitHub({ configured: true, installation: null, repositories: [] }, true);
      await api('/github/complete', { method: 'POST', body: requestBody(callback) });
      history.replaceState({}, '', '/dashboard/github'); announce('GitHub App connection completed.');
    }
    const result = await api('/github'); content.innerHTML = renderGitHub(result.data); bindGitHubControls();
  }
  function bindGitHubControls() {
    const form = document.querySelector('#github-setup-form'); form.addEventListener('submit', (event) => {
      event.preventDefault(); const values = new FormData(form); const expectedAccountId = String(values.get('expectedAccountId') ?? '').trim();
      void submitForm(form, 'Preparing connection…', async () => {
        const result = await api('/github/setup', { method: 'POST', body: requestBody(expectedAccountId ? { expectedAccountId } : {}) });
        const destination = new URL(result.data.url); if (destination.protocol !== 'https:') throw new Error('GitHub setup URL was invalid.');
        location.assign(destination.toString());
      }, async () => {});
    });
    document.querySelector('#reconcile-github').addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = 'Reconciling…';
      try { await api('/github/reconcile', { method: 'POST', body: requestBody({}) }); announce('GitHub installation reconciled.'); await loadGitHub(); }
      catch (error) { showError(error); } finally { button.disabled = false; button.textContent = 'Reconcile installation'; }
    });
  }
  async function loadProfile() {
    selectNavigation('profile'); setTitle('Profile', 'Your signed-in identity and session details.'); document.querySelector('#command-surface').hidden = true;
    const result = await api('/profile'); content.innerHTML = renderProfile(result.data);
  }
  function bindWorkspaceDrawerLinks() {
    for (const link of content.querySelectorAll('a[href^="/dashboard/workspaces/"]')) link.addEventListener('click', async (event) => {
      if (!matchMedia('(min-width: 48rem)').matches) return;
      event.preventDefault(); const trigger = event.currentTarget;
      try {
        const modal = !matchMedia('(min-width: 73.75rem)').matches;
        const { id, item, heading } = await renderWorkspaceDrawer({ trigger, detail, content, fetchWorkspace: workspace, modal });
        document.querySelector('.app-shell').classList.add('has-detail'); history.pushState({ drawer: id }, '', trigger.href); bindClose(item);
        if (modal) {
          const controller = createModalController({ panel: detail, backgrounds: [main, sidebar], trigger, initialFocus: () => heading, onClose: () => { document.querySelector('.app-shell').classList.remove('has-detail'); history.pushState({}, '', '/dashboard'); } });
          detail.querySelector('#close-detail').addEventListener('click', controller.close); controller.open();
        } else { detail.hidden = false; heading.focus({ preventScroll: true }); }
      } catch (error) { showError(error); }
    });
  }
  async function workspace(id) { return (await api(`/workspaces/${encodeURIComponent(id)}`)).data; }
  async function loadWorkspace(id) {
    const item = await workspace(id); setTitle(repositoryName(item.repositoryUrl), 'Workspace lifecycle and bounded operations.');
    content.innerHTML = renderWorkspaceDetail(item, false); detail.hidden = true; document.querySelector('#command-surface').hidden = true; bindClose(item);
  }
  async function loadFiles(id) {
    const item = await workspace(id); setTitle('Files', repositoryName(item.repositoryUrl)); document.querySelector('#command-surface').hidden = true; contextLinks(id, 'files');
    const parameters = new URLSearchParams(location.search); const path = parameters.get('path') ?? '.';
    if (parameters.get('file') === '1') {
      const result = await api(`/workspaces/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`);
      content.innerHTML = renderFile(id, result.data); bindFileEditor(id, result.data);
    } else {
      const result = await api(`/workspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`);
      content.innerHTML = renderFileList(id, result.data); bindFileOperations(id);
    }
  }
  async function loadRuntime(id) {
    const item = await workspace(id); setTitle('Runtime', repositoryName(item.repositoryUrl)); document.querySelector('#command-surface').hidden = true; contextLinks(id, 'runtime');
    content.innerHTML = renderRuntime((await api(`/workspaces/${encodeURIComponent(id)}/runtime`)).data);
  }
  function contextLinks(id, current) {
    document.querySelector('#context-nav').innerHTML = `<a href="/dashboard/workspaces/${encodeURIComponent(id)}/files" ${current === 'files' ? 'aria-current="page"' : ''}>Files</a><a href="/dashboard/workspaces/${encodeURIComponent(id)}/runtime" ${current === 'runtime' ? 'aria-current="page"' : ''}>Runtime</a>`;
  }
  function openFileConflict(id, localContent, invoker) {
    const conflictDialog = document.querySelector('#file-conflict-dialog'); const copyStatus = document.querySelector('#file-conflict-status');
    const recovery = conflictRecovery(localContent, {
      reviewLatest: async () => { conflictDialog.close(); await loadFiles(id); },
      copyChanges: async (value) => { await globalThis.navigator.clipboard.writeText(value); copyStatus.textContent = 'Your changes were copied.'; },
      cancel: () => { conflictDialog.close(); invoker.focus({ preventScroll: true }); }
    });
    conflictDialog.querySelector('#review-latest').onclick = () => void recovery.reviewLatest(); conflictDialog.querySelector('#copy-changes').onclick = () => void recovery.copyChanges(); conflictDialog.querySelector('#cancel-conflict').onclick = recovery.cancel;
    conflictDialog.addEventListener('cancel', (event) => { event.preventDefault(); recovery.cancel(); }, { once: true });
    copyStatus.textContent = ''; conflictDialog.showModal(); conflictDialog.querySelector('#cancel-conflict').focus();
  }
  function bindFileEditor(id, file) {
    const editor = document.querySelector('#file-editor');
    editor.addEventListener('submit', async (event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget); const localContent = String(form.get('content') ?? '');
      try { await api(`/workspaces/${encodeURIComponent(id)}/files/content`, { method: 'PUT', body: requestBody({ path: file.path, content: localContent, expectedSha256: form.get('sha') }) }); announce('File saved.'); await loadFiles(id); }
      catch (error) { if (error.status === 409) openFileConflict(id, localContent, editor.querySelector('textarea')); else showError(error); }
    });
    document.querySelector('#patch-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const patchForm = event.currentTarget;
      await submitPatchForm({
        form: patchForm, workspaceId: id, file, request: api,
        onSaved: async () => { announce('Text patch applied.'); await loadFiles(id); },
        onConflict: ({ copyText }, invoker) => openFileConflict(id, copyText, invoker),
        onError: showError
      });
    });
    document.querySelector('#delete-file').addEventListener('click', (event) => confirmAction({ title: 'Delete file?', description: `Delete ${file.path} from this workspace?`, target: file.path, label: 'Delete file', pendingLabel: 'Deleting…', action: async () => { await api(`/workspaces/${encodeURIComponent(id)}/files/content`, { method: 'DELETE', body: requestBody({ path: file.path, recursive: false, expectedSha256: file.sha256 }) }); location.href = `/dashboard/workspaces/${encodeURIComponent(id)}/files?path=.`; } }, event.currentTarget));
  }
  function bindFileOperations(id) {
    document.querySelector('#folder-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/workspaces/${encodeURIComponent(id)}/files/directory`, { method: 'POST', body: requestBody({ path: form.get('path'), recursive: true }) }); announce('Folder created.'); await loadFiles(id); } catch (error) { showError(error); } });
    document.querySelector('#move-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/workspaces/${encodeURIComponent(id)}/files/move`, { method: 'POST', body: requestBody({ source: form.get('source'), destination: form.get('destination'), overwrite: false }) }); announce('Path moved.'); await loadFiles(id); } catch (error) { showError(error); } });
  }
  function bindClose(item) {
    document.querySelector('#close-workspace')?.addEventListener('click', (event) => confirmAction({ title: 'Close workspace?', description: 'This stops the executor and removes the workspace checkout. This cannot be undone.', target: `${repositoryName(item.repositoryUrl)} ${item.workspaceId}`, label: 'Close workspace', pendingLabel: 'Closing…', action: async () => { await api(`/workspaces/${encodeURIComponent(item.workspaceId)}/close`, { method: 'POST', body: requestBody({ expectedGeneration: item.version }) }); location.href = '/dashboard'; } }, event.currentTarget));
  }
  function confirmAction(options, invoker) {
    document.querySelector('#confirm-title').textContent = options.title; document.querySelector('#confirm-description').textContent = options.description; document.querySelector('#confirm-target').textContent = options.target; confirm.open(options, invoker);
  }
  document.querySelector('#workspace-filter').addEventListener('submit', (event) => { event.preventDefault(); location.href = `/dashboard?${new URLSearchParams(new FormData(event.currentTarget))}`; });
  document.querySelector('#refresh').addEventListener('click', async () => { announce('Refreshing…'); await load(); announce('Workspace data refreshed.'); });
  const menu = createModalController({ panel: sidebar, backgrounds: [main], trigger: menuButton, initialFocus: () => sidebar.querySelector('a'), onOpen: () => { sidebar.classList.add('open'); menuButton.setAttribute('aria-expanded', 'true'); }, onClose: () => { sidebar.classList.remove('open'); menuButton.setAttribute('aria-expanded', 'false'); } });
  menuButton.addEventListener('click', () => menu.active ? menu.close() : menu.open());
  document.querySelector('#nav-toggle').addEventListener('click', (event) => { const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true'; event.currentTarget.setAttribute('aria-expanded', String(!expanded)); event.currentTarget.textContent = expanded ? 'Expand navigation' : 'Collapse navigation'; });
  document.addEventListener('click', (event) => { if (event.target.closest?.('a[href]')) apiKeyReveal.clear(); }, { capture: true });
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-copy]');
    if (!trigger) return;
    void globalThis.navigator.clipboard.writeText(trigger.dataset.copy).then(() => announce('Copied to clipboard.')).catch(() => announce('Copy failed. Select and copy the value manually.'));
  });
  addEventListener('pagehide', () => apiKeyReveal.clear());
  addEventListener('popstate', () => location.reload()); void load();
}

if (typeof document !== 'undefined') initializeDashboard();
