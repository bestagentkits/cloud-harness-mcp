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
  escapeHtml,
  launchBlockedByConflicts,
  renderApiKeyIndex, renderArtifactIndex, renderAuditIndex, renderFile, renderFileList, renderGitHub, renderGlobalSecrets, renderModelsPage, renderOverview, renderOverviewSkeleton,
  renderProjectDetail, renderProfile, renderProjectIndex, renderWorkspaceDetail, renderWorkspaceIndex, renderSettings, repositoryName,
  renderKnowledgeIndex, renderKnowledgeDetail, renderKnowledgeGraph, renderMarkdown, renderPaletteResults, profileDisplayName,
  renderMcpServersIndex, renderMcpServerDetail,
  renderSkillsLibraryCards, renderSkillsLibraryRows, renderSkillsRegistryRows,
  renderSkillConflicts,
  renderSkillSetChips, renderSkillSetOptions, renderSkillSetPicker, renderSkillRevisions,
  renderSkillsSkeleton,
  renderImportJobGuidance, isTerminalImportState,
  renderModelsActions, renderGitHubActions, renderMcpActions,
  renderPrimaryAction,
  renderWorkspaceCockpitHeader, renderWorkspaceTabs, renderWorkspaceSummary,
  renderWorkspaceArtifacts, renderWorkspaceActivity, renderFinalizeDialog,
  renderAgentsIndex, renderAgentDetail,
  renderRuntimePanel, renderGitPanel,
  renderAutomationPanel, renderDeployPanel,
  renderActivityCenter, renderApprovals
} from './dashboard-render.js';
import { navGroups, navigationPageId, pageById, pageForPath, palettePageCommands } from './dashboard-pages.js';

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
  // A malformed or relative href must not escape as a raw URL error; the drawer
  // reports one actionable message instead.
  let id;
  try {
    id = new URL(trigger.href, globalThis.location?.origin ?? 'http://localhost').pathname.split('/').at(-1);
  } catch {
    throw new Error('Workspace link could not be resolved.');
  }
  const item = await fetchWorkspace(id);
  content.querySelector('[aria-current="true"]')?.removeAttribute('aria-current');
  trigger.setAttribute('aria-current', 'true');
  insertRendered(detail, renderWorkspaceDetail(item, false, modal));
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
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BUILTIN_SKILLS_ROOT'
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

/**
 * Which of the library's three states the current data calls for. A library with no skills and a library
 * whose filters match nothing are different facts with different remedies, so they never share a
 * message, and the count is stated in every state: "0 of 12" is what tells an operator that a filter is
 * responsible rather than the library.
 */
export function skillsLibraryState({ total, visible }) {
  const all = Number.isFinite(total) && total > 0 ? total : 0;
  const shown = Number.isFinite(visible) && visible > 0 ? visible : 0;
  if (all === 0) {
    return {
      kind: 'empty',
      count: 'No skills yet',
      message: 'No skills yet. Import one from Discover, or create a custom skill.',
      action: 'discover',
      actionLabel: 'Discover skills'
    };
  }
  if (shown === 0) {
    return {
      kind: 'no-match',
      count: `0 of ${all} skills`,
      message: 'No skills match the current filters.',
      action: 'clear',
      actionLabel: 'Clear filters'
    };
  }
  const label = all === 1 ? 'skill' : 'skills';
  return {
    kind: 'rows',
    count: shown === all ? `${all} ${label}` : `${shown} of ${all} skills`,
    message: '',
    action: null,
    actionLabel: ''
  };
}

/**
 * Library tab controller: debounced search, selection that drives the bulk bar, and a bulk call whose
 * per-item results decide what stays selected. The server is authoritative, so a row it could not
 * apply keeps its selection and reports its blocker instead of being dropped from the batch, which
 * would silently turn a partial failure into an apparent success.
 */
export function createSkillsLibraryController({ bulkBar, bulkCount, onSearch, onBulk, debounceMs = 300 }) {
  let timer;
  const selected = new Map();

  function renderBulkBar() {
    if (bulkBar) bulkBar.hidden = selected.size === 0;
    if (bulkCount) bulkCount.textContent = `${selected.size} selected`;
  }

  function applyResults(results) {
    for (const result of Array.isArray(results) ? results : []) {
      if (result.ok === true) selected.delete(result.skillId);
      else selected.set(result.skillId, result.error ?? 'unknown');
    }
    renderBulkBar();
    return blockers();
  }

  function blockers() {
    return [...selected.entries()]
      .filter(([, blocker]) => blocker !== undefined)
      .map(([skillId, blocker]) => ({ skillId, blocker }));
  }

  return {
    search(value) {
      if (timer) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => { timer = undefined; onSearch(value); }, debounceMs);
    },
    pendingSearch() { return timer !== undefined; },
    toggle(skillId, isSelected) {
      if (isSelected) selected.set(skillId, undefined);
      else selected.delete(skillId);
      renderBulkBar();
    },
    selectedIds() { return [...selected.keys()]; },
    blockers,
    applyResults,
    async runBulk(action) {
      const skillIds = [...selected.keys()];
      if (skillIds.length === 0) return [];
      return applyResults(await onBulk(action, skillIds));
    }
  };
}

/**
 * The editor stores instructions and never executes them, so this validation is not a safety control:
 * it rejects input the runner would refuse anyway. A null byte cannot survive the contract, and
 * frontmatter that opens and never closes would produce a skill that resolves but never loads.
 */
export function validateSkillInstructions(text) {
  const value = String(text ?? '');
  if (value.trim() === '') return 'Instructions cannot be empty.';
  if (value.includes('\0')) return 'Instructions cannot contain null bytes.';
  if (/^\s*---\s*\n/.test(value) && value.indexOf('\n---', 3) === -1) return 'Frontmatter opens with --- but never closes.';
  return null;
}

/**
 * Import polling with a bounded attempt count. It stops on a terminal job state and on exhausting the
 * budget, so a job whose runner died leaves the operator with a stopped poller instead of a spinner
 * that never ends.
 */
/**
 * Inserts renderer output by adopting parsed nodes. Browsers parse with DOMParser,
 * which keeps renderer markup off the live tree as a string; the test doubles install
 * their own parser and adoption method, so no raw-HTML assignment lives in this
 * module. Every renderer escapes the values it interpolates.
 */
function insertRendered(element, html) {
  if (!element) return;
  const markup = String(html ?? '');
  const parsed = new globalThis.DOMParser().parseFromString(markup, 'text/html');
  element.replaceChildren(...parsed.body.childNodes);
}

/**
 * The single navigation seam. Every Dashboard navigation target is a same-origin
 * Dashboard path; anything else is refused rather than followed, so a rendered
 * value can never turn into an off-site redirect. Exported for its own test.
 */
export function dashboardNavigationPath(target) {
  const value = String(target ?? '');
  return /^\/dashboard(?:[/?#]|$)/.test(value) ? value : '/dashboard';
}

function navigateTo(target) {
  globalThis.location.href = dashboardNavigationPath(target);
}

/**
 * Sidebar markup for the page registry. Labels, routes, groups and icons are
 * authored in `dashboard-pages.js` and nowhere else, so navigation cannot drift
 * away from routing again. The icon markup is trusted static SVG from that
 * module; every text value is escaped here.
 */
export function renderSidebarNavMarkup(groups = navGroups()) {
  return groups.map((group) => [
    `<p class="nav-group">${escapeHtml(group.label)}</p>`,
    ...group.pages.map((page) => `<a href="${escapeHtml(page.route)}" data-section="${escapeHtml(page.id)}"><svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${page.icon}</svg>${escapeHtml(page.label)}${page.id === 'approvals' ? '<span class="nav-badge" id="nav-badge-approvals" hidden></span>' : ''}</a>`)
  ].join('')).join('');
}

export function createImportPollingController({ fetchJob, onState, isTerminal, intervalMs = 1_500, maxAttempts = 40 }) {
  let attempts = 0;
  let stopped = false;
  let timer;

  async function tick() {
    if (stopped) return;
    attempts += 1;
    const job = await fetchJob();
    onState(job);
    if (stopped) return;
    if (isTerminal(job) || attempts >= maxAttempts) {
      stopped = true;
      return;
    }
    timer = globalThis.setTimeout(() => { void tick(); }, intervalMs);
  }

  return {
    start() { stopped = false; attempts = 0; return tick(); },
    stop() { stopped = true; if (timer) globalThis.clearTimeout(timer); timer = undefined; },
    attempts() { return attempts; },
    running() { return !stopped; }
  };
}

/**
 * Tab controller for the skills page. It keeps `aria-selected` and `tabindex` in step with the visible
 * panel, and enters each tab once so switching back and forth does not re-request what is already on
 * screen.
 */
export function createSkillsTabsController({ tabs, panels, onEnter }) {
  const entered = new Set();
  return {
    select(name) {
      for (const tab of tabs) {
        tab.element.setAttribute('aria-selected', tab.name === name ? 'true' : 'false');
        tab.element.setAttribute('tabindex', tab.name === name ? '0' : '-1');
      }
      for (const panel of panels) panel.element.hidden = panel.name !== name;
      if (!entered.has(name)) {
        entered.add(name);
        if (onEnter) onEnter(name);
      }
    },
    enteredTabs() { return [...entered]; }
  };
}

/**
 * Editor submit. Nothing is executed here, so the failure modes that matter are an input the runner
 * would refuse and a generation conflict. In both cases the draft is kept: discarding an operator's
 * typing because the server moved on would lose work that is still valid against the newer revision.
 *
 * The editor creates a skill. Changing the instructions of an existing one would need a revision the
 * runner does not offer an operation for, so the form does not pretend to do it: metadata edits go
 * through the update operation, and content edits are a new skill until such an operation exists.
 */
export function createSkillEditorController({ slug, displayName, instructions, save }) {
  return {
    async submit() {
      const value = instructions ? instructions.value : '';
      const slugValue = slug ? String(slug.value).trim() : '';
      const nameValue = displayName ? String(displayName.value).trim() : '';
      if (slug && !/^[A-Za-z0-9._-]{1,120}$/.test(slugValue)) {
        return { ok: false, reason: 'invalid', message: 'A slug may contain letters, digits, dot, dash, and underscore.', keepDraft: true };
      }
      const problem = validateSkillInstructions(value);
      if (problem) return { ok: false, reason: 'invalid', message: problem, keepDraft: true };
      try {
        const body = { slug: slugValue, displayName: nameValue, instructions: value, expectedGeneration: 0 };
        return { ok: true, result: await save(body), keepDraft: false };
      } catch (error) {
        const status = error && typeof error === 'object' ? error.status : undefined;
        const message = error instanceof Error ? error.message : 'Save failed.';
        return {
          ok: false,
          reason: status === 409 ? 'conflict' : 'error',
          message: status === 409 ? 'A skill with this slug already exists. Choose another slug.' : message,
          keepDraft: true
        };
      }
    }
  };
}

/**
 * Builds the import request the runner accepts. The source is checked here because the wizard's review
 * step has to show the operator something concrete before anything is fetched, and a mistyped source
 * discovered after a provider round trip costs more than a message beside the field.
 */
export function buildSkillImportRequest({ sourceKind, sourceRef, ref }) {
  const kind = ['skills-sh', 'skillx', 'git'].includes(sourceKind) ? sourceKind : 'skills-sh';
  const value = String(sourceRef ?? '').trim();
  if (value === '') return { ok: false, message: 'Enter the skill source to import.' };
  if (kind !== 'skillx' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    return { ok: false, message: 'Enter the source as owner/repository.' };
  }

  const pinned = String(ref ?? '').trim();
  // The operation takes a full object id, not a branch or tag, so a branch name would be refused by
  // the runner after the wizard claimed to accept it.
  if (pinned !== '' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pinned)) {
    return { ok: false, message: 'A ref has to be a full 40 or 64 character hexadecimal commit id.' };
  }

  return {
    ok: true,
    body: {
      sourceKind: kind,
      sourceRef: value,
      ...(pinned === '' ? {} : { ref: pinned }),
      expectedGeneration: 0
    }
  };
}

/**
 * Launch skill-set selection. Submit stays disabled while a conflict has no override, because the
 * resolver would refuse the launch anyway, and a control that looks available but fails is worse than
 * one that says why it cannot be used yet. The preview is what makes that decision honest: the dialog
 * gates on what launch would actually resolve rather than on a local guess.
 */
export function createLaunchSkillSetController({ submit, loadSets, preview }) {
  let sets = [];
  let chosen = [];
  let overrides = {};
  let conflicts = [];

  function request() {
    return chosen.map((id) => {
      const match = sets.find((set) => set.id === id);
      return { skillSetId: id, expectedGeneration: match ? match.generation : 0 };
    });
  }

  const controller = {
    async load() { sets = (await loadSets()) ?? []; return sets; },
    sets() { return sets; },
    choose(ids) { chosen = [...ids]; return chosen; },
    chosen() { return chosen; },
    conflictList() { return conflicts; },
    overrides() { return overrides; },
    blocked() { return launchBlockedByConflicts(conflicts, overrides); },
    body() { return { skillSets: request(), skillOverrides: overrides }; },
    async resolve(name, revisionId) {
      overrides = { ...overrides, [name]: revisionId };
      return controller.refresh();
    },
    async refresh() {
      const payload = request();
      // Nothing selected means nothing to resolve, so the preview is not asked to describe an empty
      // launch and submit is left available for a workspace with no skill sets.
      const result = payload.length === 0 ? { resolved: [], excluded: [], conflicts: [] } : await preview(payload, overrides);
      conflicts = result.conflicts ?? [];
      const blocked = launchBlockedByConflicts(conflicts, overrides);
      if (submit) submit.disabled = blocked;
      return { ...result, blocked };
    }
  };
  return controller;
}

/**
 * The bulk operation carries one generation for the whole batch, so a caller that selects rows from
 * different generations has to group them. Sending one batch with a single generation would report
 * every other row as a conflict, which looks like a locking problem when it is really a batching one.
 */
export function groupBulkRequests(skills, skillIds) {
  const groups = new Map();
  for (const skillId of Array.isArray(skillIds) ? skillIds : []) {
    const skill = (Array.isArray(skills) ? skills : []).find((candidate) => candidate.id === skillId);
    const generation = skill ? skill.generation : undefined;
    const key = String(generation ?? 'unknown');
    const group = groups.get(key) ?? { generation, skillIds: [] };
    group.skillIds.push(skillId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Body for creating a skill set. A set stores the exact revision of each member, so the builder
 * resolves the current revision of every chosen skill rather than storing a name that could later
 * resolve to different content. A member without a revision is refused here, because the runner would
 * accept the name and only fail when the set is used.
 */
export function buildSkillSetBody({ name, description, skills, selectedIds }) {
  const trimmed = String(name ?? '').trim();
  if (trimmed === '') return { ok: false, message: 'A skill set needs a name.' };
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  if (ids.length === 0) return { ok: false, message: 'Select at least one skill.' };

  const items = [];
  for (const id of ids) {
    const skill = (Array.isArray(skills) ? skills : []).find((candidate) => candidate.id === id);
    if (!skill || !skill.currentRevisionId) {
      return { ok: false, message: 'Every member needs a skill that has a revision.' };
    }
    items.push({ skillSourceId: id, revisionId: skill.currentRevisionId, name: skill.slug ?? skill.displayName ?? id });
  }

  return { ok: true, body: { name: trimmed, description: String(description ?? ''), items, expectedGeneration: 0 } };
}

/**
 * Palette page commands are registry output, not a second list: a page cannot be
 * navigable yet absent from the palette, and every hint lives beside the page it
 * describes.
 */
export const PALETTE_PAGE_COMMANDS = palettePageCommands();

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
  // The sidebar is registry output; index.html ships an empty container so a page
  // label cannot live in two places.
  insertRendered(document.querySelector('#sidebar-nav'), renderSidebarNavMarkup());
  const dialog = document.querySelector('#confirm-dialog'); const menuButton = document.querySelector('#menu-button');
  const revealDialog = document.querySelector('#api-key-reveal-dialog');
  const pathMatch = location.pathname.match(/^\/dashboard\/workspaces\/(ws_[A-Za-z0-9_-]{20,80})(?:\/(summary|agents|runtime|files|git|automation|deploy|artifacts|activity))?$/);
  const projectMatch = location.pathname.match(/^\/dashboard\/projects\/(prj_[A-Za-z0-9_-]{20,80})$/);
  const knowledgeMatch = location.pathname.match(/^\/dashboard\/knowledge\/(kn_[A-Za-z0-9_-]{10,80})$/);
  const mcpServerMatch = location.pathname.match(/^\/dashboard\/mcp-servers\/(mcps_[A-Za-z0-9_-]{20,80})$/);
  const agentMatch = location.pathname.match(/^\/dashboard\/agents\/(agent_[A-Za-z0-9_-]{20,80})$/);
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
    if (bulkPreview) insertRendered(bulkPreview, '');
    if (bulkStatus) bulkStatus.textContent = '';
    if (bulkDialog) bulkDialog.showModal();
    if (bulkInput) bulkInput.focus();
  }
  function closeBulkImport() {
    if (bulkInput) bulkInput.value = '';
    if (bulkPreview) insertRendered(bulkPreview, '');
    if (bulkStatus) bulkStatus.textContent = '';
    if (bulkDialog && bulkDialog.open) bulkDialog.close();
  }
  document.querySelector('#cancel-bulk-import')?.addEventListener('click', () => closeBulkImport());
  bulkDialog?.addEventListener('cancel', () => closeBulkImport());
  bulkDialog?.addEventListener('close', () => closeBulkImport());
  bulkInput?.addEventListener('input', () => {
    const parsed = parseDotEnv(bulkInput.value);
    if (!parsed.length) {
      insertRendered(bulkPreview, '<span class="diff-skip">No variable assignments found.</span>');
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
    insertRendered(bulkPreview, lines.join(''));
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
    // A loader passes a page id and nothing else: the registry owns which sidebar
    // entry stays current, the heading, the help text and the document title.
    const page = pageById(section);
    const activeId = page ? navigationPageId(page) : section;
    for (const link of sidebar.querySelectorAll('a[data-section]')) {
      if (link.dataset.section === activeId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    insertRendered(document.querySelector('#context-nav'), '');
    // The action slot follows the page, so a page without a primary action cannot
    // inherit the previous page's button.
    insertRendered(document.querySelector('#page-actions'), '');
    if (page) setTitle(page.title, page.help);
  }
  /**
   * The page's single primary action (plus at most one secondary action) lives in
   * the shell's action slot, next to the page heading, instead of inside content.
   */
  function setPageActions(markup) {
    insertRendered(document.querySelector('#page-actions'), markup ?? '');
  }
  /**
   * Dialog wiring. Opening is delegated once on the document, because a page's
   * primary action lives in the shell's action slot — outside `#content` — so a
   * content-scoped binding would silently miss the most important trigger.
   * Dismissal is bound per render, since the `close` event does not bubble.
   */
  function openDialog(trigger) {
    const target = document.getElementById(trigger.dataset.dialog);
    if (!target || typeof target.showModal !== 'function') return;
    target.dataset.invokerId = trigger.id ?? '';
    if (!target.open) target.showModal();
    const firstField = target.querySelector('input:not([type="hidden"]), select, textarea');
    (firstField ?? target.querySelector('[data-dialog-close]'))?.focus?.();
  }
  document.addEventListener('click', (event) => {
    const closeTrigger = event.target?.closest?.('[data-dialog-close]');
    if (closeTrigger) { closeTrigger.closest('dialog')?.close(); return; }
    const trigger = event.target?.closest?.('[data-dialog]');
    if (trigger) openDialog(trigger);
  });
  function bindDialogDismissal(root) {
    for (const dialogElement of root.querySelectorAll('dialog')) {
      dialogElement.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialogElement.close());
      dialogElement.addEventListener('close', () => {
        const invokerId = dialogElement.dataset.invokerId;
        if (invokerId) document.getElementById(invokerId)?.focus?.({ preventScroll: true });
      });
    }
  }
  /** Copy affordances for identifiers: the value is copied, never re-rendered. */
  function bindCopyAffordances(root) {
    for (const chip of root.querySelectorAll('[data-copy]')) {
      chip.addEventListener('click', async () => {
        const value = chip.dataset.copy ?? '';
        const label = chip.dataset.copyLabel ?? 'Value';
        try {
          await globalThis.navigator.clipboard.writeText(value);
          chip.textContent = 'Copied';
          announce(`${label} copied.`);
          globalThis.setTimeout(() => { chip.textContent = value; }, 2_000);
        } catch {
          announce('Copy failed. Select the value and copy it manually.');
        }
      });
    }
  }
  // Static pages resolve through the registry; detail routes keep their own matchers
  // because they need the captured id.
  const PAGE_LOADERS = {
    overview: loadOverview,
    workspaces: loadIndex,
    audit: loadAudit,
    projects: loadProjects,
    secrets: loadGlobalSecrets,
    models: loadModels,
    skills: loadSkills,
    integrations: () => (location.pathname === '/dashboard/integrations/mcp-servers' ? loadMcpServers() : loadGitHub()),
    knowledge: loadKnowledge,
    agents: loadAgents,
    activity: loadActivity,
    approvals: loadApprovals,
    artifacts: loadArtifacts,
    'api-keys': loadApiKeys,
    settings: loadSettings,
    profile: loadProfile
  };
  async function load() {
    alertBox.hidden = true; setBusy(true);
    try {
      const page = pageForPath(location.pathname);
      if (pathMatch?.[2] === 'files') await loadFiles(pathMatch[1]);
      else if (pathMatch?.[2] === 'runtime') await loadRuntime(pathMatch[1]);
      else if (pathMatch) await loadWorkspace(pathMatch[1], pathMatch[2] ?? 'summary');
      else if (projectMatch) await loadProject(projectMatch[1]);
      else if (knowledgeMatch) await loadKnowledgeDetailView(knowledgeMatch[1]);
      else if (mcpServerMatch) await loadMcpServerDetail(mcpServerMatch[1]);
      else if (agentMatch) await loadAgentDetail(agentMatch[1]);
      else if (page && PAGE_LOADERS[page.id]) await PAGE_LOADERS[page.id]();
      else throw Object.assign(new Error('Dashboard page not found.'), { status: 404 });
      // Shared resource-page behavior is wired once per render rather than in every
      // loader: dialog dismissal with focus restore, and copy affordances in both
      // the content and the shell's action slot.
      bindDialogDismissal(content);
      bindCopyAffordances(content); bindCopyAffordances(document.querySelector('#page-actions'));
      setBusy(false); main.focus({ preventScroll: true });
    } catch (error) { showError(error); }
  }
  async function loadSkills() {
    selectNavigation('skills');
    document.querySelector('#command-surface').hidden = true;
    // Creating a skill is this page's one primary action, and it lives in the shell's action slot so it is
    // reachable from every tab. `selectNavigation` has already emptied that slot, so nothing is inherited.
    setPageActions(renderPrimaryAction({ id: 'open-skill-editor', label: 'New skill', dialogId: 'skill-editor-dialog' }));
    insertRendered(content, renderSkillsSkeleton());

    let rows = [];
    let query = '';
    // Filters and sort are applied in the browser over the rows the server already returned, because the
    // library is small enough that a round trip per keystroke would cost more than it explains.
    let providerFilter = '';
    let stateFilter = '';
    let tagFilter = '';
    let sortKey = 'name';

    const library = createSkillsLibraryController({
      bulkBar: document.querySelector('#skills-bulk-bar'),
      bulkCount: document.querySelector('#skills-bulk-count'),
      onSearch: (value) => { query = value; paintLibrary(); },
      onBulk: async (action, skillIds) => {
        const merged = [];
        for (const group of groupBulkRequests(rows, skillIds)) {
          const result = await api('/skills/bulk', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, skillIds: group.skillIds, expectedGeneration: group.generation ?? 0 })
          });
          merged.push(...(result.data.results ?? []));
        }
        return merged;
      }
    });

    function paintLibrary() {
      const body = document.querySelector('#skills-library-table tbody');
      if (!body) return;
      const needle = query.trim().toLowerCase();
      const tag = tagFilter.trim().toLowerCase();
      const sortField = sortKey === 'name' ? 'displayName' : sortKey;
      const visible = rows
        .filter((skill) => providerFilter === '' || skill.provider === providerFilter)
        .filter((skill) => stateFilter === '' || skill.state === stateFilter)
        .filter((skill) => tag === '' || (Array.isArray(skill.tags) ? skill.tags : [])
          .some((entry) => String(entry).toLowerCase().includes(tag)))
        .filter((skill) => needle === '' || `${skill.displayName} ${skill.slug} ${skill.provider}`.toLowerCase().includes(needle))
        .sort((a, b) => String(a[sortField] ?? '').localeCompare(String(b[sortField] ?? '')));
      const state = skillsLibraryState({ total: rows.length, visible: visible.length });
      insertRendered(body, renderSkillsLibraryRows(visible));
      const cards = document.querySelector('#skills-library-cards');
      if (cards) insertRendered(cards, renderSkillsLibraryCards(visible));
      paintLibraryState(state);
      // Both renderings carry the same controls, so both are wired rather than only the visible one.
      for (const scope of [body, cards]) {
        if (!scope) continue;
        for (const box of scope.querySelectorAll('[data-skill-select]')) {
          box.addEventListener('change', () => library.toggle(box.getAttribute('data-skill-select'), box.checked));
        }
        for (const button of scope.querySelectorAll('[data-skill-detail]')) {
          button.addEventListener('click', () => { void openSkillDetail(button.getAttribute('data-skill-detail')).catch(showError); });
        }
      }
    }

    /**
     * The library's states are exclusive: the table and its mobile card list carry the rows, and the
     * empty block carries one of the two reasons there are none. The count is stated in every case.
     */
    function paintLibraryState(state) {
      const showingRows = state.kind === 'rows';
      const table = document.querySelector('#skills-library-table');
      const cards = document.querySelector('#skills-library-cards');
      const empty = document.querySelector('#skills-library-empty');
      const message = document.querySelector('#skills-library-empty-message');
      const action = document.querySelector('#skills-library-empty-action');
      const count = document.querySelector('#skills-library-count');
      if (table) table.hidden = !showingRows;
      if (cards) cards.hidden = !showingRows;
      if (empty) empty.hidden = showingRows;
      if (message) message.textContent = state.message;
      if (count) count.textContent = state.count;
      if (action) {
        action.textContent = state.actionLabel;
        action.setAttribute('data-skills-action', state.action ?? '');
      }
    }

    /**
     * Usage and preset rows are built from text nodes rather than from markup, because both lists carry
     * values the server chose and a list is not worth an injection surface. Usage names the two places a
     * skill can be in use rather than a count, since a skill inside a set and a skill pinned by a live
     * workspace are different risks, and lock is that fact stated as its consequence.
     */
    function skillUsageNodes(usage) {
      const sets = Array.isArray(usage?.sets) ? usage.sets : [];
      const live = Array.isArray(usage?.liveWorkspaces) ? usage.liveWorkspaces : [];
      const locked = sets.length > 0 || live.length > 0;
      const nodes = [];
      const lock = document.createElement('p');
      lock.id = 'skill-usage-lock';
      lock.textContent = locked ? 'locked' : 'unlocked';
      nodes.push(lock);
      const setsHeading = document.createElement('h4');
      setsHeading.textContent = 'Skill sets';
      nodes.push(setsHeading, ...(sets.length === 0
        ? [textNode('li', 'Not in any skill set.')]
        : sets.map((set) => textNode('li', `${set.name} ${set.skillSetId}`))));
      const liveHeading = document.createElement('h4');
      liveHeading.textContent = 'Live workspaces';
      nodes.push(liveHeading, ...(live.length === 0
        ? [textNode('li', 'Not pinned by any live workspace.')]
        : live.map((entry) => textNode('li', `${entry.name} ${entry.status} ${entry.revisionId}`))));
      return nodes;
    }

    /** A preset is a suggestion to install, so its row says installable rather than reading as inventory. */
    function skillPresetNodes(presets) {
      const rows = Array.isArray(presets) ? presets : [];
      if (rows.length === 0) return [textNode('li', 'No presets are available to install.')];
      return rows.map((preset) => {
        const item = textNode('li', `${preset.name} ${preset.defaultRevision} ${preset.description} ${preset.installable ? 'installable' : 'unavailable'}`);
        item.setAttribute('data-preset-id', String(preset.id ?? ''));
        return item;
      });
    }

    function textNode(tag, value) {
      const element = document.createElement(tag);
      element.textContent = String(value ?? '');
      return element;
    }

    /**
     * Search results name what could be imported, so each row carries the provider and the reference an
     * import would take. A provider that failed is reported beside the hits rather than replacing them,
     * because an empty list and a broken provider are different facts.
     */
    function skillSearchNodes(data) {
      const local = Array.isArray(data?.local) ? data.local : [];
      const remote = Array.isArray(data?.results) ? data.results : [];
      const providers = Array.isArray(data?.providers) ? data.providers : [];
      const nodes = [];
      for (const provider of providers) {
        if (provider.status !== 'ok') nodes.push(textNode('p', `${provider.provider}: ${provider.warning ?? 'unavailable'}`));
      }
      if (local.length === 0 && remote.length === 0) {
        nodes.push(textNode('p', 'No skills matched.'));
        return nodes;
      }
      const list = document.createElement('ul');
      for (const skill of local) list.append(textNode('li', `${skill.displayName} ${skill.slug} local`));
      for (const hit of remote) list.append(textNode('li', `${hit.name} ${hit.reference} ${hit.provider}`));
      nodes.push(list);
      return nodes;
    }

    /** Loads a tab's data the first time it is entered, which is what the tab controller guarantees. */
    /** The drawer reads revisions from the server, and a restore republishes rather than rewrites. */
    async function openSkillDetail(skillId) {
      const skill = rows.find((candidate) => candidate.id === skillId);
      const drawer = document.querySelector('#skill-detail');
      if (!drawer) return;
      drawer.hidden = false;
      // The drawer names what is open. Without it the operator has to remember which row they clicked
      // once the table has scrolled away, and four unlabelled containers have to speak for themselves.
      const title = document.querySelector('#skill-detail-title');
      const slugLine = document.querySelector('#skill-detail-slug');
      if (title) title.textContent = skill ? skill.displayName : 'Skill detail';
      if (slugLine) slugLine.textContent = skill ? skill.slug : '';
      // Instructions come from the row the server already returned, so the section carries real content
      // instead of being a labelled box the page never fills.
      const instructionsBox = document.querySelector('#skill-detail-instructions');
      if (instructionsBox) {
        const instructions = skill && typeof skill.instructions === 'string' ? skill.instructions.trim() : '';
        instructionsBox.replaceChildren(textNode('pre', instructions === '' ? 'No instructions recorded for the current revision.' : instructions));
      }

      const revisions = (await api(`/skills/${encodeURIComponent(skillId)}/revisions`)).data.revisions ?? [];
      const box = document.querySelector('#skill-detail-revisions');
      if (!box) return;
      insertRendered(box, renderSkillRevisions(revisions, skill ? skill.currentRevisionId : undefined));
      for (const button of box.querySelectorAll('[data-skill-restore]')) {
        button.addEventListener('click', () => { void restoreRevision(skillId, button.getAttribute('data-skill-restore')).catch(showError); });
      }
      for (const button of box.querySelectorAll('[data-skill-diff]')) {
        button.addEventListener('click', () => { void showRevisionDiff(skillId, button.getAttribute('data-skill-diff')).catch(showError); });
      }
      for (const button of box.querySelectorAll('[data-skill-fork]')) {
        button.addEventListener('click', () => { void forkRevision(skillId, button.getAttribute('data-skill-fork')).catch(showError); });
      }
      // The drawer is what tells the editor which skill it is editing, so opening a skill is also what
      // switches the form from creating a source to adding a revision.
      editingSkillId = skillId;

      // Usage and lock come from their own reader, because what would break if this skill changed is a
      // different question from what its revisions contain, and the drawer previously left the usage
      // container in the skeleton empty while showing a lock column only for registry entries.
      const usageBox = document.querySelector('#skill-detail-usage');
      if (usageBox) {
        const usage = (await api(`/skills/${encodeURIComponent(skillId)}/usage`)).data;
        usageBox.replaceChildren(...skillUsageNodes(usage));
      }
    }

    /**
     * A fork starts a new source from the bytes a revision pinned, so it asks for the new source's slug and
     * display name rather than rewriting the revision it came from.
     */
    async function forkRevision(skillId, revisionId) {
      const skill = rows.find((candidate) => candidate.id === skillId);
      const slug = `${skill ? skill.slug : 'skill'}-fork`;
      await api(`/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revisionId)}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, displayName: `${skill ? skill.displayName : 'Skill'} fork`, expectedGeneration: 0 })
      });
      rows = (await api('/skills')).data.skills ?? [];
      paintLibrary();
    }

    /** The diff reader reports a revision whose bytes are missing rather than an empty diff, so the two
     * outcomes are shown as what they are instead of both reading as "no changes". */
    async function showRevisionDiff(skillId, revisionId) {
      const box = document.querySelector('#skill-revision-diff');
      if (!box) return;
      const skill = rows.find((candidate) => candidate.id === skillId);
      const from = skill ? skill.currentRevisionId : undefined;
      if (!from) {
        box.textContent = 'No current revision to compare against.';
        return;
      }
      const response = await api(`/skills/${encodeURIComponent(skillId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(revisionId)}`);
      const data = response.data ?? {};
      box.textContent = typeof data.diff === 'string' && data.diff !== ''
        ? data.diff
        : (typeof data.warning === 'string' ? data.warning : 'No differences.');
    }

    async function restoreRevision(skillId, revisionId) {
      const skill = rows.find((candidate) => candidate.id === skillId);
      await api(`/skills/${encodeURIComponent(skillId)}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId, expectedGeneration: skill ? skill.generation : 0 })
      });
      rows = (await api('/skills')).data.skills ?? [];
      paintLibrary();
      await openSkillDetail(skillId);
    }

    async function enterSkillsTab(name) {
      try {
        if (name === 'library') {
          rows = (await api('/skills')).data.skills ?? [];
          paintLibrary();
        } else if (name === 'discover') {
          // The Discover tab is search-driven, so entering it states what it waits for instead of leaving the
          // panel at whatever the skeleton shipped with, which is what made it look like dead UI.
          const results = document.querySelector('#skills-search-results');
          if (results && results.childElementCount === 0) {
            results.replaceChildren(textNode('p', 'Search a registry to find a skill to import.'));
          }
        } else if (name === 'sets') {
          if (rows.length === 0) rows = (await api('/skills')).data.skills ?? [];
          const picker = document.querySelector('#skill-set-picker');
          if (picker) insertRendered(picker, renderSkillSetPicker(rows));
        } else if (name === 'registry') {
          const body = document.querySelector('#skills-registry-table tbody');
          const registry = await api('/toolkit-registry');
          if (body) insertRendered(body, renderSkillsRegistryRows(registry.data.entries));
          // Presets are rendered from their own field, so a suggestion to install never appears in the
          // table of what is already cached and locked.
          const suggestions = document.querySelector('#skills-registry-suggestions');
          if (suggestions) suggestions.replaceChildren(...skillPresetNodes(registry.data.presets));
        }
      } catch (error) {
        showError(error);
      }
    }

    /** Server state is authoritative after a bulk change, so the table is reloaded rather than patched. */
    async function runBulk(action) {
      await library.runBulk(action);
      rows = (await api('/skills')).data.skills ?? [];
      paintLibrary();
    }

    document.querySelector('#skills-bulk-archive')?.addEventListener('click', () => { void runBulk('archive').catch(showError); });
    document.querySelector('#skills-bulk-disable')?.addEventListener('click', () => { void runBulk('disable').catch(showError); });
    document.querySelector('#skills-library-search')?.addEventListener('input', (event) => library.search(event.target.value));
    document.querySelector('#skills-library-provider')?.addEventListener('change', (event) => { providerFilter = String(event.target.value); paintLibrary(); });
    document.querySelector('#skills-library-state')?.addEventListener('change', (event) => { stateFilter = String(event.target.value); paintLibrary(); });
    document.querySelector('#skills-library-tag')?.addEventListener('input', (event) => { tagFilter = String(event.target.value); paintLibrary(); });
    document.querySelector('#skills-library-sort')?.addEventListener('change', (event) => { sortKey = String(event.target.value); paintLibrary(); });

    document.querySelector('#skills-search-run')?.addEventListener('click', () => {
      const input = document.querySelector('#skills-search-input');
      const results = document.querySelector('#skills-search-results');
      const query = input ? String(input.value).trim() : '';
      if (query === '') {
        if (results) results.replaceChildren(textNode('p', 'Enter a search term.'));
        return;
      }
      // Every provider the schema allows is asked, so a fan-out that reached only the local registry would
      // be a visible result rather than a silent one.
      void api(`/skills/search?query=${encodeURIComponent(query)}&providers=local,skills-sh,skillx`)
        .then((response) => { if (results) results.replaceChildren(...skillSearchNodes(response.data)); })
        .catch(showError);
    });

    /**
     * Starts an import from whatever the wizard currently holds, so that the submit and the retry are one
     * path rather than two controls that can drift. The job line reports the guidance for the state rather
     * than the bare state token, because a line reading only "failed" leaves an operator with nothing to
     * act on, and the cache-miss case has an exact remedy this page already knows how to state.
     */
    function startSkillImport() {
      const source = document.querySelector('#skill-import-source');
      const refField = document.querySelector('#skill-import-ref');
      const kindField = document.querySelector('#skill-import-scope');
      const review = document.querySelector('#skill-import-review');
      const jobBox = document.querySelector('#skill-import-job');
      const built = buildSkillImportRequest({
        sourceKind: kindField ? kindField.value : 'skills-sh',
        sourceRef: source ? source.value : '',
        ref: refField ? refField.value : ''
      });
      if (!built.ok) {
        if (review) review.textContent = built.message;
        return;
      }
      if (review) review.textContent = 'Import queued.';
      void api('/skill-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.body)
      })
        .then((started) => {
          const jobId = started && started.data ? started.data.id : undefined;
          if (!jobId || !jobBox) return undefined;
          const poller = createImportPollingController({
            fetchJob: async () => (await api(`/skill-imports/${encodeURIComponent(jobId)}`)).data,
            onState: (job) => {
              jobBox.textContent = renderImportJobGuidance(job);
              // The cancel control reads the id from the line the operator is already watching, so the two
              // cannot drift apart.
              jobBox.setAttribute('data-job-id', String(job.id ?? jobId));
            },
            isTerminal: isTerminalImportState
          });
          return poller.start();
        })
        .catch(showError);
    }

    // The retry is the same path as the submit, which is what the wizard's own guidance promises when it
    // tells an operator to import and retry after a cache miss.
    document.querySelector('#skill-import-submit')?.addEventListener('click', () => { startSkillImport(); });
    document.querySelector('#skill-import-retry')?.addEventListener('click', () => { startSkillImport(); });

    document.querySelector('#skill-import-cancel')?.addEventListener('click', () => {
      const jobBox = document.querySelector('#skill-import-job');
      const jobId = jobBox ? jobBox.getAttribute('data-job-id') : null;
      if (!jobId) return;
      void api(`/skill-imports/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedGeneration: 1 })
      }).catch(showError);
    });

    document.querySelector('#skill-set-save')?.addEventListener('click', () => {
      const nameField = document.querySelector('#skill-set-name');
      const status = document.querySelector('#skill-set-status');
      const selectedIds = [...document.querySelectorAll('#skill-set-picker [data-set-member]:checked')]
        .map((box) => box.getAttribute('data-set-member'));
      const built = buildSkillSetBody({ name: nameField ? nameField.value : '', skills: rows, selectedIds });
      if (!built.ok) {
        if (status) status.textContent = built.message;
        return;
      }
      void api('/skill-sets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.body)
      })
        .then(() => { if (status) status.textContent = 'Skill set created.'; })
        .catch((error) => { if (status) status.textContent = error instanceof Error ? error.message : 'The set could not be created.'; });
    });

    // Editing an existing skill and creating a new one share one form, so the form has to know which of the
    // two it is doing: a create posts a new source, an edit adds a revision to the skill open in the drawer.
    let editingSkillId = null;
    const editor = createSkillEditorController({
      slug: document.querySelector('#skill-editor-slug'),
      displayName: document.querySelector('#skill-editor-name'),
      instructions: document.querySelector('#skill-editor-instructions'),
      save: async (body) => {
        if (editingSkillId) {
          return (await api(`/skills/${encodeURIComponent(editingSkillId)}/revisions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instructions: body.instructions, expectedGeneration: body.expectedGeneration })
          })).data;
        }
        return (await api('/skills', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })).data;
      }
    });

    /**
     * One dialog serves both modes, so creating and editing cannot drift in their validation or their
     * mode switch. The slug and display name are fixed while editing because a revision carries the
     * instructions only, and an editable field there would look like a change the save path drops.
     */
    function openSkillEditor(skill) {
      const dialog = document.querySelector('#skill-editor-dialog');
      const title = document.querySelector('#skill-editor-title');
      const description = document.querySelector('#skill-editor-description');
      const slugField = document.querySelector('#skill-editor-slug');
      const nameField = document.querySelector('#skill-editor-name');
      const instructions = document.querySelector('#skill-editor-instructions');
      const status = document.querySelector('#skill-editor-status');
      editingSkillId = skill ? skill.id : null;
      if (title) title.textContent = skill ? `Add a revision to ${skill.slug}` : 'Create a custom skill';
      if (description) {
        description.textContent = skill
          ? 'Saving adds a revision of the instructions. The slug and display name stay as they are.'
          : 'Instructions are stored as the skill\u2019s SKILL.md.';
      }
      if (slugField) { slugField.value = skill ? skill.slug : ''; slugField.disabled = Boolean(skill); }
      if (nameField) { nameField.value = skill ? skill.displayName : ''; nameField.disabled = Boolean(skill); }
      if (instructions) instructions.value = skill && typeof skill.instructions === 'string' ? skill.instructions : '';
      if (status) status.textContent = '';
      if (!dialog || dialog.open) return;
      // The invoker is remembered so closing the dialog puts focus back on what opened it.
      dialog.dataset.invokerId = skill ? 'skill-detail-edit' : 'open-skill-editor';
      dialog.showModal();
      // Editing has one editable field, so focus belongs there rather than on the fixed slug.
      (skill ? instructions : slugField)?.focus?.();
    }

    document.querySelector('#skill-detail-edit')?.addEventListener('click', () => {
      openSkillEditor(rows.find((candidate) => candidate.id === editingSkillId));
    });

    // The drawer had no way out: `openSkillDetail` set `hidden = false` and nothing ever set it back, so
    // the panel stayed open over the library for the rest of the session.
    document.querySelector('#skill-detail-close')?.addEventListener('click', () => {
      const drawer = document.querySelector('#skill-detail');
      if (drawer) drawer.hidden = true;
      editingSkillId = null;
      const title = document.querySelector('#skill-editor-title');
      if (title) title.textContent = 'Create a custom skill';
    });
    document.querySelector('#skill-editor')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const status = document.querySelector('#skill-editor-status');
      const wasEditing = editingSkillId !== null;
      void editor.submit().then(async (result) => {
        // A failure keeps the dialog open with the draft intact, which is why the status line stays for it.
        if (!result.ok) { if (status) status.textContent = result.message; return; }
        // A success closes the dialog, so the outcome is announced where the operator still is rather than
        // on a status line that is about to disappear.
        if (status) status.textContent = '';
        document.querySelector('#skill-editor-dialog')?.close();
        // Version drift is advisory: the runner reports it alongside a successful save rather than
        // refusing one, so it is announced with the outcome instead of shown as a failure.
        const drift = typeof result.data?.warning === 'string' ? result.data.warning : null;
        const outcome = wasEditing ? 'Revision added.' : 'Skill created.';
        announce(drift ? `${outcome} ${drift}` : outcome);
        // The new skill is only visible once the server agrees it exists, so the library reloads from
        // the server rather than assuming the row it just sent.
        await enterSkillsTab('library');
      }).catch(showError);
    });

    const names = ['library', 'discover', 'sets', 'registry'];
    const panels = names.map((name) => ({ name, element: document.querySelector(`#skills-panel-${name}`) }));
    const tabs = names.map((name) => ({ name, element: document.querySelector(`#skills-tab-${name}`) }));
    const tabController = createSkillsTabsController({
      tabs,
      panels,
      onEnter: (name) => { void enterSkillsTab(name); }
    });
    for (const tab of tabs) tab.element?.addEventListener('click', () => tabController.select(tab.name));

    // One control serves both empty states, so it reads its intent from the state the last paint set
    // rather than from a listener bound to one of them.
    document.querySelector('#skills-library-empty-action')?.addEventListener('click', () => {
      const action = document.querySelector('#skills-library-empty-action')?.getAttribute('data-skills-action');
      if (action === 'discover') { tabController.select('discover'); return; }
      // `search('')` cancels a pending debounced keystroke. Without it a timer already scheduled with the
      // old query would fire after this reset and put the filter back.
      library.search('');
      query = ''; providerFilter = ''; stateFilter = ''; tagFilter = ''; sortKey = 'name';
      for (const [selector, value] of [
        ['#skills-library-search', ''], ['#skills-library-provider', ''], ['#skills-library-state', ''],
        ['#skills-library-tag', ''], ['#skills-library-sort', 'name']
      ]) {
        const field = document.querySelector(selector);
        if (field) field.value = value;
      }
      paintLibrary();
    });

    tabController.select('library');
  }
  async function loadOverview() {
    selectNavigation('overview');
    document.querySelector('#command-surface').hidden = true;
    insertRendered(content, renderOverviewSkeleton());
    // One bounded projection replaces the previous client-side fan-out; identity and the
    // server panel stay separate because they are not decision metrics.
    const [overviewResult, profile, server, metrics, reliability] = await Promise.allSettled([
      api('/overview'), api('/profile'), api('/server'), api('/metrics?window=24h'), api('/reliability')
    ]);
    const data = (result) => result.status === 'fulfilled' ? result.value.data : undefined;
    const identity = data(profile)?.identity ?? {};
    const readinessUrl = data(profile)?.readiness?.publicUrl;
    insertRendered(content, renderOverview({
      overview: data(overviewResult) ?? {},
      access: {
        name: identity.name ?? 'Not provided',
        email: identity.email ?? 'Not provided',
        sessionExpiresAt: data(profile)?.sessionExpiresAt,
        endpoint: typeof readinessUrl === 'string' && /^https:\/\//.test(readinessUrl) ? readinessUrl : undefined
      },
      server: data(server),
      metrics: data(metrics) ?? {},
      reliability: data(reliability) ?? {}
    }));
    await refreshApprovalsBadge();
  }
  async function loadIndex() {
    selectNavigation('workspaces'); document.querySelector('#command-surface').hidden = false;
    const parameters = new URLSearchParams(location.search); const query = { q: parameters.get('q') ?? '', status: parameters.get('status') ?? '', expiring: parameters.get('expiring') ?? '' };
    document.querySelector('#search').value = query.q; document.querySelector('#status').value = query.status;
    const result = await api('/workspaces'); insertRendered(content, renderWorkspaceIndex(result.data.workspaces, query));
    detail.hidden = true; document.querySelector('.app-shell').classList.remove('has-detail');
    document.querySelector('#clear-filters')?.addEventListener('click', () => { navigateTo('/dashboard'); });
    bindWorkspaceDrawerLinks(); document.querySelector('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
  async function submitForm(form, pendingLabel, action, onSuccess) {
    const button = form.querySelector('button[type="submit"]'); const status = form.querySelector('.form-status'); const original = button.textContent;
    form.setAttribute('aria-busy', 'true'); button.disabled = true; button.textContent = pendingLabel; if (status) { status.textContent = pendingLabel; status.dataset.saveState = 'saving'; }
    try { await action(); if (status) { status.textContent = ''; status.dataset.saveState = 'saved'; } await onSuccess(); flashUpdated(); }
    catch (error) { if (status) delete status.dataset.saveState; showError(error); }
    finally { form.removeAttribute('aria-busy'); button.disabled = false; button.textContent = original; }
  }
  /**
   * The mutation cue: the region a mutation re-rendered crossfades once, so the operator
   * sees which part of the page moved. Guarded for the test double, which has no classList.
   */
  function flashUpdated(region = content) {
    if (!region?.classList) return;
    region.classList.remove('content-just-updated');
    void region.offsetWidth;
    region.classList.add('content-just-updated');
    globalThis.setTimeout(() => region.classList.remove('content-just-updated'), 900);
  }
  async function loadProjects() {
    selectNavigation('projects'); document.querySelector('#command-surface').hidden = true;
    setPageActions(renderPrimaryAction({ id: 'open-create-project', label: 'Create project', dialogId: 'create-project-dialog' }));
    const result = await api('/projects'); insertRendered(content, renderProjectIndex(result.data.projects));
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
    setTitle(project.name, 'Retained environments and write-only secret references.'); insertRendered(content, renderProjectDetail(project, environments));
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
    document.querySelector('#delete-project').addEventListener('click', (event) => confirmAction({ title: 'Delete project?', description: 'Delete this project and its retained environment metadata?', target: project.name, label: 'Delete project', pendingLabel: 'Deleting…', action: async () => { await api(`/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: project.generation }) }); navigateTo('/dashboard/projects'); } }, event.currentTarget));
  }
  async function loadGlobalSecrets() {
    selectNavigation('secrets');
    document.querySelector('#command-surface').hidden = true;
    setPageActions(renderPrimaryAction({ id: 'open-create-global-secret', label: 'Add global secret', dialogId: 'create-global-secret-dialog' }));
    const result = await api('/secrets');
    const secrets = result.data?.secrets ?? [];
    const readiness = result.data?.readiness;
    insertRendered(content, renderGlobalSecrets(secrets, readiness));
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
    document.querySelector('#command-surface').hidden = true;
    setPageActions(renderModelsActions());

    const [profilesRes, credsRes, statusRes] = await Promise.all([
      listModelProfiles().catch(() => ({ data: { profiles: [] } })),
      listModelCredentials().catch(() => ({ data: { credentials: [] } })),
      getModelConfigStatus().catch(() => ({ data: { status: null } }))
    ]);

    const profiles = profilesRes.data?.profiles ?? [];
    const credentials = credsRes.data?.credentials ?? [];
    const status = statusRes.data?.status ?? null;

    insertRendered(content, renderModelsPage(profiles, credentials, status));
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

      insertRendered(credentialSelect, credentials.length
        ? credentials.map((c) => `<option value="${escape(c.id)}">${escape(c.label)} (${escape(c.provider)})</option>`).join('')
        : '<option value="">No credentials available (create one first)</option>');

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
        let profile;
        try {
          profile = JSON.parse(event.currentTarget.dataset.profileJson);
        } catch {
          // A malformed dataset value must not take the whole page down with it.
          announce('This profile could not be opened. Reload the page and try again.');
          return;
        }
        profileForm.reset();
        document.querySelector('#model-profile-edit-mode').value = 'true';
        document.querySelector('#model-profile-generation').value = String(profile.generation);
        document.querySelector('#model-profile-id').value = profile.id;
        document.querySelector('#model-profile-id').disabled = true;
        document.querySelector('#model-profile-display-name').value = profile.displayName;
        document.querySelector('#model-profile-title').textContent = `Edit profile (${profile.displayName})`;

        insertRendered(credentialSelect, credentials.map((c) => `<option value="${escape(c.id)}" ${c.id === profile.credentialId ? 'selected' : ''}>${escape(c.label)} (${escape(c.provider)})</option>`).join(''));

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
    selectNavigation('artifacts'); document.querySelector('#command-surface').hidden = true;
    setPageActions(renderPrimaryAction({ id: 'open-create-snapshot', label: 'Create snapshot', dialogId: 'snapshot-dialog' }));
    const parameters = new URLSearchParams(location.search); const cursor = parameters.get('cursor');
    const result = await api(`/artifacts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); insertRendered(content, renderArtifactIndex(result.data.artifacts, result.cursor));
    const form = document.querySelector('#snapshot-form'); form.addEventListener('submit', (event) => {
      event.preventDefault(); const values = new FormData(form); const retention = String(values.get('retentionSeconds') ?? '').trim();
      const body = { workspaceId: values.get('workspaceId'), path: values.get('path'), logicalName: values.get('logicalName'), ...(retention ? { retentionSeconds: Number(retention) } : {}), expectedGeneration: 0 };
      void submitForm(form, 'Creating snapshot…', async () => api('/artifacts', { method: 'POST', body: requestBody(body) }), async () => { announce('Retained artifact snapshot created.'); navigateTo('/dashboard/artifacts'); });
    });
    for (const button of document.querySelectorAll('.delete-artifact')) button.addEventListener('click', (event) => confirmAction({ title: 'Delete retained artifact?', description: 'Delete this bounded snapshot before its retention expiry?', target: button.dataset.artifactId, label: 'Delete artifact', pendingLabel: 'Deleting…', action: async () => { await api(`/artifacts/${encodeURIComponent(button.dataset.artifactId)}`, { method: 'DELETE', body: requestBody({ expectedGeneration: Number(button.dataset.generation) }) }); await loadArtifacts(); announce('Artifact deleted.'); } }, event.currentTarget));
    document.querySelector('#load-more-artifacts')?.addEventListener('click', (event) => { navigateTo(`/dashboard/artifacts?cursor=${encodeURIComponent(event.currentTarget.dataset.cursor)}`); });
  }
  async function loadAudit() {
    selectNavigation('audit'); document.querySelector('#command-surface').hidden = true;
    const parameters = new URLSearchParams(location.search); const cursor = parameters.get('cursor');
    const result = await api(`/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); insertRendered(content, renderAuditIndex(result.data.events, result.cursor));
    document.querySelector('#load-more-audit')?.addEventListener('click', (event) => { navigateTo(`/dashboard/audit?cursor=${encodeURIComponent(event.currentTarget.dataset.cursor)}`); });
  }
  async function loadApiKeys() {
    selectNavigation('api-keys');
    document.querySelector('#command-surface').hidden = true;
    const result = await api('/api-keys'); apiKeyPageData = result.data; insertRendered(content, renderApiKeyIndex(apiKeyPageData)); bindApiKeyControls();
    // The key limit and gateway readiness decide whether creating another key is
    // even possible; the action states that instead of failing on submit.
    const activeKeys = (Array.isArray(apiKeyPageData?.keys) ? apiKeyPageData.keys : []).filter((key) => key?.state === 'ACTIVE').length;
    const blocked = apiKeyPageData?.readiness?.ready === false || activeKeys >= 10;
    setPageActions(renderPrimaryAction({ id: 'open-create-api-key', label: 'Create API key', dialogId: 'create-api-key-dialog', disabled: blocked }));
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
        insertRendered(content, renderApiKeyIndex(apiKeyPageData)); bindApiKeyControls();
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
    selectNavigation('integrations'); integrationLinks('github'); document.querySelector('#command-surface').hidden = true;
    const callback = githubCallbackParameters(location.search);
    if (callback) {
      insertRendered(content, renderGitHub({ configured: true, installation: null, repositories: [] }, true));
      try {
        await api('/github/complete', { method: 'POST', body: requestBody(callback) });
        announce('GitHub App connection completed.');
      } catch (error) {
        showError(error);
      } finally {
        history.replaceState({}, '', '/dashboard/github');
      }
    }
    const result = await api('/github'); insertRendered(content, renderGitHub(result.data));
    setPageActions(renderGitHubActions(result.data));
    bindGitHubControls();
  }
  function bindGitHubControls() {
    const form = document.querySelector('#github-setup-form');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault(); const values = new FormData(form); const expectedAccountId = String(values.get('expectedAccountId') ?? '').trim();
        void submitForm(form, 'Preparing connection…', async () => {
          const result = await api('/github/setup', { method: 'POST', body: requestBody(expectedAccountId ? { expectedAccountId } : {}) });
          let destination;
          try {
            destination = new URL(result.data.url);
          } catch {
            throw new Error('GitHub setup URL was invalid.');
          }
          if (destination.protocol !== 'https:') throw new Error('GitHub setup URL was invalid.');
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
    selectNavigation('profile'); document.querySelector('#command-surface').hidden = true;
    const result = await api('/profile'); insertRendered(content, renderProfile(result.data)); bindProfileControls();
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
  let settingsPageData;
  let settingsReadiness;
  async function loadSettings() {
    selectNavigation('settings');
    document.querySelector('#command-surface').hidden = true;
    insertRendered(content, '<div class="skeleton tile" aria-hidden="true"></div>');
    const { data } = await api('/settings');
    settingsPageData = data;
    settingsReadiness = undefined;
    renderSettingsView();
  }
  function renderSettingsView() {
    insertRendered(content, renderSettings(settingsPageData, settingsReadiness));
    bindSettingsControls();
  }
  function settingsStatus(message) {
    const status = document.querySelector('#settings-status');
    if (status) status.textContent = message;
  }
  async function settingsAction(button, pendingLabel, action) {
    const original = button.textContent;
    button.disabled = true; button.textContent = pendingLabel;
    settingsStatus(pendingLabel);
    try { await action(); }
    catch (error) { settingsStatus(''); showError(error); }
    finally { button.disabled = false; button.textContent = original; }
  }
  function bindSettingsControls() {
    document.querySelector('#save-settings-network-profile').addEventListener('click', (event) => {
      const selected = document.querySelector('#settings-network-profile').value;
      void settingsAction(event.currentTarget, 'Saving…', async () => {
        const { data } = await api('/settings', { method: 'POST', body: requestBody({ defaultNetworkProfile: selected === '' ? null : selected }) });
        settingsPageData = data;
        renderSettingsView();
        settingsStatus(selected === '' ? 'Runner default restored.' : 'Default network profile saved.');
      });
    });
    document.querySelector('#reset-settings-network-profile').addEventListener('click', (event) => {
      void settingsAction(event.currentTarget, 'Resetting…', async () => {
        const { data } = await api('/settings', { method: 'POST', body: requestBody({ defaultNetworkProfile: null }) });
        settingsPageData = data;
        renderSettingsView();
        settingsStatus('Runner default restored.');
      });
    });
    document.querySelector('#check-settings-network').addEventListener('click', (event) => {
      void settingsAction(event.currentTarget, 'Checking…', async () => {
        const { data } = await api('/settings/network-check', { method: 'POST', body: requestBody({}) });
        settingsReadiness = data;
        renderSettingsView();
        settingsStatus(data.ready === true ? 'Egress readiness confirmed.' : `Egress is not ready: ${data.reason ?? 'the readiness probe reported no reason'}`);
      });
    });
  }
  let currentKnowledgeItem;
  async function loadKnowledge(activeTab = 'all') {
    selectNavigation('knowledge');
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

    insertRendered(content, renderKnowledgeIndex(data, { q: query, kind, scope, projectId }, activeTab));
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
          insertRendered(graphMount, renderKnowledgeGraph(graphRes.data));
          bindKnowledgeGraphControls();
        } catch (err) {
          insertRendered(graphMount, `<p class="form-status status-error">Graph error: ${escape(err.message)}</p>`);
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
            insertRendered(projectSelect, projects.length
              ? projects.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')
              : '<option value="">No projects available (create one first)</option>');
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
          navigateTo(`/dashboard/knowledge/${encodeURIComponent(res.data.id)}`);
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
    insertRendered(content, renderKnowledgeDetail(item));
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
        if (preview) insertRendered(preview, renderMarkdown(conflictData.currentContent ?? ''));
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
        if (preview && textarea) insertRendered(preview, renderMarkdown(textarea.value));
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
          navigateTo('/dashboard/knowledge');
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
        if (id) navigateTo(`/dashboard/knowledge/${encodeURIComponent(id)}`);
      });
      nodeGroup.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const id = event.currentTarget.dataset.nodeId;
          if (id) navigateTo(`/dashboard/knowledge/${encodeURIComponent(id)}`);
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
    selectNavigation('integrations'); integrationLinks('mcp-servers');
    document.querySelector('#command-surface').hidden = true;
    setBusy(true);
    try {
      const [serversResult, gatewayResult] = await Promise.all([listMcpServers(), getMcpGatewayEndpoint()]);
      currentMcpServers = Array.isArray(serversResult.data?.servers) ? serversResult.data.servers : [];
      currentMcpGateway = gatewayResult.data;
      insertRendered(content, renderMcpServersIndex({ servers: currentMcpServers, gateway: currentMcpGateway }));
      setPageActions(renderMcpActions());
      bindMcpServersControls();
    } finally { setBusy(false); }
  }
  async function loadMcpServerDetail(serverId, tab = 'overview') {
    selectNavigation('integrations'); integrationLinks('mcp-servers');
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
      insertRendered(content, renderMcpServerDetail(currentMcpServer, currentMcpTools, currentMcpTraces, tab, currentMcpLogCursor, currentMcpGateway));
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
        navigateTo('/dashboard/integrations/mcp-servers');
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
      insertRendered(content, renderMcpServerDetail(currentMcpServer, currentMcpTools, currentMcpTraces, 'logs', result.cursor, currentMcpGateway));
      bindMcpServersControls();
    });
  }
  async function workspace(id) { return (await api(`/workspaces/${encodeURIComponent(id)}`)).data; }
  /**
   * The Workspace Cockpit. The header carries what an operator decides on, the tab
   * row carries the workspace context, and the Summary reports only observable
   * state — the agent, task and Git reasons join with the phases that expose them.
   */
  async function loadWorkspace(id, tab = 'summary', io) {
    selectNavigation('workspaces');
    document.querySelector('#command-surface').hidden = true; detail.hidden = true;
    const item = await workspace(id);
    // A missing context response must not hide the cockpit: the header and the
    // lifecycle actions still work from the workspace record alone.
    const contextResult = await api(`/workspaces/${encodeURIComponent(id)}/context`).catch(() => undefined);
    setTitle(repositoryName(item.repositoryUrl), 'Workspace cockpit: summary, agents, runtime, files, git, automation, deploy, artifacts, and activity.');
    const body = await cockpitTabBody(id, tab, item, contextResult?.data, io);
    // A tab body may need to bind controls once it is in the document, so the Files tab
    // returns its markup plus that hook instead of reaching into the DOM early.
    const markup = typeof body === 'string' ? body : body.markup;
    insertRendered(content, `${renderWorkspaceCockpitHeader(item)}${renderWorkspaceTabs(id, tab)}${markup}${renderFinalizeDialog()}`);
    bindCockpitActions(item);
    if (typeof body !== 'string' && body.afterRender) body.afterRender();
    if (tab === 'runtime') bindRuntimeControls(id);
    if (tab === 'git') bindGitControls(id);
    if (tab === 'automation') bindAutomationControls(id);
    if (tab === 'deploy') bindDeployControls(id);
  }
  /** Which body a cockpit tab renders, kept out of the loader so the switch stays readable. */
  async function cockpitTabBody(workspaceId, tab, workspace, context, io) {
    if (tab === 'summary') return renderWorkspaceSummary({ workspace, context });
    if (tab === 'agents') return renderWorkspaceAgents(workspaceId);
    if (tab === 'runtime') return runtimePanel(workspaceId, io);
    if (tab === 'files') return filesPanel(workspaceId);
    // The diff toggle is a URL parameter, so a staged/unstaged view is shareable and
    // the back button behaves.
    if (tab === 'git') return gitPanel(workspaceId, new URLSearchParams(location.search).get('staged') === 'true');
    if (tab === 'automation') return automationPanel(workspaceId);
    if (tab === 'deploy') return deployPanel(workspaceId);
    if (tab === 'artifacts') return artifactsPanel(workspaceId);
    if (tab === 'activity') return activityPanel(workspaceId);
    return renderWorkspaceSummary({ workspace, context });
  }
  /** The Files tab inside the cockpit: the same adapters the standalone page used, now
   * rendered under the cockpit header and tab row instead of a two-link context nav. */
  async function filesPanel(workspaceId) {
    const parameters = new URLSearchParams(location.search);
    const path = parameters.get('path') ?? '.';
    if (parameters.get('file') === '1') {
      const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`);
      return { markup: renderFile(workspaceId, result.data), afterRender: () => bindFileEditor(workspaceId, result.data) };
    }
    const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`);
    return { markup: renderFileList(workspaceId, result.data), afterRender: () => bindFileOperations(workspaceId) };
  }
  /** The workspace's retained snapshots, scoped by each record's own workspaceId. */
  async function artifactsPanel(workspaceId) {
    const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/artifacts`).catch(() => undefined);
    return renderWorkspaceArtifacts({ artifacts: result?.data?.artifacts ?? [] });
  }
  /** The workspace's own activity rows, over the event grammar the Activity Center uses. */
  async function activityPanel(workspaceId) {
    const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/activity`).catch(() => undefined);
    return renderWorkspaceActivity({ events: result?.data?.events ?? [], workspaceId });
  }
  /** The workspace skill set and its lifecycle hooks. */
  async function automationPanel(workspaceId) {
    const scoped = encodeURIComponent(workspaceId);
    const [skillsResult, hooksResult] = await Promise.all([
      api(`/workspaces/${scoped}/skills`).catch(() => undefined),
      api(`/workspaces/${scoped}/hooks`).catch(() => undefined)
    ]);
    return renderAutomationPanel({ skills: skillsResult?.data?.skills ?? [], hooks: hooksResult?.data?.hooks ?? [] });
  }
  /** Deployment targets defined by the repository. */
  async function deployPanel(workspaceId) {
    const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/deployments`).catch(() => undefined);
    return renderDeployPanel(result?.data?.deployments ?? []);
  }
  /** Hook runs and skill scripts go through the runner's guarded contracts. */
  function bindAutomationControls(workspaceId) {
    const scoped = encodeURIComponent(workspaceId);
    const hookForm = document.querySelector('#hook-run-form');
    hookForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(hookForm);
      void submitForm(hookForm, 'Running…', async () => {
        await api(`/workspaces/${scoped}/hooks/run`, { method: 'POST', body: requestBody({ event: values.get('event') }) });
      }, async () => { announce('Hooks finished.'); navigateTo(`/dashboard/workspaces/${scoped}/automation`); });
    });
    const skillForm = document.querySelector('#skill-run-form');
    skillForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(skillForm);
      const name = String(values.get('name') ?? '');
      void submitForm(skillForm, 'Running…', async () => {
        await api(`/workspaces/${scoped}/skills/${encodeURIComponent(name)}/run`, { method: 'POST', body: requestBody({ script: values.get('script') }) });
      }, async () => { announce('Skill script finished.'); navigateTo(`/dashboard/workspaces/${scoped}/automation`); });
    });
  }
  /** Deployments are external-effect operations, so each run confirms first. */
  function bindDeployControls(workspaceId) {
    const scoped = encodeURIComponent(workspaceId);
    for (const button of document.querySelectorAll('.run-deployment')) button.addEventListener('click', (event) => {
      const name = button.dataset.deploymentName ?? '';
      void confirmAction({
        title: 'Run this deployment target?',
        description: 'Deployment commands have external effects and run outside the harness sandbox.',
        target: name, label: 'Run deployment', pendingLabel: 'Running…',
        action: async () => {
          await api(`/workspaces/${scoped}/deployments/run`, { method: 'POST', body: requestBody({ name }) });
          announce('Deployment finished.');
          navigateTo(`/dashboard/workspaces/${scoped}/deploy`);
        }
      }, event.currentTarget);
    });
  }
  /** Git status, a bounded diff, recent commits and worktrees in one pass. */
  async function gitPanel(workspaceId, staged = false) {
    const scoped = encodeURIComponent(workspaceId);
    const [statusResult, diffResult, logResult, worktreeResult] = await Promise.all([
      api(`/workspaces/${scoped}/git/status`),
      api(`/workspaces/${scoped}/git/diff?staged=${staged ? 'true' : 'false'}`).catch(() => undefined),
      api(`/workspaces/${scoped}/git/log?limit=20`).catch(() => undefined),
      api(`/workspaces/${scoped}/worktrees`).catch(() => undefined)
    ]);
    return renderGitPanel({
      status: statusResult.data ?? {},
      diff: { staged, ...(diffResult?.data ?? {}) },
      log: logResult?.data?.commits ?? [],
      worktrees: worktreeResult?.data?.worktrees ?? []
    });
  }
  /**
   * Git controls. Finalize is the happy path; everything here is either a read-only
   * toggle or an advanced operation that confirms or reports a conflict in place.
   */
  function bindGitControls(workspaceId) {
    const scoped = encodeURIComponent(workspaceId);
    document.querySelector('.git-diff-toggle')?.addEventListener('click', (event) => {
      const next = event.currentTarget.dataset.staged !== 'true';
      navigateTo(`/dashboard/workspaces/${scoped}/git?staged=${next ? 'true' : 'false'}`);
    });
    for (const button of document.querySelectorAll('.remove-worktree')) button.addEventListener('click', (event) => {
      const name = button.dataset.worktreeName ?? '';
      void confirmAction({
        title: 'Remove this worktree?', description: 'The managed worktree is removed; its branch stays in the repository.',
        target: name, label: 'Remove worktree', pendingLabel: 'Removing…',
        action: async () => {
          await api(`/workspaces/${scoped}/worktrees/${encodeURIComponent(name)}`, { method: 'DELETE', body: requestBody({}) });
          announce('Worktree removed.');
          navigateTo(`/dashboard/workspaces/${scoped}/git`);
        }
      }, event.currentTarget);
    });
    const createForm = document.querySelector('#create-worktree-form');
    createForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(createForm);
      void submitForm(createForm, 'Creating…', async () => {
        await api(`/workspaces/${scoped}/worktrees`, { method: 'POST', body: requestBody({ name: values.get('name'), ref: values.get('ref') }) });
      }, async () => { announce('Worktree created.'); navigateTo(`/dashboard/workspaces/${scoped}/git`); });
    });
    const advanced = document.querySelector('#git-advanced-form');
    advanced?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(advanced);
      const action = String(values.get('action') ?? 'fetch');
      const argument = String(values.get('argument') ?? '').trim();
      const body = action === 'fetch' ? { remote: 'origin' }
        : action === 'pull' ? { remote: 'origin', strategy: 'ff-only' }
          : action === 'checkout' ? { ref: argument }
            : action === 'branch' ? { action: 'create', name: argument }
              : action === 'merge' ? { ref: argument }
                : { action: 'start', upstream: argument };
      void submitForm(advanced, 'Running…', async () => {
        await api(`/workspaces/${scoped}/git/${action}`, { method: 'POST', body: requestBody(body) });
      }, async () => { announce(`Git ${action} completed.`); navigateTo(`/dashboard/workspaces/${scoped}/git`); });
    });
  }
  /** The workspace Agents tab reuses the global renderer with a scoped list. */
  async function renderWorkspaceAgents(workspaceId) {
    const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/agents`);
    return renderAgentsIndex({ agents: result.data?.agents ?? [], filters: { workspaceId } });
  }
  /** Renew, recover, finalize, and close, each with pending state and live feedback. */
  function bindCockpitActions(item) {
    const id = item.workspaceId;
    document.querySelector('#renew-workspace-lease')?.addEventListener('click', (event) => void cockpitAction(event.currentTarget, 'Renewing…', () => api(`/workspaces/${encodeURIComponent(id)}/lease-renew`, { method: 'POST', body: requestBody({}) }), 'Workspace lease renewed.'));
    document.querySelector('#recover-workspace')?.addEventListener('click', (event) => void cockpitAction(event.currentTarget, 'Recovering…', () => api(`/workspaces/${encodeURIComponent(id)}/recover`, { method: 'POST', body: requestBody({ mode: 'resume' }) }), 'Workspace recovery requested.'));
    const form = document.querySelector('#finalize-workspace-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(form);
      void submitForm(form, 'Finalizing…', async () => {
        await api(`/workspaces/${encodeURIComponent(id)}/finalize`, {
          method: 'POST',
          body: requestBody({ all: true, push: values.get('push') === 'on', commitMessage: values.get('commitMessage') })
        });
      }, async () => {
        document.querySelector('#finalize-workspace-dialog')?.close();
        announce('Workspace finalized.');
        await loadWorkspace(id, 'summary');
      });
    });
    bindClose(item);
  }
  async function cockpitAction(button, pendingLabel, action, successMessage) {
    const original = button.textContent;
    button.disabled = true; button.textContent = pendingLabel;
    try {
      await action();
      announce(successMessage);
      const id = location.pathname.match(/^\/dashboard\/workspaces\/(ws_[A-Za-z0-9_-]{20,80})/)?.[1];
      if (id) await loadWorkspace(id, 'summary');
    } catch (error) { showError(error); }
    finally { button.disabled = false; button.textContent = original; }
  }
  /**
   * The Activity Center reads one server-composed projection: the timeline is merged
   * and labelled by the API, so the browser does not fan out or re-derive categories.
   */
  async function loadActivity() {
    selectNavigation('activity');
    document.querySelector('#command-surface').hidden = true;
    const filter = new URLSearchParams(location.search).get('filter') ?? 'all';
    const result = await api('/activity').catch(() => undefined);
    const events = Array.isArray(result?.data?.events) ? result.data.events : [];
    insertRendered(content, renderActivityCenter({ events, filter }));
    await refreshApprovalsBadge();
  }
  /** The approvals inbox: pending privilege grants and the two decisions. */
  async function loadApprovals() {
    selectNavigation('approvals');
    document.querySelector('#command-surface').hidden = true;
    const result = await api('/privilege-grants');
    const grants = Array.isArray(result?.data?.grants) ? result.data.grants : [];
    insertRendered(content, renderApprovals({ grants }));
    updateApprovalsBadge(grants.length);
    for (const button of document.querySelectorAll('.approve-grant, .reject-grant')) button.addEventListener('click', (event) => {
      const approving = button.classList.contains('approve-grant');
      const grantId = button.dataset.grantId ?? '';
      void confirmAction({
        title: approving ? 'Approve this privilege request?' : 'Reject this privilege request?',
        description: approving ? 'The command may then run in that workspace under your identity. The decision is audited.' : 'The request is discarded and the command stays blocked. The decision is audited.',
        target: grantId, label: approving ? 'Approve' : 'Reject', pendingLabel: approving ? 'Approving…' : 'Rejecting…',
        action: async () => {
          await api(`/privilege-grants/${encodeURIComponent(grantId)}/${approving ? 'approve' : 'reject'}`, { method: 'POST', body: requestBody({}) });
          announce(approving ? 'Privilege request approved.' : 'Privilege request rejected.');
          await loadApprovals();
        }
      }, event.currentTarget);
    });
  }
  /** The badge appears only while something is pending. */
  function updateApprovalsBadge(count) {
    const badge = document.querySelector('#nav-badge-approvals');
    if (!badge) return;
    badge.textContent = count > 0 ? String(count) : '';
    badge.hidden = count === 0;
  }
  async function refreshApprovalsBadge() {
    const result = await api('/privilege-grants').catch(() => undefined);
    const grants = Array.isArray(result?.data?.grants) ? result.data.grants : [];
    updateApprovalsBadge(grants.filter((grant) => !['approved', 'rejected'].includes(String(grant.status ?? ''))).length);
  }
  /**
   * Global Agents page and the workspace-scoped tab share one renderer and one
   * adapter; the workspace id decides the scope, and filters are URL-backed so a
   * filtered view is shareable.
   */
  async function loadAgents(workspaceId) {
    selectNavigation('agents');
    document.querySelector('#command-surface').hidden = true;
    const parameters = new URLSearchParams(location.search);
    const status = parameters.get('status') ?? '';
    const scope = workspaceId ?? parameters.get('workspaceId') ?? '';
    const profileId = parameters.get('profileId') ?? '';
    const parentAgentId = parameters.get('parentAgentId') ?? '';
    const attention = parameters.get('attention') ?? '';
    const query = new URLSearchParams({
      ...(status ? { status } : {}), ...(scope ? { workspaceId: scope } : {}),
      ...(profileId ? { profileId } : {}), ...(parentAgentId ? { parentAgentId } : {}),
      ...(attention ? { attention } : {})
    });
    const result = await api(`/agents${query.size ? `?${query}` : ''}`);
    insertRendered(content, renderAgentsIndex({ agents: result.data?.agents ?? [], filters: { status, workspaceId: scope, profileId, parentAgentId, attention } }));
    document.querySelector('#agent-filters')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const next = new URLSearchParams();
      for (const [key, value] of new FormData(event.currentTarget)) if (String(value).trim()) next.set(key, String(value).trim());
      navigateTo(`/dashboard/agents${next.size ? `?${next}` : ''}`);
    });
  }
  /** One agent: overview, usage, bounded logs, and the message/cancel controls. */
  async function loadAgentDetail(agentId) {
    selectNavigation('agents');
    document.querySelector('#command-surface').hidden = true;
    const workspaceScope = new URLSearchParams(location.search).get('workspaceId');
    const query = workspaceScope ? `?workspaceId=${encodeURIComponent(workspaceScope)}` : '';
    const [statusResult, logsResult] = await Promise.all([
      api(`/agents/${encodeURIComponent(agentId)}${query}`),
      api(`/agents/${encodeURIComponent(agentId)}/logs${query}`).catch(() => undefined)
    ]);
    const agent = statusResult.data;
    setTitle('Agent detail', 'One coding agent: status, usage, bounded logs, and control.');
    insertRendered(content, renderAgentDetail({ agent, logs: logsResult?.data?.events ?? [] }));
    bindAgentControls(agent, agentId);
  }
  function bindAgentControls(agent, agentId) {
    const form = document.querySelector('#agent-message-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(form);
      // The contract requires an idempotency key, so a retry cannot double-deliver.
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      void submitForm(form, 'Sending…', async () => {
        await api(`/agents/${encodeURIComponent(agentId)}/messages`, {
          method: 'POST',
          body: requestBody({ workspaceId: agent.workspaceId, message: values.get('message'), mode: values.get('mode'), idempotencyKey })
        });
      }, async () => { announce('Message sent to the agent.'); await loadAgentDetail(agentId); });
    });
    document.querySelector('#cancel-agent')?.addEventListener('click', (event) => confirmAction({
      title: 'Cancel this agent and its children?',
      description: 'Cancellation cascades to every agent this one spawned and cannot be undone.',
      target: agentId, label: 'Cancel agent', pendingLabel: 'Cancelling…',
      action: async () => {
        await api(`/agents/${encodeURIComponent(agentId)}/cancel`, { method: 'POST', body: requestBody({ workspaceId: agent.workspaceId }) });
        announce('Agent cancelled.');
        await loadAgentDetail(agentId);
      }
    }, event.currentTarget));
  }
  async function loadFiles(id) {
    // Files is a cockpit tab, so it delegates rather than rendering a standalone page.
    await loadWorkspace(id, 'files');
  }
  /** Tasks, the dependency graph and sessions: one bounded read each. */
  async function runtimePanel(workspaceId, io) {
    const [runtimeResult, graphResult] = await Promise.all([
      api(`/workspaces/${encodeURIComponent(workspaceId)}/runtime`),
      api(`/workspaces/${encodeURIComponent(workspaceId)}/tasks/graph`).catch(() => undefined)
    ]);
    return renderRuntimePanel({
      tasks: runtimeResult.data?.tasks ?? [],
      sessions: runtimeResult.data?.sessions ?? [],
      graph: graphResult?.data ?? {},
      io
    });
  }
  /**
   * Runtime controls. Cancel and close confirm first; reading a session is a bounded,
   * read-only call that never sends input, so the dashboard stays a viewer here.
   */
  function bindRuntimeControls(workspaceId) {
    for (const button of document.querySelectorAll('.cancel-task')) button.addEventListener('click', (event) => {
      const scoped = button.dataset.taskId ?? '';
      void confirmAction({
        title: 'Cancel this task?', description: 'The command stops and anything depending on it stays blocked.',
        target: scoped, label: 'Cancel task', pendingLabel: 'Cancelling…',
        action: async () => {
          await api(`/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(scoped)}/cancel`, { method: 'POST', body: requestBody({}) });
          announce('Task cancelled.');
          await loadRuntime(workspaceId);
        }
      }, event.currentTarget);
    });
    for (const button of document.querySelectorAll('.read-session')) button.addEventListener('click', async () => {
      const scoped = button.dataset.sessionId ?? '';
      const result = await api(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(scoped)}/io`).catch(() => undefined);
      await loadRuntime(workspaceId, result?.data);
    });
    for (const button of document.querySelectorAll('.close-session')) button.addEventListener('click', (event) => {
      const scoped = button.dataset.sessionId ?? '';
      void confirmAction({
        title: 'Close this session?', description: 'The session ends and its retained output stays readable.',
        target: scoped, label: 'Close session', pendingLabel: 'Closing…',
        action: async () => {
          await api(`/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(scoped)}/close`, { method: 'POST', body: requestBody({}) });
          announce('Session closed.');
          await loadRuntime(workspaceId);
        }
      }, event.currentTarget);
    });
    const form = document.querySelector('#open-session-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      void submitForm(form, 'Opening…', async () => {
        await api(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
          method: 'POST',
          body: requestBody({ name: values.get('name'), cwd: String(values.get('cwd') ?? '.'), idempotencyKey })
        });
      }, async () => { announce('Session opened.'); await loadRuntime(workspaceId); });
    });
  }
  async function loadRuntime(id, io) {
    // Runtime is a cockpit tab too, so it delegates rather than dropping the cockpit.
    await loadWorkspace(id, 'runtime', io);
  }
  // Secondary navigation for the single Integrations page: GitHub and MCP Servers
  // are tabs of one destination instead of two top-level subsystems.
  function integrationLinks(current) {
    insertRendered(document.querySelector('#context-nav'), `<a href="/dashboard/integrations/github" ${current === 'github' ? 'aria-current="page"' : ''}>GitHub</a><a href="/dashboard/integrations/mcp-servers" ${current === 'mcp-servers' ? 'aria-current="page"' : ''}>MCP Servers</a>`);
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
    document.querySelector('#delete-file').addEventListener('click', (event) => confirmAction({ title: 'Delete file?', description: `Delete ${file.path} from this workspace?`, target: file.path, label: 'Delete file', pendingLabel: 'Deleting…', action: async () => { await api(`/workspaces/${encodeURIComponent(id)}/files/content`, { method: 'DELETE', body: requestBody({ path: file.path, recursive: false, expectedSha256: file.sha256 }) }); navigateTo(`/dashboard/workspaces/${encodeURIComponent(id)}/files?path=.`); } }, event.currentTarget));
  }
  function bindFileOperations(id) {
    document.querySelector('#folder-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/workspaces/${encodeURIComponent(id)}/files/directory`, { method: 'POST', body: requestBody({ path: form.get('path'), recursive: true }) }); announce('Folder created.'); await loadFiles(id); } catch (error) { showError(error); } });
    document.querySelector('#move-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/workspaces/${encodeURIComponent(id)}/files/move`, { method: 'POST', body: requestBody({ source: form.get('source'), destination: form.get('destination'), overwrite: false }) }); announce('Path moved.'); await loadFiles(id); } catch (error) { showError(error); } });
  }
  function bindClose(item) {
    document.querySelector('#close-workspace')?.addEventListener('click', (event) => confirmAction({ title: 'Close workspace?', description: 'This stops the executor and removes the workspace checkout. This cannot be undone.', target: `${repositoryName(item.repositoryUrl)} ${item.workspaceId}`, label: 'Close workspace', pendingLabel: 'Closing…', action: async () => { await api(`/workspaces/${encodeURIComponent(item.workspaceId)}/close`, { method: 'POST', body: requestBody({ expectedGeneration: item.version }) }); navigateTo('/dashboard'); } }, event.currentTarget));
  }
  function confirmAction(options, invoker) {
    document.querySelector('#confirm-title').textContent = options.title; document.querySelector('#confirm-description').textContent = options.description; document.querySelector('#confirm-target').textContent = options.target; confirm.open(options, invoker);
  }
  document.querySelector('#workspace-filter').addEventListener('submit', (event) => { event.preventDefault(); navigateTo(`/dashboard?${new URLSearchParams(new FormData(event.currentTarget))}`); });
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
    insertRendered(paletteResults, renderPaletteResults(entries, paletteActive));
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
      if (href) { event.preventDefault(); navigateTo(href); }
      return;
    } else return;
    event.preventDefault();
    renderPalette(paletteInput.value);
  });
  // Keep focus in the input: mousedown must not move it into the listbox.
  paletteResults.addEventListener('mousedown', (event) => { if (event.target.closest?.('[role="option"]')) event.preventDefault(); });
  paletteResults.addEventListener('click', (event) => {
    const href = event.target.closest?.('[role="option"]')?.dataset.href;
    if (href) navigateTo(href);
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
  /**
   * The launch dialog shows what the preview would resolve, so a conflict is visible before launch
   * rather than discovered when the resolver refuses. The sets load once: reopening the dialog is not
   * a reason to re-request what has not changed.
   */
  function wireOpenWorkspaceSkillSets() {
    const dialog = document.querySelector('#open-workspace-dialog');
    const openButton = document.querySelector('#open-workspace-btn');
    const select = document.querySelector('#open-skill-sets-select');
    const chips = document.querySelector('#open-skill-sets-chips');
    const conflictBox = document.querySelector('#open-skill-conflicts');
    const previewBox = document.querySelector('#open-workspace-preview');
    const submit = document.querySelector('#submit-open-workspace');
    if (!dialog || !openButton || !select) return;

    const controller = createLaunchSkillSetController({
      submit,
      loadSets: async () => (await api('/skill-sets')).data.sets ?? [],
      preview: async (skillSets, skillOverrides) => (await api('/skill-sets/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillSets, skillOverrides })
      })).data
    });

    function paint(result) {
      const chosen = controller.chosen();
      if (chips) insertRendered(chips, renderSkillSetChips(controller.sets().filter((set) => chosen.includes(set.id)).map((set) => set.name)));
      if (conflictBox) insertRendered(conflictBox, renderSkillConflicts(controller.conflictList(), controller.overrides()));
      if (previewBox) previewBox.textContent = `${(result.resolved ?? []).length} skill(s) resolved.`;
    }

    openButton.addEventListener('click', () => {
      dialog.showModal();
      void controller.load()
        .then(() => { insertRendered(select, renderSkillSetOptions(controller.sets())); })
        .catch(showError);
    });

    select.addEventListener('change', () => {
      controller.choose([...select.selectedOptions].map((option) => option.value));
      void controller.refresh().then(paint).catch(showError);
    });

    // A conflict radio is the operator's override, and it is what releases the launch button.
    conflictBox?.addEventListener('change', (event) => {
      const name = event.target?.closest?.('fieldset')?.dataset?.conflictName;
      if (!name || !event.target?.value) return;
      void controller.resolve(name, event.target.value).then(paint).catch(showError);
    });
  }

  addEventListener('popstate', () => location.reload());
  wireOpenWorkspaceSkillSets();
  void load();
}

if (typeof document !== 'undefined') initializeDashboard();
