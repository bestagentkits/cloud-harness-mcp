import {
  api,
  listModelCredentials,
  createModelCredential,
  rotateModelCredential,
  deleteModelCredential,
  listModelProfiles,
  createModelProfile,
  updateModelProfile,
  activateModelProfile,
  disableModelProfile,
  deleteModelProfile,
  getModelConfigStatus,
  listKnowledge,
  getKnowledgeItem,
  createKnowledgeItem,
  updateKnowledgeItem,
  deleteKnowledgeItem,
  searchKnowledge,
  getKnowledgeGraph
} from './dashboard-api.js';
import {
  renderApiKeyIndex, renderArtifactIndex, renderAuditIndex, renderFile, renderFileList, renderGitHub, renderGlobalSecrets, renderModelsPage, renderOverview, renderOverviewSkeleton,
  renderProjectDetail, renderProfile, renderProjectIndex, renderRuntime, renderWorkspaceDetail, renderWorkspaceIndex, repositoryName,
  renderKnowledgeIndex, renderKnowledgeDetail, renderKnowledgeGraph, renderMarkdown
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
  if (!name || name.length > 100 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) {
    throw new Error('Enter a key name and an expiry from 1 to 3650 whole days.');
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
export function parseDotEnv(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  let comments = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      comments = [];
      continue;
    }
    if (trimmed.startsWith('#')) {
      comments.push(trimmed.replace(/^#+\s*/, ''));
      continue;
    }
    let assignment = trimmed;
    if (assignment.startsWith('export ')) {
      assignment = assignment.slice(7).trim();
    }
    const idx = assignment.indexOf('=');
    if (idx <= 0) continue;
    const name = assignment.slice(0, idx).trim();
    let value = assignment.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const description = comments.length ? comments.join(' / ').slice(0, 500) : null;
    comments = [];
    items.push({ name, value, description });
  }
  return items;
}
const FORBIDDEN_CLIENT_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
  'AUTHORIZATION', 'OWNER_ID', 'RUNNER_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'SECRET_KEYRING',
  'SECRET_KEYRING_FILE', 'STATE_DB', 'JOBS_ROOT', 'DOCKER_HOST',
  'LD_PRELOAD', 'LD_LIBRARY_PATH'
]);
const FORBIDDEN_CLIENT_PREFIXES = [
  'HARNESS_', 'CH_', 'CLOUDFLARE_', 'CF_', 'GITHUB_APP_', 'ACCESS_', 'RUNNER_', 'DOCKER_',
  'XDG_', 'NPM_', 'NPM_CONFIG_', 'UV_', 'BUN_', 'PNPM_', 'GIT_', 'LD_'
];

export function validateSecretClient(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)) return 'name must be an environment-style identifier';
  const upper = name.toUpperCase();
  if (FORBIDDEN_CLIENT_NAMES.has(upper)) return 'reserved control-plane or toolchain variable';
  for (const prefix of FORBIDDEN_CLIENT_PREFIXES) {
    if (upper.startsWith(prefix)) return `reserved prefix ${prefix}`;
  }
  if (!value || value.length < 4 || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    return 'value must be at least 4 characters without null or newline characters';
  }
  return null;
}

export function initializeDashboard() {
  const content = document.querySelector('#content'); const detail = document.querySelector('#detail'); const main = document.querySelector('#main');
  const sidebar = document.querySelector('#product-nav'); const alertBox = document.querySelector('#alert'); const announcer = document.querySelector('#announcer');
  const dialog = document.querySelector('#confirm-dialog'); const menuButton = document.querySelector('#menu-button');
  const revealDialog = document.querySelector('#api-key-reveal-dialog');
  const pathMatch = location.pathname.match(/^\/dashboard\/workspaces\/(ws_[A-Za-z0-9_-]{20,80})(?:\/(files|runtime))?$/);
  const projectMatch = location.pathname.match(/^\/dashboard\/projects\/(prj_[A-Za-z0-9_-]{20,80})$/);
  const knowledgeMatch = location.pathname.match(/^\/dashboard\/knowledge\/(kn_[A-Za-z0-9_-]{10,80})$/);
  const confirm = createAsyncDialogController({ dialog, cancelButton: dialog.querySelector('[data-cancel]'), actionButton: document.querySelector('#confirm-action'), status: document.querySelector('#confirm-status'), reportError: showError });
  const apiKeyReveal = createApiKeyRevealController({
    dialog: revealDialog, secretField: document.querySelector('#api-key-secret'), copyButton: document.querySelector('#copy-api-key'),
    acknowledgeButton: document.querySelector('#acknowledge-api-key'), status: document.querySelector('#api-key-copy-status'),
    clipboard: globalThis.navigator.clipboard, reportError: showError
  });
  const bulkDialog = document.querySelector('#bulk-import-dialog');
  const bulkInput = document.querySelector('#bulk-import-input');
  const bulkPreview = document.querySelector('#bulk-import-preview');
  const bulkStatus = document.querySelector('#bulk-import-status');
  const bulkEnvIdField = document.querySelector('#bulk-import-env-id');
  let currentBulkEnvironment;
  let currentBulkProject;
  function openBulkImport(environment, project) {
    currentBulkEnvironment = environment;
    currentBulkProject = project;
    if (bulkEnvIdField) bulkEnvIdField.value = environment.id;
    if (bulkInput) bulkInput.value = '';
    if (bulkPreview) bulkPreview.innerHTML = '';
    if (bulkStatus) bulkStatus.textContent = '';
    if (bulkDialog) bulkDialog.showModal();
    if (bulkInput) bulkInput.focus();
  }
  function closeBulkImport() {
    if (bulkInput) bulkInput.value = '';
    if (bulkPreview) bulkPreview.innerHTML = '';
    if (bulkStatus) bulkStatus.textContent = '';
    if (bulkDialog && bulkDialog.open) bulkDialog.close();
  }
  document.querySelector('#cancel-bulk-import')?.addEventListener('click', () => closeBulkImport());
  bulkDialog?.addEventListener('cancel', () => closeBulkImport());
  bulkDialog?.addEventListener('close', () => closeBulkImport());
  bulkInput?.addEventListener('input', () => {
    const parsed = parseDotEnv(bulkInput.value);
    if (!parsed.length) {
      bulkPreview.innerHTML = '<span class="diff-skip">No variable assignments found.</span>';
      return;
    }
    const existing = new Map((currentBulkEnvironment.secrets ?? []).map((s) => [s.name, s]));
    const seenInBatch = new Set();
    const lines = [];
    for (const item of parsed) {
      const err = validateSecretClient(item.name, item.value);
      const descHint = item.description ? ` (${escape(item.description)})` : '';
      if (err) {
        lines.push(`<span class="diff-err">&times; REJECTED: ${escape(item.name)} (${escape(err)})</span>`);
      } else if (seenInBatch.has(item.name)) {
        lines.push(`<span class="diff-err">&times; DUPLICATE: ${escape(item.name)} (duplicate in pasted batch)</span>`);
      } else {
        seenInBatch.add(item.name);
        const isExisting = existing.has(item.name);
        if (isExisting) {
          const prev = existing.get(item.name);
          lines.push(`<span class="diff-rot">&#8635; ROTATE: ${escape(item.name)}${descHint} (v${escape(prev.version ?? prev.generation)} &rarr; v${escape((prev.version ?? prev.generation) + 1)})</span>`);
        } else {
          lines.push(`<span class="diff-add">+ CREATE: ${escape(item.name)}${descHint}</span>`);
        }
      }
    }
    bulkPreview.innerHTML = lines.join('');
  });
  document.querySelector('#bulk-import-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!currentBulkEnvironment || !bulkInput || !bulkInput.value.trim()) return;
    const parsed = parseDotEnv(bulkInput.value);
    if (!parsed.length) return;
    const existing = new Map((currentBulkEnvironment.secrets ?? []).map((s) => [s.name, s]));
    const seen = new Set();
    const validItems = [];
    const errors = [];
    for (const item of parsed) {
      const err = validateSecretClient(item.name, item.value);
      if (err) {
        errors.push(`${item.name}: ${err}`);
        continue;
      }
      if (seen.has(item.name)) {
        errors.push(`${item.name}: duplicate key in batch`);
        continue;
      }
      seen.add(item.name);
      const prev = existing.get(item.name);
      validItems.push({
        name: item.name,
        value: item.value,
        ...(item.description ? { description: item.description } : {}),
        action: prev ? 'rotate' : 'create',
        expectedGeneration: prev ? Number(prev.generation) : 0
      });
    }
    if (errors.length > 0) {
      if (bulkStatus) bulkStatus.textContent = `Fix ${errors.length} rejected item(s) before applying.`;
      return;
    }
    if (!validItems.length) return;
    const form = event.currentTarget;
    const envId = currentBulkEnvironment.id;
    const projId = currentBulkProject?.id;
    const isGlobal = envId === 'global';
    const endpoint = isGlobal ? '/secrets/bulk' : `/environments/${encodeURIComponent(envId)}/secrets/bulk`;
    void submitForm(form, 'Applying…', async () => {
      await api(endpoint, {
        method: 'POST',
        body: requestBody({ items: validItems })
      });
    }, async () => {
      closeBulkImport();
      announce('Bulk secrets applied successfully.');
      if (isGlobal) {
        await loadGlobalSecrets();
      } else if (projId) {
        await loadProject(projId);
      }
    });
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
      else if (location.pathname === '/dashboard/secrets') await loadGlobalSecrets();
      else if (location.pathname === '/dashboard/models') await loadModels();
      else if (projectMatch) await loadProject(projectMatch[1]);
      else if (location.pathname === '/dashboard/artifacts') await loadArtifacts();
      else if (location.pathname === '/dashboard/audit') await loadAudit();
      else if (location.pathname === '/dashboard/api-keys') await loadApiKeys();
      else if (location.pathname === '/dashboard/github') await loadGitHub();
      else if (location.pathname === '/dashboard/knowledge') await loadKnowledge();
      else if (knowledgeMatch) await loadKnowledgeDetailView(knowledgeMatch[1]);
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
    const [ws, keys, auditResult, github, profile, server] = await Promise.allSettled([
      api('/workspaces'), api('/api-keys'), api('/audit?limit=50'), api('/github'), api('/profile'), api('/server')
    ]);
    const data = (result) => result.status === 'fulfilled' ? result.value.data : undefined;
    const workspaces = data(ws)?.workspaces ?? [];
    const keyData = data(keys);
    const apiKeys = Array.isArray(keyData?.keys) ? keyData.keys : [];
    const events = data(auditResult)?.events ?? [];
    const githubData = data(github);
    const installations = Array.isArray(githubData?.installations) ? githubData.installations : (githubData?.installation ? [githubData.installation] : []);
    const activeInstallations = installations.filter((inst) => inst.status === 'active');
    const installationCount = installations.length;
    const githubNote = installationCount === 1
      ? (installations[0].accountLogin ?? installations[0].accountId ?? '1 account bound')
      : installationCount > 1
        ? `${installationCount} accounts/orgs bound`
        : 'No installation bound';
    const githubConnected = activeInstallations.length > 0;
    const identity = data(profile)?.identity ?? {};
    const endpoint = keyData?.readiness?.ready === true ? (keyData.readiness.publicUrl ?? keyData.publicUrl) : undefined;
    content.innerHTML = renderOverview({
      metrics: [
        { label: 'Active workspaces', value: workspaces.filter((item) => item.status === 'ACTIVE').length, note: `${workspaces.length} total` },
        { label: 'API keys', value: `${apiKeys.filter((item) => item.state === 'ACTIVE').length}/10`, note: 'Active of limit' },
        { label: 'GitHub', value: githubConnected ? 'Connected' : 'Not connected', small: true, note: githubNote },
        { label: 'Recent events', value: events.length, note: 'Retained audit records' }
      ],
      activity: events.slice(0, 6).map((event) => ({ action: event.action, subjectType: event.subjectType, subjectId: event.subjectId, createdAt: event.createdAt })),
      access: {
        name: identity.name ?? 'Not provided',
        email: identity.email ?? 'Not provided',
        sessionExpiresAt: data(profile)?.sessionExpiresAt,
        endpoint: typeof endpoint === 'string' && /^https:\/\//.test(endpoint) ? endpoint : undefined
      },
      server: data(server)
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
    bindProjectControls(project, environments);
  }
  function bindProjectControls(project, environments = []) {
    document.querySelector('#create-environment-form').addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
      void submitForm(form, 'Creating…', async () => api(`/projects/${encodeURIComponent(project.id)}/environments`, { method: 'POST', body: requestBody({ name: values.get('name'), expectedGeneration: 0 }) }), async () => { announce('Environment created.'); await loadProject(project.id); });
    });
    for (const form of document.querySelectorAll('.create-secret-form')) form.addEventListener('submit', (event) => {
      event.preventDefault(); const current = event.currentTarget; const values = new FormData(current); const name = values.get('name'); const value = values.get('value'); const description = String(values.get('description') ?? '').trim() || null; resetWriteOnlyFields(current);
      void submitForm(current, 'Creating…', async () => api(`/environments/${encodeURIComponent(current.dataset.environmentId)}/secrets`, { method: 'POST', body: requestBody({ name, value, description, expectedGeneration: 0 }) }), async () => { announce('Secret reference created. Value was not retained in the page.'); await loadProject(project.id); });
    });
    for (const form of document.querySelectorAll('.rotate-secret-form')) form.addEventListener('submit', (event) => {
      event.preventDefault(); const current = event.currentTarget; const values = new FormData(current); const value = values.get('value'); const description = String(values.get('description') ?? '').trim() || undefined; resetWriteOnlyFields(current);
      void submitForm(current, 'Rotating…', async () => api(`/environments/${encodeURIComponent(current.dataset.environmentId)}/secrets/${encodeURIComponent(current.dataset.secretName)}`, { method: 'PUT', body: requestBody({ value, ...(description !== undefined ? { description } : {}), expectedGeneration: Number(current.dataset.generation) }) }), async () => { announce('Secret rotated. Value was not retained in the page.'); await loadProject(project.id); });
    });
    for (const form of document.querySelectorAll('.update-secret-desc-form')) form.addEventListener('submit', (event) => {
      event.preventDefault(); const current = event.currentTarget; const values = new FormData(current); const description = String(values.get('description') ?? '').trim() || null;
      void submitForm(current, 'Saving…', async () => api(`/environments/${encodeURIComponent(current.dataset.environmentId)}/secrets/${encodeURIComponent(current.dataset.secretName)}`, { method: 'PATCH', body: requestBody({ description, expectedGeneration: Number(current.dataset.generation) }) }), async () => { announce('Secret description updated.'); await loadProject(project.id); });
    });
    for (const button of document.querySelectorAll('.open-bulk-import')) button.addEventListener('click', () => {
      const env = environments.find((e) => e.id === button.dataset.environmentId) ?? { id: button.dataset.environmentId, secrets: [] };
      openBulkImport(env, project);
    });
    for (const button of document.querySelectorAll('.export-env-example')) button.addEventListener('click', async () => {
      const envId = button.dataset.environmentId;
      const envName = button.dataset.environmentName ?? 'environment';
      const result = await api(`/environments/${encodeURIComponent(envId)}/secrets`);
      const secrets = result.data?.secrets ?? [];
      const lines = [];
      for (const secret of secrets) {
        if (secret.description) {
          for (const line of secret.description.split('\n')) {
            lines.push(`# ${line.trim()}`);
          }
        }
        lines.push(`${secret.name}=`);
      }
      const blob = new globalThis.Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = globalThis.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${envName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}.env.example`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      globalThis.URL.revokeObjectURL(url);
      announce('.env.example exported.');
    });
    for (const button of document.querySelectorAll('.delete-secret')) button.addEventListener('click', (event) => confirmAction({ title: 'Delete secret reference?', description: 'Delete this write-only reference and its encrypted value?', target: button.dataset.secretName, label: 'Delete secret', pendingLabel: 'Deleting…', action: async () => { await api(`/environments/${encodeURIComponent(button.dataset.environmentId)}/secrets/${encodeURIComponent(button.dataset.secretName)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) }); announce('Secret reference deleted.'); await loadProject(project.id); } }, event.currentTarget));
    for (const button of document.querySelectorAll('.delete-environment')) button.addEventListener('click', (event) => confirmAction({ title: 'Delete environment?', description: 'Delete this environment and its retained metadata?', target: button.dataset.environmentId, label: 'Delete environment', pendingLabel: 'Deleting…', action: async () => { await api(`/environments/${encodeURIComponent(button.dataset.environmentId)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) }); announce('Environment deleted.'); await loadProject(project.id); } }, event.currentTarget));
    document.querySelector('#delete-project').addEventListener('click', (event) => confirmAction({ title: 'Delete project?', description: 'Delete this project and its retained environment metadata?', target: project.name, label: 'Delete project', pendingLabel: 'Deleting…', action: async () => { await api(`/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: project.generation }) }); location.href = '/dashboard/projects'; } }, event.currentTarget));
  }
  async function loadGlobalSecrets() {
    selectNavigation('secrets');
    setTitle('Secrets', 'Retained global secrets available across all projects and workspaces.');
    document.querySelector('#command-surface').hidden = true;
    const result = await api('/secrets');
    const secrets = result.data?.secrets ?? [];
    const readiness = result.data?.readiness;
    content.innerHTML = renderGlobalSecrets(secrets, readiness);
    bindGlobalSecretControls(secrets);
  }
  function bindGlobalSecretControls(secrets = []) {
    const createForm = document.querySelector('#create-global-secret-form');
    createForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const name = values.get('name');
      const value = values.get('value');
      const description = String(values.get('description') ?? '').trim() || null;
      resetWriteOnlyFields(form);
      void submitForm(form, 'Creating…', async () => api('/secrets', { method: 'POST', body: requestBody({ name, value, description, expectedGeneration: 0 }) }), async () => {
        announce('Global secret created. Value was not retained in the page.');
        await loadGlobalSecrets();
      });
    });
    for (const form of document.querySelectorAll('.rotate-global-secret-form')) form.addEventListener('submit', (event) => {
      event.preventDefault();
      const current = event.currentTarget;
      const values = new FormData(current);
      const value = values.get('value');
      const description = String(values.get('description') ?? '').trim() || undefined;
      resetWriteOnlyFields(current);
      void submitForm(current, 'Rotating…', async () => api(`/secrets/${encodeURIComponent(current.dataset.secretName)}`, { method: 'PUT', body: requestBody({ value, ...(description !== undefined ? { description } : {}), expectedGeneration: Number(current.dataset.generation) }) }), async () => {
        announce('Global secret rotated. Value was not retained in the page.');
        await loadGlobalSecrets();
      });
    });
    for (const form of document.querySelectorAll('.update-global-secret-desc-form')) form.addEventListener('submit', (event) => {
      event.preventDefault();
      const current = event.currentTarget;
      const values = new FormData(current);
      const description = String(values.get('description') ?? '').trim() || null;
      void submitForm(current, 'Saving…', async () => api(`/secrets/${encodeURIComponent(current.dataset.secretName)}`, { method: 'PATCH', body: requestBody({ description, expectedGeneration: Number(current.dataset.generation) }) }), async () => {
        announce('Global secret description updated.');
        await loadGlobalSecrets();
      });
    });
    document.querySelector('#open-global-bulk-import')?.addEventListener('click', () => {
      openBulkImport({ id: 'global', secrets }, null);
    });
    document.querySelector('#export-global-env-example')?.addEventListener('click', async () => {
      const result = await api('/secrets');
      const currentSecrets = result.data?.secrets ?? [];
      const lines = [];
      for (const secret of currentSecrets) {
        if (secret.description) {
          for (const line of secret.description.split('\n')) {
            lines.push(`# ${line.trim()}`);
          }
        }
        lines.push(`${secret.name}=`);
      }
      const blob = new globalThis.Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = globalThis.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'global.env.example';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      globalThis.URL.revokeObjectURL(url);
      announce('global.env.example exported.');
    });
    for (const button of document.querySelectorAll('.delete-global-secret')) button.addEventListener('click', (event) => confirmAction({
      title: 'Delete global secret?',
      description: 'Delete this global write-only reference and its encrypted value?',
      target: button.dataset.secretName,
      label: 'Delete secret',
      pendingLabel: 'Deleting…',
      action: async () => {
        await api(`/secrets/${encodeURIComponent(button.dataset.secretName)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) });
        announce('Global secret deleted.');
        await loadGlobalSecrets();
      }
    }, event.currentTarget));
  }
  async function loadModels() {
    selectNavigation('models');
    setTitle('Subagent Models', 'Manage model profiles and write-only provider credentials for Pi subagents.');
    document.querySelector('#command-surface').hidden = true;

    const [profilesRes, credsRes, statusRes] = await Promise.all([
      listModelProfiles().catch(() => ({ data: { profiles: [] } })),
      listModelCredentials().catch(() => ({ data: { credentials: [] } })),
      getModelConfigStatus().catch(() => ({ data: { status: null } }))
    ]);

    const profiles = profilesRes.data?.profiles ?? [];
    const credentials = credsRes.data?.credentials ?? [];
    const status = statusRes.data?.status ?? null;

    content.innerHTML = renderModelsPage(profiles, credentials, status);
    bindModelsControls(credentials);
  }

  function bindModelsControls(credentials = []) {
    const credDialog = document.querySelector('#model-credential-dialog');
    const credForm = document.querySelector('#model-credential-form');
    const cancelCred = document.querySelector('#cancel-model-credential');
    const profileDialog = document.querySelector('#model-profile-dialog');
    const profileForm = document.querySelector('#model-profile-form');
    const cancelProfile = document.querySelector('#cancel-model-profile');

    const providerSelect = document.querySelector('#model-credential-provider');
    const authModeGroup = document.querySelector('#model-credential-auth-mode');
    providerSelect?.addEventListener('change', () => {
      authModeGroup.value = providerSelect.value === 'custom' ? 'bearer' : 'bearer';
    });

    const customUrlGroup = document.querySelector('#model-profile-custom-url-group');
    const credentialSelect = document.querySelector('#model-profile-credential');

    function syncCustomUrlVisibility() {
      const selectedCred = credentials.find((c) => c.id === credentialSelect.value);
      if (customUrlGroup) {
        customUrlGroup.hidden = selectedCred?.provider !== 'custom';
      }
    }
    credentialSelect?.addEventListener('change', syncCustomUrlVisibility);

    document.querySelector('#open-add-credential-btn')?.addEventListener('click', () => {
      credForm.reset();
      document.querySelector('#model-credential-id').value = '';
      document.querySelector('#model-credential-title').textContent = 'Add provider credential';
      document.querySelector('#model-credential-label').disabled = false;
      document.querySelector('#model-credential-provider').disabled = false;
      credDialog.showModal();
      document.querySelector('#model-credential-label').focus();
    });

    cancelCred?.addEventListener('click', () => {
      credForm.reset();
      credDialog.close();
    });

    credForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const credentialId = values.get('credentialId');
      const apiKey = String(values.get('apiKey') ?? '').trim();
      const label = String(values.get('label') ?? '').trim();
      const provider = values.get('provider');
      const authMode = values.get('authMode');
      const expectedGeneration = Number(values.get('expectedGeneration') ?? 1);

      form.querySelector('#model-credential-key').value = '';

      if (credentialId) {
        void submitForm(form, 'Rotating…', async () => rotateModelCredential(credentialId, { apiKey, expectedGeneration }), async () => {
          credDialog.close();
          announce('Provider credential rotated.');
          await loadModels();
        });
      } else {
        void submitForm(form, 'Saving…', async () => createModelCredential({ label, provider, authMode, apiKey }), async () => {
          credDialog.close();
          announce('Provider credential saved.');
          await loadModels();
        });
      }
    });

    for (const btn of document.querySelectorAll('.rotate-model-credential')) {
      btn.addEventListener('click', (event) => {
        const id = event.currentTarget.dataset.credentialId;
        const label = event.currentTarget.dataset.label;
        const gen = event.currentTarget.dataset.generation;
        credForm.reset();
        document.querySelector('#model-credential-id').value = id;
        document.querySelector('#model-credential-generation').value = gen;
        document.querySelector('#model-credential-label').value = label;
        document.querySelector('#model-credential-label').disabled = true;
        document.querySelector('#model-credential-provider').disabled = true;
        document.querySelector('#model-credential-title').textContent = `Rotate credential (${label})`;
        credDialog.showModal();
        document.querySelector('#model-credential-key').focus();
      });
    }

    for (const btn of document.querySelectorAll('.delete-model-credential')) {
      btn.addEventListener('click', (event) => {
        const id = event.currentTarget.dataset.credentialId;
        const gen = Number(event.currentTarget.dataset.generation ?? 1);
        confirmAction.open({
          label: 'Delete credential',
          pendingLabel: 'Deleting…',
          target: id,
          description: 'Permanently delete this provider credential. Referenced profiles must be deleted first.',
          action: async () => {
            await deleteModelCredential(id, gen);
            announce('Provider credential deleted.');
            await loadModels();
          }
        }, event.currentTarget);
      });
    }

    document.querySelector('#open-add-profile-btn')?.addEventListener('click', () => {
      profileForm.reset();
      document.querySelector('#model-profile-id').disabled = false;
      document.querySelector('#model-profile-edit-mode').value = 'false';
      document.querySelector('#model-profile-title').textContent = 'Add model profile';

      credentialSelect.innerHTML = credentials.length
        ? credentials.map((c) => `<option value="${escape(c.id)}">${escape(c.label)} (${escape(c.provider)})</option>`).join('')
        : '<option value="">No credentials available (create one first)</option>';

      syncCustomUrlVisibility();
      profileDialog.showModal();
      document.querySelector('#model-profile-id').focus();
    });

    cancelProfile?.addEventListener('click', () => {
      profileForm.reset();
      profileDialog.close();
    });

    for (const btn of document.querySelectorAll('.edit-model-profile')) {
      btn.addEventListener('click', (event) => {
        const profile = JSON.parse(event.currentTarget.dataset.profileJson);
        profileForm.reset();
        document.querySelector('#model-profile-edit-mode').value = 'true';
        document.querySelector('#model-profile-generation').value = String(profile.generation);
        document.querySelector('#model-profile-id').value = profile.id;
        document.querySelector('#model-profile-id').disabled = true;
        document.querySelector('#model-profile-display-name').value = profile.displayName;
        document.querySelector('#model-profile-title').textContent = `Edit profile (${profile.displayName})`;

        credentialSelect.innerHTML = credentials.map((c) => `<option value="${escape(c.id)}" ${c.id === profile.credentialId ? 'selected' : ''}>${escape(c.label)} (${escape(c.provider)})</option>`).join('');

        if (profile.activeRevision) {
          document.querySelector('#model-profile-model').value = profile.activeRevision.model;
          document.querySelector('#model-profile-api-mode').value = profile.activeRevision.apiMode;
          document.querySelector('#model-profile-pricing-input').value = (profile.activeRevision.pricing.inputMicrosPerMillionTokens / 1_000_000).toFixed(6);
          document.querySelector('#model-profile-pricing-output').value = (profile.activeRevision.pricing.outputMicrosPerMillionTokens / 1_000_000).toFixed(6);
          document.querySelector('#model-profile-max-input').value = String(profile.activeRevision.limits.maxInputTokens);
          document.querySelector('#model-profile-max-output').value = String(profile.activeRevision.limits.maxOutputTokens);
          document.querySelector('#model-profile-max-cost').value = (profile.activeRevision.limits.maxCostMicros / 1_000_000).toFixed(6);

          const ops = new Set(profile.activeRevision.maxProxyOperations);
          for (const chk of profileForm.querySelectorAll('input[name="proxyOps"]')) {
            chk.checked = ops.has(chk.value);
          }
        }

        syncCustomUrlVisibility();
        profileDialog.showModal();
        document.querySelector('#model-profile-display-name').focus();
      });
    }

    profileForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const isEdit = values.get('isEdit') === 'true';
      const profileId = String(values.get('profileId') ?? '').trim();
      const displayName = String(values.get('displayName') ?? '').trim();
      const credentialId = String(values.get('credentialId') ?? '').trim();
      const model = String(values.get('model') ?? '').trim();
      const apiMode = String(values.get('apiMode') ?? 'chat-completions');
      const customUpstreamUrl = String(values.get('customUpstreamUrl') ?? '').trim() || undefined;
      const expectedGeneration = Number(values.get('expectedGeneration') ?? 1);

      const pricingInputMicros = Math.round(Number(values.get('pricingInput') ?? 0) * 1_000_000);
      const pricingOutputMicros = Math.round(Number(values.get('pricingOutput') ?? 0) * 1_000_000);
      const maxInputTokens = Number(values.get('maxInputTokens') ?? 200000);
      const maxOutputTokens = Number(values.get('maxOutputTokens') ?? 32000);
      const maxCostMicros = Math.round(Number(values.get('maxCost') ?? 5) * 1_000_000);

      const maxProxyOperations = [...form.querySelectorAll('input[name="proxyOps"]:checked')].map((c) => c.value);

      const payload = {
        displayName,
        credentialId,
        model,
        apiMode,
        ...(customUpstreamUrl ? { customUpstreamUrl } : {}),
        pricing: { inputMicrosPerMillionTokens: pricingInputMicros, outputMicrosPerMillionTokens: pricingOutputMicros },
        limits: { maxInputTokens, maxOutputTokens, maxCostMicros },
        maxProxyOperations
      };

      if (isEdit) {
        void submitForm(form, 'Updating…', async () => updateModelProfile(profileId, { ...payload, expectedGeneration }), async () => {
          profileDialog.close();
          announce('Model profile updated.');
          await loadModels();
        });
      } else {
        void submitForm(form, 'Creating…', async () => createModelProfile({ profileId, ...payload }), async () => {
          profileDialog.close();
          announce('Model profile created.');
          await loadModels();
        });
      }
    });

    for (const btn of document.querySelectorAll('.activate-model-profile')) {
      btn.addEventListener('click', async (event) => {
        const id = event.currentTarget.dataset.profileId;
        const gen = Number(event.currentTarget.dataset.generation ?? 1);
        try {
          await activateModelProfile(id, gen);
          announce('Model profile activated.');
          await loadModels();
        } catch (err) { showError(err); }
      });
    }

    for (const btn of document.querySelectorAll('.disable-model-profile')) {
      btn.addEventListener('click', async (event) => {
        const id = event.currentTarget.dataset.profileId;
        const gen = Number(event.currentTarget.dataset.generation ?? 1);
        try {
          await disableModelProfile(id, gen);
          announce('Model profile disabled.');
          await loadModels();
        } catch (err) { showError(err); }
      });
    }

    for (const btn of document.querySelectorAll('.delete-model-profile')) {
      btn.addEventListener('click', (event) => {
        const id = event.currentTarget.dataset.profileId;
        const gen = Number(event.currentTarget.dataset.generation ?? 1);
        confirmAction.open({
          label: 'Delete profile',
          pendingLabel: 'Deleting…',
          target: id,
          description: 'Permanently delete this subagent model profile.',
          action: async () => {
            await deleteModelProfile(id, gen);
            announce('Model profile deleted.');
            await loadModels();
          }
        }, event.currentTarget);
      });
    }
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
      try {
        await api('/github/complete', { method: 'POST', body: requestBody(callback) });
        announce('GitHub App connection completed.');
      } catch (error) {
        showError(error);
      } finally {
        history.replaceState({}, '', '/dashboard/github');
      }
    }
    const result = await api('/github'); content.innerHTML = renderGitHub(result.data); bindGitHubControls();
  }
  function bindGitHubControls() {
    const form = document.querySelector('#github-setup-form');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault(); const values = new FormData(form); const expectedAccountId = String(values.get('expectedAccountId') ?? '').trim();
        void submitForm(form, 'Preparing connection…', async () => {
          const result = await api('/github/setup', { method: 'POST', body: requestBody(expectedAccountId ? { expectedAccountId } : {}) });
          const destination = new URL(result.data.url); if (destination.protocol !== 'https:') throw new Error('GitHub setup URL was invalid.');
          location.assign(destination.toString());
        }, async () => {});
      });
    }
    const reconcileAllButton = document.querySelector('#reconcile-github');
    if (reconcileAllButton) {
      reconcileAllButton.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Reconciling…';
        try { await api('/github/reconcile', { method: 'POST', body: requestBody({}) }); announce('GitHub installations reconciled.'); await loadGitHub(); }
        catch (error) { showError(error); } finally { button.disabled = false; button.textContent = originalText; }
      });
    }
    for (const button of document.querySelectorAll('.reconcile-installation')) {
      button.addEventListener('click', async (event) => {
        const btn = event.currentTarget; btn.disabled = true; btn.textContent = 'Reconciling…';
        try {
          await api('/github/reconcile', { method: 'POST', body: requestBody({ installationId: btn.dataset.installationId }) });
          announce('GitHub installation reconciled.');
          await loadGitHub();
        } catch (error) { showError(error); } finally { btn.disabled = false; btn.textContent = 'Reconcile'; }
      });
    }
    for (const button of document.querySelectorAll('.disconnect-installation')) {
      button.addEventListener('click', (event) => confirmAction({
        title: 'Disconnect GitHub App installation?',
        description: 'Disconnect this account/organization and remove associated repository authorizations?',
        target: `${button.dataset.account ?? 'Installation'} (ID ${button.dataset.installationId})`,
        label: 'Disconnect',
        pendingLabel: 'Disconnecting…',
        action: async () => {
          await api('/github/disconnect', { method: 'POST', body: requestBody({ installationId: button.dataset.installationId }) });
          announce('GitHub installation disconnected.');
          await loadGitHub();
        }
      }, event.currentTarget));
    }
  }
  async function loadProfile() {
    selectNavigation('profile'); setTitle('Profile', 'Your signed-in identity and session details.'); document.querySelector('#command-surface').hidden = true;
    const result = await api('/profile'); content.innerHTML = renderProfile(result.data);
  }
  let currentKnowledgeItem;
  async function loadKnowledge(activeTab = 'all') {
    selectNavigation('knowledge');
    setTitle('Knowledge Plane', 'Scoped memories, chronological journals, and knowledge graph relations.');
    document.querySelector('#command-surface').hidden = true;

    const parameters = new URLSearchParams(location.search);
    const kind = parameters.get('kind') || (activeTab === 'memories' ? 'memory' : activeTab === 'journals' ? 'journal' : undefined);
    const scope = parameters.get('scope') || undefined;
    const projectId = parameters.get('projectId') || undefined;
    const query = parameters.get('q') || '';
    const cursor = parameters.get('cursor') || undefined;

    let data;
    if (activeTab === 'graph') {
      data = { items: [] };
    } else if (query) {
      const searchRes = await searchKnowledge({
        query,
        ...(kind ? { kinds: [kind] } : {}),
        ...(scope ? { scope } : {}),
        ...(projectId ? { projectId } : {}),
        ...(cursor ? { cursor } : {})
      }).catch(() => ({ data: { results: [] } }));
      data = searchRes.data ?? { results: [] };
    } else {
      const listRes = await listKnowledge({
        ...(kind ? { kind } : {}),
        ...(scope ? { scope } : {}),
        ...(projectId ? { projectId } : {}),
        ...(cursor ? { cursor } : {})
      }).catch(() => ({ data: { items: [] } }));
      data = listRes.data ?? { items: [] };
    }

    content.innerHTML = renderKnowledgeIndex(data, { q: query, kind, scope, projectId }, activeTab);
    bindKnowledgeIndexControls(activeTab);

    if (activeTab === 'graph') {
      const graphMount = document.querySelector('#knowledge-graph-mount');
      if (graphMount) {
        try {
          const graphRes = await getKnowledgeGraph({
            ...(projectId ? { projectId } : {}),
            depth: 2,
            maxNodes: 50
          });
          graphMount.innerHTML = renderKnowledgeGraph(graphRes.data);
          bindKnowledgeGraphControls();
        } catch (err) {
          graphMount.innerHTML = `<p class="form-status" style="color: var(--danger)">Graph error: ${escape(err.message)}</p>`;
        }
      }
    }
  }

  function bindKnowledgeIndexControls(activeTab) {
    for (const btn of document.querySelectorAll('.knowledge-tab-btn')) {
      btn.addEventListener('click', (event) => {
        const tab = event.currentTarget.dataset.knTab;
        void loadKnowledge(tab);
      });
    }

    const createKnDialog = document.querySelector('#create-knowledge-dialog');
    const createKnForm = document.querySelector('#create-knowledge-form');
    const kindSelect = document.querySelector('#create-kn-kind');
    const scopeSelect = document.querySelector('#create-kn-scope');
    const projectRow = document.querySelector('#create-kn-project-row');
    const projectSelect = document.querySelector('#create-kn-project');
    const journalRow = document.querySelector('#create-kn-journal-row');

    kindSelect?.addEventListener('change', () => {
      if (journalRow) journalRow.hidden = kindSelect.value !== 'journal';
    });

    scopeSelect?.addEventListener('change', async () => {
      if (scopeSelect.value === 'project') {
        if (projectRow) projectRow.hidden = false;
        try {
          const prjRes = await api('/projects');
          const projects = prjRes.data?.projects ?? [];
          if (projectSelect) {
            projectSelect.innerHTML = projects.length
              ? projects.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')
              : '<option value="">No projects available (create one first)</option>';
          }
        } catch {
          /* ignore */
        }
      } else {
        if (projectRow) projectRow.hidden = true;
      }
    });

    document.querySelector('#open-create-knowledge-btn')?.addEventListener('click', () => {
      createKnForm?.reset();
      if (journalRow) journalRow.hidden = true;
      if (projectRow) projectRow.hidden = true;
      createKnDialog?.showModal();
      document.querySelector('#create-kn-title')?.focus();
    });

    document.querySelector('#cancel-create-knowledge')?.addEventListener('click', () => {
      createKnForm?.reset();
      createKnDialog?.close();
    });

    createKnForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const kind = String(values.get('kind') ?? 'memory');
      const scope = String(values.get('scope') ?? 'owner');
      const projectId = scope === 'project' ? String(values.get('projectId') ?? '').trim() || undefined : undefined;
      const journalType = kind === 'journal' ? String(values.get('journalType') ?? 'engineering-log') : undefined;
      const title = String(values.get('title') ?? '').trim();
      const contentText = String(values.get('content') ?? '');
      const rawTags = String(values.get('tags') ?? '').trim();
      const tags = rawTags ? rawTags.split(',').map((t) => t.trim()).filter(Boolean) : [];

      void submitForm(form, 'Creating…', async () => {
        const res = await createKnowledgeItem({
          kind,
          scope,
          ...(projectId ? { projectId } : {}),
          title,
          content: contentText,
          ...(journalType ? { journalType } : {}),
          tags,
          expectedGeneration: 0
        });
        createKnDialog?.close();
        announce('Knowledge item created.');
        if (res.data?.id) {
          location.href = `/dashboard/knowledge/${encodeURIComponent(res.data.id)}`;
        } else {
          await loadKnowledge(activeTab);
        }
      }, async () => {});
    });
  }

  async function loadKnowledgeDetailView(id) {
    selectNavigation('knowledge');
    document.querySelector('#command-surface').hidden = true;
    const res = await getKnowledgeItem(id);
    const item = res.data;
    currentKnowledgeItem = item;
    setTitle(item.title, 'Knowledge item detail, Markdown editor, and relationship graph.');
    content.innerHTML = renderKnowledgeDetail(item);
    bindKnowledgeDetailControls(item);
  }

  function openKnowledgeConflict(baseItem, yoursContent, conflictData, invoker) {
    const dialog = document.querySelector('#knowledge-conflict-dialog');
    const baseGen = document.querySelector('#conflict-base-gen');
    if (baseGen) baseGen.textContent = String(baseItem.generation);
    const baseCont = document.querySelector('#conflict-base-content');
    if (baseCont) baseCont.textContent = baseItem.content;
    const currGen = document.querySelector('#conflict-current-gen');
    if (currGen) currGen.textContent = String(conflictData.currentGeneration ?? '?');
    const currCont = document.querySelector('#conflict-current-content');
    if (currCont) currCont.textContent = conflictData.currentContent ?? '(No content returned)';
    const yoursCont = document.querySelector('#conflict-yours-content');
    if (yoursCont) yoursCont.textContent = yoursContent;

    const copyBtn = document.querySelector('#copy-yours-conflict');
    const overwriteBtn = document.querySelector('#overwrite-current-conflict');
    const cancelBtn = document.querySelector('#cancel-knowledge-conflict');

    if (copyBtn) {
      copyBtn.onclick = async () => {
        await globalThis.navigator.clipboard.writeText(yoursContent);
        announce('Your unsaved draft was copied to clipboard.');
      };
    }

    if (overwriteBtn) {
      overwriteBtn.onclick = () => {
        const textarea = document.querySelector('#knowledge-editor-input');
        if (textarea) textarea.value = conflictData.currentContent ?? '';
        const preview = document.querySelector('#knowledge-preview-output');
        if (preview) preview.innerHTML = renderMarkdown(conflictData.currentContent ?? '');
        const genEl = document.querySelector('#kn-current-generation');
        if (genEl) genEl.textContent = String(conflictData.currentGeneration ?? '');
        currentKnowledgeItem = { ...currentKnowledgeItem, generation: conflictData.currentGeneration, content: conflictData.currentContent };
        dialog.close();
        announce('Loaded server version.');
      };
    }

    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dialog.close();
        invoker?.focus({ preventScroll: true });
      };
    }

    dialog.showModal();
    cancelBtn?.focus();
  }

  function bindKnowledgeDetailControls(item) {
    const textarea = document.querySelector('#knowledge-editor-input');
    const preview = document.querySelector('#knowledge-preview-output');
    const saveBtn = document.querySelector('#save-knowledge-btn');
    const editStatus = document.querySelector('#kn-edit-status');

    let debounceTimer;
    textarea?.addEventListener('input', () => {
      if (editStatus) editStatus.textContent = 'Unsaved changes';
      globalThis.clearTimeout(debounceTimer);
      debounceTimer = globalThis.setTimeout(() => {
        if (preview && textarea) preview.innerHTML = renderMarkdown(textarea.value);
      }, 200);
    });

    textarea?.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        saveBtn?.click();
      }
    });

    saveBtn?.addEventListener('click', async () => {
      if (!textarea) return;
      const contentValue = textarea.value;
      const originalText = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const res = await updateKnowledgeItem(item.id, {
          content: contentValue,
          expectedGeneration: Number(item.generation)
        });
        announce('Knowledge item saved.');
        if (editStatus) editStatus.textContent = 'Saved';
        currentKnowledgeItem = res.data;
        await loadKnowledgeDetailView(item.id);
      } catch (err) {
        if (err.status === 409) {
          openKnowledgeConflict(item, contentValue, err.conflict ?? {}, saveBtn);
        } else {
          showError(err);
        }
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
      }
    });

    document.querySelector('#delete-knowledge-btn')?.addEventListener('click', (event) => {
      const btn = event.currentTarget;
      const gen = Number(btn.dataset.generation ?? item.generation);
      confirmAction({
        title: 'Delete knowledge item?',
        description: `Permanently delete "${item.title}"?`,
        target: item.id,
        label: 'Delete item',
        pendingLabel: 'Deleting…',
        action: async () => {
          await deleteKnowledgeItem(item.id, gen);
          announce('Knowledge item deleted.');
          location.href = '/dashboard/knowledge';
        }
      }, btn);
    });
  }

  function bindKnowledgeGraphControls() {
    let zoomLevel = 1;
    const svg = document.querySelector('.knowledge-graph-svg');
    document.querySelector('#graph-zoom-in')?.addEventListener('click', () => {
      zoomLevel = Math.min(zoomLevel * 1.25, 3);
      if (svg) svg.style.transform = `scale(${zoomLevel})`;
    });
    document.querySelector('#graph-zoom-out')?.addEventListener('click', () => {
      zoomLevel = Math.max(zoomLevel / 1.25, 0.5);
      if (svg) svg.style.transform = `scale(${zoomLevel})`;
    });
    document.querySelector('#graph-reset')?.addEventListener('click', () => {
      zoomLevel = 1;
      if (svg) svg.style.transform = 'none';
    });
    for (const nodeGroup of document.querySelectorAll('.graph-node-group')) {
      nodeGroup.addEventListener('click', (event) => {
        const id = event.currentTarget.dataset.nodeId;
        if (id) location.href = `/dashboard/knowledge/${encodeURIComponent(id)}`;
      });
      nodeGroup.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const id = event.currentTarget.dataset.nodeId;
          if (id) location.href = `/dashboard/knowledge/${encodeURIComponent(id)}`;
        }
      });
    }
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
  document.querySelector('#nav-toggle').addEventListener('click', (event) => {
    const collapsed = document.querySelector('.app-shell').classList.toggle('nav-collapsed');
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    event.currentTarget.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
  });
  const themeControl = document.querySelector('.theme-control');
  for (const option of themeControl.querySelectorAll('.theme-opt')) {
    option.setAttribute('aria-pressed', String(option.dataset.themeValue === (document.documentElement.dataset.theme ?? 'system')));
    option.addEventListener('click', (event) => {
      const value = event.currentTarget.dataset.themeValue;
      if (value === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value;
      for (const other of themeControl.querySelectorAll('.theme-opt')) other.setAttribute('aria-pressed', String(other === event.currentTarget));
      void api('/preferences', { method: 'PUT', body: requestBody({ theme: value }) }).catch(() => announce('Theme preference was not saved.'));
      announce(`Theme set to ${value}.`);
    });
  }
  void api('/profile').then((result) => {
    const identity = result.data?.identity ?? {};
    document.querySelector('#profile-name').textContent = identity.name ?? identity.email ?? 'Signed in';
    document.querySelector('#profile-email').textContent = identity.email ?? '';
    const parts = String(identity.name ?? identity.email ?? '?').trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2);
    document.querySelector('#profile-avatar').textContent = (parts.map((part) => part[0]).join('') || '?').toUpperCase();
  }).catch(() => undefined);
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
