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
  getKnowledgeGraph,
  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
  setMcpServerPermissions,
  testMcpServer,
  refreshMcpServerTools,
  listMcpServerLogs,
  getMcpGatewayEndpoint,
  listGlobalSecrets
} from './dashboard-api.js';
import {
  renderApiKeyIndex, renderArtifactIndex, renderAuditIndex, renderFile, renderFileList, renderGitHub, renderGlobalSecrets, renderModelsPage, renderOverview, renderOverviewSkeleton,
  renderProjectDetail, renderProfile, renderProjectIndex, renderRuntime, renderWorkspaceDetail, renderWorkspaceIndex, repositoryName,
  renderKnowledgeIndex, renderKnowledgeDetail, renderKnowledgeGraph, renderMarkdown, renderPaletteResults, profileDisplayName,
  renderMcpServersIndex, renderMcpServerDetail
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

export function backdropHit(event, bounds) {
  if (!bounds) return true;
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

/**
 * Dismiss a modal `<dialog>` when the operator taps or clicks the backdrop.
 * The coordinate check keeps clicks on the dialog's own padding from closing it,
 * and the pointerdown guard ignores a drag that started inside the dialog.
 */
export function dismissOnBackdrop(dialog, dismiss) {
  const bounds = () => (typeof dialog.getBoundingClientRect === 'function' ? dialog.getBoundingClientRect() : undefined);
  let armed = false;
  dialog.addEventListener('pointerdown', (event) => { armed = event.target === dialog && backdropHit(event, bounds()); });
  dialog.addEventListener('click', (event) => {
    if (!armed) return;
    armed = false;
    if (event.target === dialog && backdropHit(event, bounds())) dismiss();
  });
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
/**
 * Browser-side mirror of the reserved-name policy in
 * `packages/contracts/src/secret-policy.ts`, so the form can reject a name
 * before spending a request on it. `GITHUB_TOKEN` and `GH_TOKEN` are
 * deliberately absent: an operator may inject a GitHub credential as a runtime
 * secret to authenticate the executor's `gh` CLI. The parity test in
 * `apps/api/test/dashboard-ui-contract.test.ts` fails if the two lists drift.
 */
export const FORBIDDEN_CLIENT_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
  'AUTHORIZATION', 'OWNER_ID', 'RUNNER_TOKEN', 'SECRET_KEYRING',
  'SECRET_KEYRING_FILE', 'STATE_DB', 'JOBS_ROOT', 'DOCKER_HOST',
  'LD_PRELOAD', 'LD_LIBRARY_PATH'
]);
export const FORBIDDEN_CLIENT_PREFIXES = [
  'HARNESS_', 'CH_', 'CLOUDFLARE_', 'CF_', 'GITHUB_APP_', 'ACCESS_', 'RUNNER_', 'DOCKER_',
  'XDG_', 'NPM_', 'NPM_CONFIG_', 'UV_', 'BUN_', 'PNPM_', 'GIT_', 'LD_'
];

/** Theme cycle order. `system` is represented in the DOM by an absent html[data-theme]. */
export const THEME_ORDER = ['system', 'light', 'dark'];
export const normalizeTheme = (value) => (THEME_ORDER.includes(value) ? value : 'system');

export function nextTheme(current) {
  return THEME_ORDER[(THEME_ORDER.indexOf(normalizeTheme(current)) + 1) % THEME_ORDER.length];
}

export function themeActionLabel(current) {
  const resolved = normalizeTheme(current);
  return `Theme: ${resolved}. Activate to switch to ${nextTheme(resolved)}.`;
}

/**
 * The per-principal limiter allows only 8 concurrent requests for the whole
 * dashboard (apps/api/src/request-security.ts), and a page load already spends
 * most of that. The palette therefore fetches in batches of three and never runs
 * two fan-outs at once.
 */
export const PALETTE_BATCH_SIZE = 3;
export const PALETTE_MAX_PER_SOURCE = 200;
export const PALETTE_MAX_ENTRIES = 1_000;
export const PALETTE_MAX_RENDERED = 50;

/**
 * The indexed sources. Only these keys are read, and per source only the fields
 * named in `paletteEntryFor`. `knowledge` is deliberately absent: its list
 * response carries each item's full content (apps/api/src/dashboard-response.ts)
 * and the schema allows 262144 characters per item, which is far too large for a
 * navigation palette. `audit` is absent because a palette is a navigator, not a
 * log search, and per-environment secrets are absent because that endpoint is
 * N+1 by construction.
 */
export const PALETTE_SOURCE_REQUESTS = [
  { key: 'workspaces', path: '/workspaces?limit=100', rows: 'workspaces', group: 'Workspaces' },
  { key: 'projects', path: '/projects', rows: 'projects', group: 'Projects' },
  { key: 'secrets', path: '/secrets', rows: 'secrets', group: 'Secrets' },
  { key: 'apiKeys', path: '/api-keys', rows: 'keys', group: 'API keys' },
  { key: 'credentials', path: '/provider-credentials', rows: 'credentials', group: 'Models' },
  { key: 'profiles', path: '/agent-model-profiles', rows: 'profiles', group: 'Models' },
  { key: 'artifacts', path: '/artifacts?limit=100', rows: 'artifacts', group: 'Artifacts' }
];

export const PALETTE_PAGE_COMMANDS = [
  { id: 'page:overview', group: 'Pages', label: 'Overview', hint: 'Page', href: '/dashboard/overview' },
  { id: 'page:workspaces', group: 'Pages', label: 'Workspaces', hint: 'Page', href: '/dashboard' },
  { id: 'page:projects', group: 'Pages', label: 'Projects', hint: 'Page', href: '/dashboard/projects' },
  { id: 'page:secrets', group: 'Pages', label: 'Secrets', hint: 'Page', href: '/dashboard/secrets' },
  { id: 'page:models', group: 'Pages', label: 'Models', hint: 'Page', href: '/dashboard/models' },
  { id: 'page:api-keys', group: 'Pages', label: 'API keys', hint: 'Page', href: '/dashboard/api-keys' },
  { id: 'page:github', group: 'Pages', label: 'GitHub', hint: 'Page', href: '/dashboard/github' },
  { id: 'page:knowledge', group: 'Pages', label: 'Knowledge', hint: 'Search memories and journals here', href: '/dashboard/knowledge' },
  { id: 'page:mcp-servers', group: 'Pages', label: 'MCP Servers', hint: 'Manage downstream MCP integrations', href: '/dashboard/mcp-servers' },
  { id: 'page:artifacts', group: 'Pages', label: 'Artifacts', hint: 'Page', href: '/dashboard/artifacts' },
  { id: 'page:audit', group: 'Pages', label: 'Audit', hint: 'Page', href: '/dashboard/audit' },
  { id: 'page:profile', group: 'Pages', label: 'Profile', hint: 'Page', href: '/dashboard/profile' }
];

export function isPaletteHotkey(event) {
  return Boolean(event)
    && Boolean(event.metaKey || event.ctrlKey)
    && !event.altKey
    && typeof event.key === 'string'
    && event.key.toLowerCase() === 'k';
}

export function chunkPaletteRequests(requests) {
  const list = Array.isArray(requests) ? requests : [];
  const batches = [];
  for (let index = 0; index < list.length; index += PALETTE_BATCH_SIZE) batches.push(list.slice(index, index + PALETTE_BATCH_SIZE));
  return batches;
}

function paletteEntryFor(key, group, row) {
  if (!row || typeof row !== 'object') return undefined;
  if (key === 'workspaces') {
    if (!row.workspaceId || !row.repositoryUrl) return undefined;
    return { id: `workspace:${row.workspaceId}`, group, label: repositoryName(row.repositoryUrl), hint: String(row.workspaceId), href: `/dashboard/workspaces/${encodeURIComponent(row.workspaceId)}` };
  }
  if (key === 'projects') {
    if (!row.id || !row.name) return undefined;
    return { id: `project:${row.id}`, group, label: String(row.name), hint: String(row.id), href: `/dashboard/projects/${encodeURIComponent(row.id)}` };
  }
  if (key === 'secrets') {
    // Secret descriptions are unredacted free text and are deliberately never indexed.
    if (!row.name) return undefined;
    return { id: `secret:${row.name}`, group, label: String(row.name), hint: 'Global secret', href: '/dashboard/secrets' };
  }
  if (key === 'apiKeys') {
    if (!row.name) return undefined;
    return { id: `api-key:${row.id ?? row.name}`, group, label: String(row.name), hint: String(row.state ?? 'API key'), href: '/dashboard/api-keys' };
  }
  if (key === 'credentials') {
    if (!row.label) return undefined;
    return { id: `credential:${row.id ?? row.label}`, group, label: String(row.label), hint: String(row.provider ?? 'Provider credential'), href: '/dashboard/models' };
  }
  if (key === 'profiles') {
    const label = row.displayName ?? row.id;
    if (!label) return undefined;
    return { id: `profile:${row.id ?? label}`, group, label: String(label), hint: String(row.id ?? 'Model profile'), href: '/dashboard/models' };
  }
  if (key === 'artifacts') {
    const label = row.logicalName ?? row.artifactId;
    if (!label) return undefined;
    return { id: `artifact:${row.artifactId ?? label}`, group, label: String(label), hint: String(row.artifactId ?? ''), href: '/dashboard/artifacts' };
  }
  return undefined;
}

export function buildPaletteIndex(sources) {
  const provided = sources && typeof sources === 'object' ? sources : {};
  const entries = [...PALETTE_PAGE_COMMANDS];
  for (const request of PALETTE_SOURCE_REQUESTS) {
    const rows = Array.isArray(provided[request.key]) ? provided[request.key] : [];
    let added = 0;
    for (const row of rows) {
      if (added >= PALETTE_MAX_PER_SOURCE || entries.length >= PALETTE_MAX_ENTRIES) break;
      const entry = paletteEntryFor(request.key, request.group, row);
      if (!entry) continue;
      entries.push(entry);
      added += 1;
    }
  }
  return entries
    .slice(0, PALETTE_MAX_ENTRIES)
    .filter((entry) => entry.label.trim().length > 0)
    .map((entry) => ({ ...entry, haystack: `${entry.id} ${entry.label} ${entry.hint} ${entry.group}`.toLowerCase() }));
}

export function rankPaletteMatches(index, query) {
  const entries = Array.isArray(index) ? index : [];
  const term = String(query ?? '').trim().toLowerCase();
  if (!term) return entries.slice(0, PALETTE_MAX_RENDERED);
  const boundaries = [' ', '_', '-', '.', '/'];
  const ranked = [];
  for (const entry of entries) {
    const label = String(entry.label ?? '').toLowerCase();
    const position = label.indexOf(term);
    let rank;
    if (position === 0) rank = 0;
    else if (position > 0 && boundaries.includes(label[position - 1])) rank = 1;
    else if (String(entry.haystack ?? '').includes(term)) rank = 2;
    else continue;
    ranked.push({ rank, entry });
  }
  ranked.sort((left, right) => left.rank - right.rank);
  return ranked.slice(0, PALETTE_MAX_RENDERED).map((item) => item.entry);
}

/**
 * Refresh policy for the command palette index, extracted so it is testable
 * without a DOM.
 *
 * Guarantees:
 * - At most `PALETTE_BATCH_SIZE` requests are in flight at once (sequential batches),
 *   which keeps the fan-out inside the dashboard's per-principal concurrency limit.
 * - Concurrent callers share a single load.
 * - An expired snapshot and an explicit invalidation both re-arm every source, so a
 *   refresh never renews its timestamp without refetching.
 * - A failed source stays pending and is retried on the next load instead of being
 *   cached as an empty list.
 * - An invalidation that lands mid-load supersedes that pass, and the same load
 *   continues until it produces a current-generation index.
 */
export function createPaletteIndexLoader({ requests, fetchRows, buildIndex = buildPaletteIndex, now = Date.now, maxAgeMs = 60_000 }) {
  const sources = {};
  let pending = new Set(requests.map((request) => request.key));
  let index;
  let builtAt = 0;
  let stale = true;
  let generation = 0;
  let inFlight;

  async function load() {
    // `for (;;)` is bounded by external invalidations: a pass repeats only when its
    // generation was superseded, and a failed source returns through the commit
    // path below rather than re-entering.
    for (;;) {
      if (index && !stale && now() - builtAt <= maxAgeMs) return index;
      if (pending.size === 0) pending = new Set(requests.map((request) => request.key));
      const pass = ++generation;
      const wanted = requests.filter((request) => pending.has(request.key));
      const settled = [];
      for (const batch of chunkPaletteRequests(wanted)) {
        settled.push(...await Promise.allSettled(batch.map((request) => fetchRows(request))));
      }
      if (pass !== generation) continue;
      const nextPending = new Set();
      wanted.forEach((request, position) => {
        const outcome = settled[position];
        if (outcome?.status === 'fulfilled' && Array.isArray(outcome.value)) sources[request.key] = outcome.value;
        else nextPending.add(request.key);
      });
      pending = nextPending;
      index = buildIndex(sources);
      builtAt = now();
      stale = pending.size > 0;
      return index;
    }
  }

  return {
    ensure() {
      if (!inFlight) inFlight = load().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    invalidate() {
      // Re-arm every source: `wanted` is derived from `pending`, so marking only
      // `stale` would make invalidation a no-op that re-serves the previous index.
      stale = true;
      pending = new Set(requests.map((request) => request.key));
      generation += 1;
    },
    read() { return index; }
  };
}

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
  const mcpServerMatch = location.pathname.match(/^\/dashboard\/mcp-servers\/(mcps_[A-Za-z0-9_-]{20,80})$/);
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
  // Command palette state. Declared before `announce` so its invalidation hook is safe.
  const paletteLoader = createPaletteIndexLoader({
    requests: PALETTE_SOURCE_REQUESTS,
    fetchRows: (request) => api(request.path).then((result) => result?.data?.[request.rows])
  });
  let paletteActive = -1;
  let paletteInvoker;
  let paletteAnnounceTimer;
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
  const announce = (message) => { announcer.textContent = message; toast(message); invalidatePalette(); };
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
      else if (location.pathname === '/dashboard/mcp-servers') await loadMcpServers();
      else if (mcpServerMatch) await loadMcpServerDetail(mcpServerMatch[1]);
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
    selectNavigation('profile'); setTitle('Profile', 'Your signed-in identity, display name, and session details.'); document.querySelector('#command-surface').hidden = true;
    const result = await api('/profile'); content.innerHTML = renderProfile(result.data); bindProfileControls();
  }
  function saveDisplayName(value) {
    return api('/preferences', { method: 'PUT', body: requestBody({ displayName: value }) });
  }
  function bindProfileControls() {
    const form = document.querySelector('#profile-name-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get('displayName') ?? '').trim();
      void submitForm(form, 'Saving…', () => saveDisplayName(value), async () => { announce('Display name updated.'); await refreshIdentity(); await loadProfile(); });
    });
    document.querySelector('#clear-display-name').addEventListener('click', () => {
      void submitForm(form, 'Saving…', () => saveDisplayName(''), async () => { announce('Display name reset to your sign-on name.'); await refreshIdentity(); await loadProfile(); });
    });
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
          graphMount.innerHTML = `<p class="form-status status-error">Graph error: ${escape(err.message)}</p>`;
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
        document.querySelector('.app-shell').classList.add('has-detail'); history.pushState({ drawer: id }, '', trigger.href); bindClose(item); invalidatePalette();
        if (modal) {
          const controller = createModalController({ panel: detail, backgrounds: [main, sidebar], trigger, initialFocus: () => heading, onClose: () => { document.querySelector('.app-shell').classList.remove('has-detail'); history.pushState({}, '', '/dashboard'); } });
          detail.querySelector('#close-detail').addEventListener('click', controller.close); controller.open();
        } else { detail.hidden = false; heading.focus({ preventScroll: true }); }
      } catch (error) { showError(error); }
    });
  }
  let currentMcpServers = [];
  let currentMcpServer;
  let currentMcpTools = [];
  let currentMcpTraces = [];
  let currentMcpLogCursor;
  let currentMcpGateway;
  let currentMcpTab = 'overview';
  function mcpServerEndpoint(server) {
    const raw = typeof server?.endpoint === 'string' ? server.endpoint : '';
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return raw; }
  }
  async function loadMcpServers() {
    selectNavigation('mcp-servers');
    setTitle('MCP Servers', 'Downstream MCP integrations available through the Cloud Harness gateway.');
    document.querySelector('#command-surface').hidden = true;
    setBusy(true);
    try {
      const [serversResult, gatewayResult] = await Promise.all([listMcpServers(), getMcpGatewayEndpoint()]);
      currentMcpServers = Array.isArray(serversResult.data?.servers) ? serversResult.data.servers : [];
      currentMcpGateway = gatewayResult.data;
      content.innerHTML = renderMcpServersIndex({ servers: currentMcpServers, gateway: currentMcpGateway });
      bindMcpServersControls();
    } finally { setBusy(false); }
  }
  async function loadMcpServerDetail(serverId, tab = 'overview') {
    selectNavigation('mcp-servers');
    document.querySelector('#command-surface').hidden = true;
    currentMcpTab = tab;
    setBusy(true);
    try {
      const [serverResult, logsResult, gatewayResult] = await Promise.all([
        getMcpServer(serverId),
        tab === 'logs' ? listMcpServerLogs(serverId) : Promise.resolve(undefined),
        getMcpGatewayEndpoint().catch(() => undefined)
      ]);
      currentMcpServer = serverResult.data?.server ?? serverResult.data;
      currentMcpTools = Array.isArray(serverResult.data?.tools) ? serverResult.data.tools : [];
      currentMcpGateway = gatewayResult?.data;
      if (currentMcpServer?.name) setTitle(currentMcpServer.name, 'MCP server detail, tools, permissions, and gateway logs.');
      currentMcpTraces = Array.isArray(logsResult?.data?.traces) ? logsResult.data.traces : [];
      currentMcpLogCursor = logsResult?.cursor;
      content.innerHTML = renderMcpServerDetail(currentMcpServer, currentMcpTools, currentMcpTraces, tab, currentMcpLogCursor, currentMcpGateway);
      bindMcpServersControls();
    } finally { setBusy(false); }
  }
  function mcpHeaderRow(header = {}, secrets = []) {
    const node = document.createElement('div');
    node.className = 'form-row mcp-header-row';
    const name = document.createElement('label');
    name.textContent = 'Header name';
    const nameInput = document.createElement('input');
    nameInput.name = 'headerName';
    nameInput.maxLength = 64;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.placeholder = 'authorization';
    nameInput.value = header.name ?? '';
    name.appendChild(nameInput);
    const mode = document.createElement('label');
    mode.textContent = 'Value mode';
    const modeSelect = document.createElement('select');
    modeSelect.name = 'headerMode';
    for (const [value, label] of [['literal', 'Literal value'], ['secret', 'Secret reference']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modeSelect.appendChild(option);
    }
    modeSelect.value = header.kind === 'secret' ? 'secret' : 'literal';
    mode.appendChild(modeSelect);
    const value = document.createElement('label');
    value.textContent = 'Header value';
    const valueInput = document.createElement('input');
    valueInput.name = 'headerValue';
    valueInput.maxLength = 2048;
    valueInput.autocomplete = 'off';
    valueInput.spellcheck = false;
    valueInput.value = header.kind === 'secret' ? '' : (header.value ?? '');
    value.appendChild(valueInput);
    const reference = document.createElement('label');
    reference.textContent = 'Secret reference';
    const secretSelect = document.createElement('select');
    secretSelect.name = 'headerSecretRef';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Select a global secret';
    secretSelect.appendChild(blank);
    for (const secret of secrets) {
      const option = document.createElement('option');
      option.value = secret.name;
      option.textContent = secret.name;
      secretSelect.appendChild(option);
    }
    if (header.secretRef) secretSelect.value = header.secretRef;
    reference.appendChild(secretSelect);
    node.append(name, mode, value, reference);
    const applyMode = () => {
      const secretMode = modeSelect.value === 'secret';
      valueInput.hidden = secretMode;
      secretSelect.hidden = !secretMode;
      if (secretMode) valueInput.value = '';
    };
    modeSelect.addEventListener('change', applyMode);
    applyMode();
    return node;
  }
  function openMcpDialog(server, secrets) {
    const dialog = document.querySelector('#mcp-server-dialog');
    const form = document.querySelector('#mcp-server-form');
    if (!dialog || !form) return;
    form.reset();
    document.querySelector('#mcp-server-title').textContent = server ? 'Edit MCP server' : 'Add MCP server';
    document.querySelector('#submit-mcp-server').textContent = server ? 'Save server' : 'Create server';
    form.elements.serverId.value = server?.id ?? '';
    form.elements.expectedGeneration.value = String(server?.generation ?? 0);
    form.elements.name.value = server?.name ?? '';
    form.elements.description.value = server?.description ?? '';
    form.elements.transport.value = server?.transport ?? 'streamable-http';
    form.elements.endpoint.value = server ? mcpServerEndpoint(server) : '';
    form.elements.enabled.checked = server ? server.enabled !== false : true;
    const rows = document.querySelector('#mcp-header-rows');
    rows.replaceChildren();
    for (const header of (Array.isArray(server?.headers) ? server.headers : [])) rows.appendChild(mcpHeaderRow(header, secrets));
    document.querySelector('#mcp-dialog-status').textContent = '';
    dialog.showModal();
    form.elements.name.focus();
  }
  function mcpHeadersFromForm(form) {
    const headers = [];
    for (const row of form.querySelectorAll('.mcp-header-row')) {
      const headerName = String(row.querySelector('[name="headerName"]')?.value ?? '').trim();
      if (!headerName) continue;
      const mode = row.querySelector('[name="headerMode"]')?.value;
      if (mode === 'secret') {
        const secretRef = String(row.querySelector('[name="headerSecretRef"]')?.value ?? '');
        if (!secretRef) continue;
        headers.push({ name: headerName, value: { secretRef } });
      } else {
        headers.push({ name: headerName, value: String(row.querySelector('[name="headerValue"]')?.value ?? '') });
      }
    }
    return headers;
  }
  function reloadMcp(tab = currentMcpTab) {
    const match = location.pathname.match(/^\/dashboard\/mcp-servers\/(mcps_[A-Za-z0-9_-]{20,80})$/);
    return match ? loadMcpServerDetail(match[1], tab) : loadMcpServers();
  }
  function bindMcpServersControls() {
    let secrets = [];
    document.querySelector('[data-mcp-add]')?.addEventListener('click', (event) => {
      const invoker = event.currentTarget;
      void listGlobalSecrets().then((result) => {
        secrets = Array.isArray(result.data?.secrets) ? result.data.secrets : [];
        openMcpDialog(undefined, secrets);
      }).catch((error) => showError(error)).finally(() => invoker.focus?.({ preventScroll: true }));
    });
    document.querySelector('#mcp-server-dialog')?.addEventListener('close', () => {
      document.querySelector('#mcp-dialog-status').textContent = '';
    });
    document.querySelector('[data-mcp-add-header]')?.addEventListener('click', () => {
      document.querySelector('#mcp-header-rows')?.appendChild(mcpHeaderRow({}, secrets));
    });
    document.querySelector('[data-mcp-dialog-test]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const form = document.querySelector('#mcp-server-form');
      const status = document.querySelector('#mcp-dialog-status');
      const serverId = form?.elements.serverId.value;
      if (!serverId) { status.textContent = 'Save this server before testing the connection.'; return; }
      button.disabled = true;
      status.textContent = 'Testing connection…';
      try {
        const result = await testMcpServer(serverId);
        const data = result.data ?? {};
        status.textContent = data.status === 'connected'
          ? `Connected — ${data.toolCount ?? 0} tools discovered.`
          : `Connection failed: ${data.error ?? 'the server did not connect.'}`;
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.querySelector('#mcp-server-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (form.elements.name.value.trim() && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(form.elements.name.value.trim())) {
        document.querySelector('#mcp-dialog-status').textContent = 'Server names are 1-63 lowercase letters, numbers, or hyphens.';
        form.elements.name.focus();
        return;
      }
      const serverId = form.elements.serverId.value;
      const description = String(form.elements.description.value ?? '').trim();
      const payload = {
        name: form.elements.name.value.trim(),
        ...(description ? { description } : (serverId ? { description: null } : {})),
        transport: form.elements.transport.value,
        endpoint: form.elements.endpoint.value.trim(),
        headers: mcpHeadersFromForm(form),
        enabled: form.elements.enabled.checked
      };
      const action = serverId
        ? () => updateMcpServer(serverId, { ...payload, expectedGeneration: Number(form.elements.expectedGeneration.value) })
        : () => createMcpServer({ ...payload, permissionDefault: 'allow', expectedGeneration: 0 });
      void submitForm(form, 'Saving…', action, async () => {
        document.querySelector('#mcp-server-dialog')?.close();
        const status = document.querySelector('#mcp-dialog-status');
        if (status) status.textContent = '';
        announce('MCP server saved.');
        if (serverId) await loadMcpServerDetail(serverId);
        else await loadMcpServers();
      });
    });
    document.querySelector('#cancel-mcp-server')?.addEventListener('click', () => document.querySelector('#mcp-server-dialog')?.close());
    for (const button of document.querySelectorAll('[data-mcp-edit]')) button.addEventListener('click', (event) => {
      const server = currentMcpServers.find((item) => item.id === event.currentTarget.dataset.mcpEdit) ?? currentMcpServer;
      void listGlobalSecrets().then((result) => {
        secrets = Array.isArray(result.data?.secrets) ? result.data.secrets : [];
        openMcpDialog(server, secrets);
      }).catch((error) => showError(error));
    });
    for (const button of document.querySelectorAll('[data-mcp-toggle]')) button.addEventListener('click', async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        await setMcpServerEnabled(target.dataset.mcpToggle, target.dataset.nextEnabled === 'true', Number(target.dataset.generation));
        announce(target.dataset.nextEnabled === 'true' ? 'MCP server enabled.' : 'MCP server disabled.');
        await reloadMcp();
      } catch (error) { showError(error); } finally { target.disabled = false; }
    });
    for (const button of document.querySelectorAll('[data-mcp-test]')) button.addEventListener('click', async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        const result = await testMcpServer(target.dataset.mcpTest);
        const data = result.data ?? {};
        announce(data.status === 'connected' ? `Connected — ${data.toolCount ?? 0} tools discovered.` : `Connection failed: ${data.error ?? 'the server did not connect.'}`);
      } catch (error) { showError(error); } finally { target.disabled = false; }
    });
    for (const button of document.querySelectorAll('[data-mcp-refresh]')) button.addEventListener('click', async (event) => {
      const serverId = event.currentTarget.dataset.mcpRefresh || currentMcpServer?.id;
      if (!serverId) return;
      try {
        await refreshMcpServerTools(serverId);
        announce('MCP tools refreshed.');
        await reloadMcp();
      } catch (error) { showError(error); }
    });
    for (const button of document.querySelectorAll('[data-mcp-delete]')) button.addEventListener('click', (event) => confirmAction({
      title: 'Delete MCP server?',
      description: `Delete "${button.dataset.mcpName ?? 'this server'}"? Its cached tools, permission overrides, and recorded logs are removed.`,
      target: button.dataset.mcpDelete,
      label: 'Delete server',
      pendingLabel: 'Deleting…',
      action: async () => {
        await deleteMcpServer(button.dataset.mcpDelete, Number(button.dataset.generation));
        announce('MCP server deleted.');
        location.href = '/dashboard/mcp-servers';
      }
    }, event.currentTarget));
    for (const button of document.querySelectorAll('[data-mcp-tab]')) button.addEventListener('click', (event) => {
      const serverId = currentMcpServer?.id;
      if (serverId) void loadMcpServerDetail(serverId, event.currentTarget.dataset.mcpTab);
    });
    const toolSearch = document.querySelector('#mcp-tool-search');
    toolSearch?.addEventListener('input', () => {
      const term = toolSearch.value.trim().toLowerCase();
      const scopes = [document.querySelector('.mcp-tools-panel'), content];
      for (const scope of scopes) {
        if (!scope) continue;
        for (const row of scope.querySelectorAll('.desktop-table tbody tr, .mobile-list li')) {
          const match = !term || row.textContent.toLowerCase().includes(term);
          row.hidden = !match;
        }
      }
    });
    document.querySelector('#mcp-permissions-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const serverId = currentMcpServer?.id;
      if (!serverId) return;
      const tools = [];
      for (const select of form.querySelectorAll('select[name^="tool:"]')) tools.push({ name: select.name.slice('tool:'.length), permission: select.value });
      const payload = {
        permissionDefault: form.elements.permissionDefault.value,
        tools,
        expectedGeneration: Number(form.elements.expectedGeneration.value)
      };
      void submitForm(form, 'Saving…', () => setMcpServerPermissions(serverId, payload), async () => {
        announce('MCP permissions saved.');
        await loadMcpServerDetail(serverId, 'permissions');
      });
    });
    document.querySelector('#mcp-load-more-logs')?.addEventListener('click', async (event) => {
      const serverId = currentMcpServer?.id;
      if (!serverId) return;
      const result = await listMcpServerLogs(serverId, event.currentTarget.dataset.cursor);
      currentMcpTraces = [...currentMcpTraces, ...(result.data?.traces ?? [])];
      content.innerHTML = renderMcpServerDetail(currentMcpServer, currentMcpTools, currentMcpTraces, 'logs', result.cursor, currentMcpGateway);
      bindMcpServersControls();
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
  const themeToggle = document.querySelector('#theme-toggle');
  const themeIcons = themeToggle.querySelectorAll('svg[data-theme-value]');
  function renderThemeToggle() {
    const active = normalizeTheme(document.documentElement.dataset.theme);
    // `hidden` is an HTMLElement property; on an SVGElement the property form is an
    // expando and never reflects to the attribute, so set the attribute directly.
    for (const icon of themeIcons) {
      if (icon.dataset.themeValue === active) icon.removeAttribute('hidden');
      else icon.setAttribute('hidden', '');
    }
    themeToggle.setAttribute('aria-label', themeActionLabel(active));
  }
  themeToggle.addEventListener('click', () => {
    const value = nextTheme(document.documentElement.dataset.theme);
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    renderThemeToggle();
    announce(`Theme set to ${value}.`);
    void api('/preferences', { method: 'PUT', body: requestBody({ theme: value }) }).catch(() => announce('Theme preference was not saved.'));
  });
  renderThemeToggle();
  const paletteDialog = document.querySelector('#command-palette');
  const paletteInput = document.querySelector('#palette-input');
  const paletteResults = document.querySelector('#palette-results');
  const paletteStatus = document.querySelector('#palette-status');
  const openPaletteButton = document.querySelector('#open-palette');
  function invalidatePalette() {
    paletteLoader.invalidate();
  }
  function announcePaletteStatus(message) {
    globalThis.clearTimeout(paletteAnnounceTimer);
    paletteAnnounceTimer = globalThis.setTimeout(() => { paletteStatus.textContent = message; }, 150);
  }
  function renderPalette(query) {
    const entries = rankPaletteMatches(paletteLoader.read() ?? PALETTE_PAGE_COMMANDS, query);
    if (paletteActive >= entries.length) paletteActive = entries.length - 1;
    if (paletteActive < 0 && entries.length) paletteActive = 0;
    if (!entries.length) paletteActive = -1;
    paletteResults.innerHTML = renderPaletteResults(entries, paletteActive);
    paletteInput.setAttribute('aria-expanded', String(entries.length > 0));
    if (paletteActive >= 0) paletteInput.setAttribute('aria-activedescendant', `palette-opt-${paletteActive}`);
    else paletteInput.removeAttribute('aria-activedescendant');
    paletteResults.querySelector(`#palette-opt-${paletteActive}`)?.scrollIntoView({ block: 'nearest' });
    return entries;
  }
  function openPalette(invoker) {
    if (paletteDialog.open || document.querySelector('dialog[open]')) return;
    paletteInvoker = invoker ?? null;
    paletteActive = -1;
    paletteInput.value = '';
    paletteDialog.showModal();
    const entries = renderPalette('');
    paletteInput.focus({ preventScroll: true });
    announcePaletteStatus(`${entries.length} results.`);
    void paletteLoader.ensure().then(() => {
      if (!paletteDialog.open) return;
      announcePaletteStatus(`${renderPalette(paletteInput.value).length} results.`);
    }).catch(() => undefined);
  }
  function closePalette() {
    if (paletteDialog.open) paletteDialog.close();
    paletteInvoker?.focus({ preventScroll: true });
  }
  paletteInput.addEventListener('input', () => {
    announcePaletteStatus(`${renderPalette(paletteInput.value).length} results.`);
  });
  paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closePalette(); return; }
    const options = paletteResults.querySelectorAll('[role="option"]');
    if (!options.length) return;
    if (event.key === 'ArrowDown') paletteActive = (paletteActive + 1) % options.length;
    else if (event.key === 'ArrowUp') paletteActive = (paletteActive - 1 + options.length) % options.length;
    else if (event.key === 'Home') paletteActive = 0;
    else if (event.key === 'End') paletteActive = options.length - 1;
    else if (event.key === 'Enter') {
      const href = options[paletteActive]?.dataset.href;
      if (href) { event.preventDefault(); location.href = href; }
      return;
    } else return;
    event.preventDefault();
    renderPalette(paletteInput.value);
  });
  // Keep focus in the input: mousedown must not move it into the listbox.
  paletteResults.addEventListener('mousedown', (event) => { if (event.target.closest?.('[role="option"]')) event.preventDefault(); });
  paletteResults.addEventListener('click', (event) => {
    const href = event.target.closest?.('[role="option"]')?.dataset.href;
    if (href) location.href = href;
  });
  paletteDialog.addEventListener('cancel', (event) => { event.preventDefault(); closePalette(); });
  dismissOnBackdrop(paletteDialog, closePalette);
  openPaletteButton.addEventListener('click', (event) => openPalette(event.currentTarget));
  document.addEventListener('keydown', (event) => {
    if (!isPaletteHotkey(event)) return;
    event.preventDefault();
    if (paletteDialog.open) { closePalette(); return; }
    openPalette(openPaletteButton);
  });
  // Header identity: the editable display name wins, then the verified assertion.
  function applyIdentity(data) {
    const identity = data?.identity ?? {};
    const display = profileDisplayName(data);
    document.querySelector('#profile-name').textContent = display;
    document.querySelector('#profile-email').textContent = identity.email ?? '';
    const parts = String(display).trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2);
    document.querySelector('#profile-avatar').textContent = (parts.map((part) => part[0]).join('') || '?').toUpperCase();
  }
  async function refreshIdentity() {
    try { applyIdentity((await api('/profile')).data); } catch { /* identity chip keeps its last value */ }
  }
  void refreshIdentity();
  document.addEventListener('click', (event) => { if (event.target.closest?.('a[href]')) apiKeyReveal.clear(); }, { capture: true });
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-copy]');
    if (!trigger) return;
    void globalThis.navigator.clipboard.writeText(trigger.dataset.copy).then(() => announce('Copied to clipboard.')).catch(() => announce('Copy failed. Select and copy the value manually.'));
  });
  addEventListener('pagehide', () => { apiKeyReveal.clear(); paletteLoader.invalidate(); });
  addEventListener('popstate', () => location.reload()); void load();
}

if (typeof document !== 'undefined') initializeDashboard();
