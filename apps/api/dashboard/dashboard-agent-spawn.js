import { AGENT_BOUNDED_RUN_NOTE, escapeHtml as escape } from './dashboard-render.js';
import { PERMISSION_PRESETS, PROXY_OPERATIONS, MUTATING_PROXY_OPERATIONS, dollarsFromMicros, microsFromDollars, normalizeOperations, permissionPresetFor, profileVerification, verificationLabel } from './dashboard-models.js';

/**
 * Run Pi agent: one bounded subagent run started from the Dashboard.
 *
 * The pure helpers own every rule the form shows before a spawn (which workspaces and
 * profiles can run an agent, the permission presets a profile allows, the budget
 * ceilings, the cost preview), so the controller below only moves values between the
 * form and one state object. The runner still decides: it re-resolves the profile's
 * active revision, re-checks the workspace posture and every ceiling, and reserves the
 * cost cap against spend policies, so nothing here can widen what a run may do.
 */

/** `agent_spawn` bounds, mirrored from the tool schema so the form refuses what the runner would. */
export const AGENT_PROMPT_MAX_BYTES = 131_072;
export const AGENT_TTL_SECONDS = Object.freeze({ min: 30, max: 86_400, initial: 900 });
export const AGENT_OUTPUT_BYTES = Object.freeze({ min: 1_024, max: 10_485_760, initial: 262_144 });

/** What a Dashboard run is and is not; shown in the form and on every agent detail page. */
export const BOUNDED_RUN_NOTE = AGENT_BOUNDED_RUN_NOTE;

const integerIn = (text, min, max) => {
  const value = String(text ?? '').trim();
  if (!/^\d{1,10}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
};

/** Whether a workspace can host an agent, and the reason in words when it cannot. */
export function workspaceEligibility(workspace, now = Date.now()) {
  if (!workspace || workspace.status !== 'ACTIVE') return { eligible: false, reason: 'Not active' };
  const expiresAt = Date.parse(workspace.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= now) return { eligible: false, reason: 'Lease expired' };
  if (workspace.networkProfile !== 'network-none') {
    return { eligible: false, reason: 'Network access is on; agents run only in a network-none workspace' };
  }
  return { eligible: true, reason: '' };
}

/**
 * Whether a profile can start a run now. Only an ACTIVE profile with an active revision
 * is spawnable; an unverified or failed connection check and an out-of-sync gateway are
 * warnings the owner sees, because the runner reconciles the gateway before the lease.
 */
export function profileReadiness(profile, gatewayStatus = null) {
  if (!profile) return { spawnable: false, label: 'Choose a profile', reason: 'Choose an active model profile.', warnings: [] };
  if (profile.status === 'DISABLED') return { spawnable: false, label: 'Disabled', reason: 'This profile is disabled. Activate it in Models & Budgets first.', warnings: [] };
  if (profile.status === 'SYNC_PENDING' || profile.status === 'SYNC_FAILED') {
    return { spawnable: false, label: profile.status === 'SYNC_FAILED' ? 'Sync failed' : 'Sync pending', reason: 'The model gateway has not applied this profile yet. Check the gateway status in Models & Budgets.', warnings: [] };
  }
  if (profile.status !== 'ACTIVE' || !profile.activeRevision) {
    return { spawnable: false, label: 'No active revision', reason: 'This profile has no active revision. Save and activate it first.', warnings: [] };
  }
  const warnings = [];
  const check = profileVerification(profile);
  if (check.outcome === 'failed') warnings.push('The last connection check for this revision failed; the run may fail at its first model call.');
  else if (check.outcome === 'limited') warnings.push('The last connection check for this revision was limited; some capabilities (such as tool calls) were not confirmed.');
  else if (check.outcome !== 'verified') warnings.push('This revision has not been verified; test it in Models & Budgets to confirm the key, model, and endpoint.');
  if (gatewayStatus && gatewayStatus.gatewaySynced === false) {
    warnings.push('The model gateway is not in sync. The spawn reconciles it first and fails without spending if it cannot.');
  }
  return { spawnable: true, label: verificationLabel(check.outcome), reason: '', warnings };
}

/** The permission presets a profile allows: a preset is offered only when the profile's ceiling covers it. */
export function presetsFor(profile) {
  const ceiling = new Set(profile?.activeRevision?.maxProxyOperations ?? []);
  const presets = Object.entries(PERMISSION_PRESETS).map(([id, preset]) => {
    const missing = preset.operations.filter((operation) => !ceiling.has(operation));
    return { id, label: preset.label, description: preset.description, operations: [...preset.operations], allowed: missing.length === 0, missing };
  });
  return [...presets, { id: 'custom', label: 'Custom', description: 'Choose operations one by one, within this profile’s ceiling.', operations: [], allowed: true, missing: [] }];
}

/** The form state a profile starts from: its own ceilings, the narrowest allowed preset, and no prompt. */
export function initialSpawnState({ workspaceId = '', profile = null, prompt = '' } = {}) {
  const limits = profile?.activeRevision?.limits;
  const ceiling = normalizeOperations(profile?.activeRevision?.maxProxyOperations ?? []);
  const preset = presetsFor(profile).find((entry) => entry.id !== 'custom' && entry.allowed);
  return {
    workspaceId,
    profileId: profile?.id ?? '',
    prompt,
    operations: preset ? normalizeOperations(preset.operations) : ceiling.filter((operation) => !MUTATING_PROXY_OPERATIONS.includes(operation)).slice(0, 1),
    ttlSeconds: String(AGENT_TTL_SECONDS.initial),
    maxOutputBytes: String(AGENT_OUTPUT_BYTES.initial),
    maxInputTokens: limits ? String(limits.maxInputTokens) : '',
    maxOutputTokens: limits ? String(limits.maxOutputTokens) : '',
    maxCost: limits ? dollarsFromMicros(limits.maxCostMicros) : ''
  };
}

const ceilingMicros = (tokens, microsPerMillion) => (Number.isSafeInteger(microsPerMillion) ? Math.ceil((tokens * microsPerMillion) / 1_000_000) : null);

/**
 * The most a run can cost. The cost cap is the hard limit the gateway enforces; the
 * token worst case uses the revision's base prices, so it is an estimate (long-prompt
 * tiers and cache writes can price higher, and the cap still holds).
 */
export function costPreview(profile, budget) {
  const pricing = profile?.activeRevision?.pricing ?? {};
  const input = ceilingMicros(budget.maxInputTokens ?? 0, pricing.inputMicrosPerMillionTokens);
  const output = ceilingMicros(budget.maxOutputTokens ?? 0, pricing.outputMicrosPerMillionTokens);
  const tokenWorstMicros = input === null || output === null ? null : input + output;
  const capMicros = budget.maxCostMicros ?? null;
  const effectiveMicros = capMicros === null ? tokenWorstMicros : tokenWorstMicros === null ? capMicros : Math.min(capMicros, tokenWorstMicros);
  return { capMicros, tokenWorstMicros, effectiveMicros, tiered: Array.isArray(pricing.tiers) && pricing.tiers.length > 0 };
}

/**
 * Checks the form against the profile it targets and builds the `agent_spawn` input
 * (without the workspace id, which is the route, and the idempotency key, which the
 * controller owns). Every refusal names its field so the form can mark it.
 */
export function validateSpawn(state, profile, workspace, gatewayStatus = null, now = Date.now()) {
  const errors = {};
  const place = workspaceEligibility(workspace, now);
  if (!state.workspaceId) errors.workspaceId = 'Choose a workspace.';
  else if (!place.eligible) errors.workspaceId = `This workspace cannot run agents: ${place.reason.toLowerCase()}.`;
  const readiness = profileReadiness(profile, gatewayStatus);
  if (!readiness.spawnable) errors.profileId = readiness.reason;
  const prompt = String(state.prompt ?? '');
  const promptBytes = new globalThis.TextEncoder().encode(prompt).length;
  if (!prompt.trim()) errors.prompt = 'Describe the task for the agent.';
  else if (promptBytes > AGENT_PROMPT_MAX_BYTES) errors.prompt = `The task is ${promptBytes} bytes; the limit is ${AGENT_PROMPT_MAX_BYTES}.`;
  const operations = normalizeOperations(state.operations);
  const ceiling = new Set(profile?.activeRevision?.maxProxyOperations ?? []);
  if (!operations.length) errors.operations = 'Allow at least one proxy operation.';
  else if (operations.some((operation) => !ceiling.has(operation))) errors.operations = 'An operation is outside this profile’s ceiling.';
  const limits = profile?.activeRevision?.limits;
  const ttlSeconds = integerIn(state.ttlSeconds, AGENT_TTL_SECONDS.min, AGENT_TTL_SECONDS.max);
  if (ttlSeconds === null) errors.ttlSeconds = `Enter whole seconds from ${AGENT_TTL_SECONDS.min} to ${AGENT_TTL_SECONDS.max}.`;
  const maxOutputBytes = integerIn(state.maxOutputBytes, AGENT_OUTPUT_BYTES.min, AGENT_OUTPUT_BYTES.max);
  if (maxOutputBytes === null) errors.maxOutputBytes = `Enter bytes from ${AGENT_OUTPUT_BYTES.min} to ${AGENT_OUTPUT_BYTES.max}.`;
  const maxInputTokens = integerIn(state.maxInputTokens, 1, limits?.maxInputTokens ?? 0);
  if (maxInputTokens === null) errors.maxInputTokens = `Enter 1 to ${limits?.maxInputTokens ?? 0} (this profile’s ceiling).`;
  const maxOutputTokens = integerIn(state.maxOutputTokens, 1, limits?.maxOutputTokens ?? 0);
  if (maxOutputTokens === null) errors.maxOutputTokens = `Enter 1 to ${limits?.maxOutputTokens ?? 0} (this profile’s ceiling).`;
  const maxCostMicros = microsFromDollars(state.maxCost);
  if (maxCostMicros === null || maxCostMicros > (limits?.maxCostMicros ?? 0)) {
    errors.maxCost = `Enter a dollar amount up to $${dollarsFromMicros(limits?.maxCostMicros ?? 0) || '0'} (this profile’s ceiling).`;
  }
  if (Object.keys(errors).length) return { ok: false, errors, warnings: readiness.warnings };
  return {
    ok: true,
    errors,
    warnings: readiness.warnings,
    input: { prompt, profileId: profile.id, proxyOperations: operations, ttlSeconds, maxOutputBytes, maxInputTokens, maxOutputTokens, maxCostMicros }
  };
}

/**
 * One idempotency key per distinct request: a resend of the same input replays the
 * first spawn instead of starting a second run, and an edited input gets a new key so
 * the runner does not refuse it as a reused key.
 */
export function createSpawnKeyring(newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  let fingerprint = null;
  let key = null;
  return {
    keyFor(workspaceId, input) {
      const next = JSON.stringify([workspaceId, input]);
      if (next !== fingerprint) { fingerprint = next; key = `dashboard-${newKey()}`; }
      return key;
    },
    reset() { fingerprint = null; key = null; }
  };
}

const fieldError = (errors, field) => (errors?.[field] ? `<p class="field-error" id="agent-spawn-${field}-error">${escape(errors[field])}</p>` : '');
const invalid = (errors, field) => (errors?.[field] ? ` aria-invalid="true" aria-describedby="agent-spawn-${field}-error"` : '');
const formatMoney = (micros) => (micros === null || micros === undefined ? 'Unknown' : `$${dollarsFromMicros(micros) || '0.00'}`);

function workspaceLabel(workspace) {
  const repository = String(workspace.repositoryUrl ?? '').replace(/^https:\/\//, '');
  return `${repository || workspace.workspaceId}${workspace.ref ? ` @ ${workspace.ref}` : ''}`;
}

/** The workspace picker: every workspace is listed, and an ineligible one says why it is disabled. */
export function renderWorkspaceField(workspaces, state, errors, now = Date.now()) {
  const options = workspaces.map((workspace) => {
    const place = workspaceEligibility(workspace, now);
    const label = `${workspaceLabel(workspace)}${place.eligible ? '' : ` — ${place.reason}`}`;
    return `<option value="${escape(workspace.workspaceId)}"${place.eligible ? '' : ' disabled'}${workspace.workspaceId === state.workspaceId ? ' selected' : ''}>${escape(label)}</option>`;
  }).join('');
  const none = workspaces.some((workspace) => workspaceEligibility(workspace, now).eligible)
    ? ''
    : '<p class="page-note">No open workspace can run agents. Open a workspace with network access off (network-none), then come back.</p>';
  return `<label for="agent-spawn-workspace">Workspace</label><select id="agent-spawn-workspace" name="workspaceId" required${invalid(errors, 'workspaceId')}><option value="">Choose a workspace</option>${options}</select>${fieldError(errors, 'workspaceId')}${none}`;
}

/** The searchable profile picker: ACTIVE profiles first; the rest stay visible but disabled with their state. */
export function renderProfileOptions(profiles, state, query = '', gatewayStatus = null) {
  const term = String(query).trim().toLowerCase();
  const matches = profiles.filter((profile) => !term || `${profile.id} ${profile.displayName ?? ''} ${profile.activeRevision?.model ?? ''}`.toLowerCase().includes(term));
  const ranked = [...matches].sort((left, right) => Number(profileReadiness(right, gatewayStatus).spawnable) - Number(profileReadiness(left, gatewayStatus).spawnable));
  const options = ranked.map((profile) => {
    const readiness = profileReadiness(profile, gatewayStatus);
    const model = profile.activeRevision?.model ? ` · ${profile.activeRevision.model}` : '';
    return `<option value="${escape(profile.id)}"${readiness.spawnable ? '' : ' disabled'}${profile.id === state.profileId ? ' selected' : ''}>${escape(`${profile.displayName ?? profile.id}${model} — ${readiness.label}`)}</option>`;
  }).join('');
  return `<option value="">${ranked.length ? 'Choose a model profile' : 'No profile matches'}</option>${options}`;
}

/** The model, API mode, pinned revision and readiness of the chosen profile, stated before the spawn. */
export function renderProfileSummary(profile, gatewayStatus = null) {
  if (!profile) return '<p class="page-note">Choose a profile to see its model, revision and ceilings.</p>';
  const readiness = profileReadiness(profile, gatewayStatus);
  const revision = profile.activeRevision;
  const facts = revision
    ? `<dl class="facts"><dt>Model</dt><dd class="mono">${escape(revision.model)}</dd><dt>API mode</dt><dd>${escape(revision.apiMode === 'responses' ? 'Responses' : 'Chat Completions')}</dd><dt>Pinned revision</dt><dd class="mono wrap">${escape(revision.id)}</dd><dt>Connection check</dt><dd>${escape(readiness.label)}</dd><dt>Prices (base tier)</dt><dd>${escape(formatMoney(revision.pricing?.inputMicrosPerMillionTokens))} in / ${escape(formatMoney(revision.pricing?.outputMicrosPerMillionTokens))} out per 1M tokens</dd><dt>Profile ceilings</dt><dd>${escape(String(revision.limits?.maxInputTokens ?? '—'))} input · ${escape(String(revision.limits?.maxOutputTokens ?? '—'))} output tokens · ${escape(formatMoney(revision.limits?.maxCostMicros))}</dd></dl>`
    : '';
  const warnings = readiness.warnings.map((warning) => `<li>${escape(warning)}</li>`).join('');
  const blocked = readiness.spawnable ? '' : `<p class="field-error" role="status">${escape(readiness.reason)}</p>`;
  return `${facts}${blocked}${warnings ? `<ul class="warning" role="status">${warnings}</ul>` : ''}`;
}

/** Presets and the per-operation grid, both limited to what the profile allows. */
export function renderPermissionField(profile, state, errors) {
  const ceiling = new Set(profile?.activeRevision?.maxProxyOperations ?? []);
  const current = permissionPresetFor(state.operations);
  const presets = presetsFor(profile).map((preset) => {
    const note = preset.allowed ? preset.description : `Not allowed by this profile (missing ${preset.missing.join(', ')}).`;
    return `<label class="wizard-choice wizard-choice-compact"><input type="radio" name="agentPermissionPreset" value="${escape(preset.id)}"${current === preset.id ? ' checked' : ''}${preset.allowed ? '' : ' disabled'}><span class="wizard-choice-title">${escape(preset.label)}</span><span class="wizard-choice-note">${escape(note)}</span></label>`;
  }).join('');
  const chosen = new Set(state.operations);
  const boxes = PROXY_OPERATIONS.map((operation) => {
    const allowed = ceiling.has(operation);
    const mutating = MUTATING_PROXY_OPERATIONS.includes(operation);
    return `<label><input type="checkbox" name="agentOperation" value="${escape(operation)}"${chosen.has(operation) && allowed ? ' checked' : ''}${allowed ? '' : ' disabled'}><span class="mono">${escape(operation)}</span>${mutating ? ' <small>changes files</small>' : ''}${allowed ? '' : ' <small>not in profile</small>'}</label>`;
  }).join('');
  return `<fieldset class="wizard-permissions"${invalid(errors, 'operations')}><legend>What the agent may do in the workspace</legend><div class="wizard-choices wizard-choices-compact">${presets}</div><div class="tools-checkbox-grid">${boxes}</div>${fieldError(errors, 'operations')}</fieldset>`;
}

/** Budget fields, prefilled from the profile and bounded by its ceilings. */
export function renderBudgetField(profile, state, errors) {
  const limits = profile?.activeRevision?.limits ?? {};
  const field = (name, label, value, hint, attributes) => `<label for="agent-spawn-${name}">${escape(label)}</label><input id="agent-spawn-${name}" name="${name}" value="${escape(value)}" inputmode="numeric"${attributes}${invalid(errors, name)}><small>${escape(hint)}</small>${fieldError(errors, name)}`;
  return `<fieldset class="agent-spawn-budget"><legend>Limits for this run</legend>${
    field('ttlSeconds', 'Time limit (seconds)', state.ttlSeconds, `${AGENT_TTL_SECONDS.min}–${AGENT_TTL_SECONDS.max}; never past the workspace lease.`, ' required')
  }${field('maxInputTokens', 'Input tokens', state.maxInputTokens, `Up to ${limits.maxInputTokens ?? '—'}.`, ' required')
  }${field('maxOutputTokens', 'Output tokens', state.maxOutputTokens, `Up to ${limits.maxOutputTokens ?? '—'}.`, ' required')
  }${field('maxCost', 'Cost cap (USD)', state.maxCost, `Up to ${formatMoney(limits.maxCostMicros)}; the gateway stops the run at this cap.`, ' required inputmode="decimal"')
  }${field('maxOutputBytes', 'Retained output (bytes)', state.maxOutputBytes, `${AGENT_OUTPUT_BYTES.min}–${AGENT_OUTPUT_BYTES.max}.`, ' required')}</fieldset>`;
}

/** The review the owner reads before spawning: isolation, permissions and the cost ceiling. */
export function renderSpawnPreview(profile, state) {
  if (!profile?.activeRevision) return '';
  const operations = normalizeOperations(state.operations);
  const mutating = operations.filter((operation) => MUTATING_PROXY_OPERATIONS.includes(operation));
  const budget = {
    maxInputTokens: Number(state.maxInputTokens) || 0,
    maxOutputTokens: Number(state.maxOutputTokens) || 0,
    maxCostMicros: microsFromDollars(state.maxCost)
  };
  const cost = costPreview(profile, budget);
  const worst = cost.tokenWorstMicros === null
    ? 'Token prices are unknown, so only the cost cap bounds this run.'
    : `At base-tier prices the token limits allow at most ${formatMoney(cost.tokenWorstMicros)}${cost.tiered ? '; long-prompt tiers can price higher' : ''}.`;
  return `<section class="panel" aria-labelledby="agent-spawn-preview-heading"><h3 id="agent-spawn-preview-heading">Before you spawn</h3><ul>`
    + '<li><strong>Isolation:</strong> the agent runs in its own container with no network except the model gateway, as your identity, inside this workspace only. Provider keys stay in the gateway and never reach the agent.</li>'
    + `<li><strong>Permissions:</strong> ${operations.length ? escape(operations.join(', ')) : 'none chosen'}${mutating.length ? ` — <strong>can change files</strong> (${escape(mutating.join(', '))})` : ' — read only'}.</li>`
    + `<li><strong>Cost:</strong> hard cap ${escape(formatMoney(cost.capMicros))}, reserved against your spend policies when the run starts. ${escape(worst)} Spend shown later is an estimate from reported usage, not a provider bill.</li>`
    + `<li><strong>Lifecycle:</strong> ${escape(BOUNDED_RUN_NOTE)}</li>`
    + '</ul></section>';
}

/** The whole form body for the current state. */
export function renderSpawnForm({ workspaces = [], profiles = [], gatewayStatus = null, state, errors = {}, query = '', lockedWorkspace = false, now = Date.now() }) {
  const profile = profiles.find((entry) => entry.id === state.profileId) ?? null;
  const workspaceField = lockedWorkspace
    ? `<input type="hidden" name="workspaceId" value="${escape(state.workspaceId)}"><p class="page-note">Workspace: <span class="mono">${escape(state.workspaceId)}</span></p>${fieldError(errors, 'workspaceId')}`
    : renderWorkspaceField(workspaces, state, errors, now);
  const profileField = `<label for="agent-spawn-profile-search">Find a model profile</label><input id="agent-spawn-profile-search" type="search" autocomplete="off" value="${escape(query)}" placeholder="Name, profile ID or model" aria-controls="agent-spawn-profile">`
    + `<label for="agent-spawn-profile">Model profile</label><select id="agent-spawn-profile" name="profileId" required${invalid(errors, 'profileId')}>${renderProfileOptions(profiles, state, query, gatewayStatus)}</select>${fieldError(errors, 'profileId')}`
    + `<div id="agent-spawn-profile-summary">${renderProfileSummary(profile, gatewayStatus)}</div>`;
  const prompt = `<label for="agent-spawn-prompt">Task</label><textarea id="agent-spawn-prompt" name="prompt" rows="5" required${invalid(errors, 'prompt')} placeholder="What should the agent do in this workspace?">${escape(state.prompt)}</textarea>${fieldError(errors, 'prompt')}`;
  const rest = profile?.activeRevision
    ? `${renderPermissionField(profile, state, errors)}${renderBudgetField(profile, state, errors)}<div id="agent-spawn-preview">${renderSpawnPreview(profile, state)}</div>`
    : '';
  return `${workspaceField}${profileField}${prompt}${rest}`;
}

/**
 * The dialog controller. It loads nothing itself: the caller passes the workspaces,
 * profiles and gateway status it read, so one failed enrichment never blocks the form.
 */
export function createAgentSpawnDialog({ dialog, insert, api, announce, onSpawned }) {
  const form = dialog.querySelector('#agent-spawn-form');
  const body = dialog.querySelector('#agent-spawn-body');
  const status = dialog.querySelector('#agent-spawn-status');
  const submit = dialog.querySelector('#submit-agent-spawn');
  const keyring = createSpawnKeyring();
  let context = { workspaces: [], profiles: [], gatewayStatus: null, lockedWorkspace: false };
  let state = initialSpawnState();
  let errors = {};
  let query = '';
  let busy = false;
  let invoker;

  const profile = () => context.profiles.find((entry) => entry.id === state.profileId) ?? null;
  const workspace = () => context.workspaces.find((entry) => entry.workspaceId === state.workspaceId) ?? (context.lockedWorkspace ? { workspaceId: state.workspaceId, status: context.lockedStatus, networkProfile: context.lockedNetwork, expiresAt: context.lockedExpiresAt } : null);
  const setStatus = (message, tone = '') => { status.textContent = message; if (tone) status.dataset.saveState = tone; else delete status.dataset.saveState; };

  function render() {
    insert(body, renderSpawnForm({ ...context, state, errors, query }));
  }
  function repaintDerived() {
    const summary = body.querySelector('#agent-spawn-profile-summary');
    if (summary) insert(summary, renderProfileSummary(profile(), context.gatewayStatus));
    const preview = body.querySelector('#agent-spawn-preview');
    if (preview) insert(preview, renderSpawnPreview(profile(), state));
  }
  function readField(target) {
    if (target.name === 'agentOperation') {
      state.operations = normalizeOperations([...body.querySelectorAll('input[name="agentOperation"]:checked')].map((box) => box.value));
      const preset = permissionPresetFor(state.operations);
      for (const radio of body.querySelectorAll('input[name="agentPermissionPreset"]')) radio.checked = radio.value === preset;
      repaintDerived();
      return;
    }
    if (target.name === 'agentPermissionPreset') {
      if (target.value !== 'custom') state.operations = normalizeOperations(PERMISSION_PRESETS[target.value]?.operations ?? []);
      for (const box of body.querySelectorAll('input[name="agentOperation"]')) box.checked = state.operations.includes(box.value);
      repaintDerived();
      return;
    }
    if (target.name === 'profileId') {
      // A different profile has different ceilings, so its limits and preset start over; the task stays.
      state = { ...initialSpawnState({ workspaceId: state.workspaceId, profile: context.profiles.find((entry) => entry.id === target.value) ?? null, prompt: state.prompt }), profileId: target.value };
      errors = {};
      render();
      body.querySelector('#agent-spawn-profile')?.focus();
      return;
    }
    if (target.id === 'agent-spawn-profile-search') {
      query = target.value;
      const select = body.querySelector('#agent-spawn-profile');
      if (select) insert(select, renderProfileOptions(context.profiles, state, query, context.gatewayStatus));
      return;
    }
    if (target.name in state) { state[target.name] = target.value; repaintDerived(); }
  }
  body.addEventListener('input', (event) => { if (event.target?.matches?.('input:not([type="radio"]):not([type="checkbox"]), textarea')) readField(event.target); });
  body.addEventListener('change', (event) => { if (event.target?.matches?.('select, input[type="radio"], input[type="checkbox"]')) readField(event.target); });
  dialog.querySelector('#cancel-agent-spawn')?.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('close', () => { invoker?.focus?.(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const result = validateSpawn(state, profile(), workspace(), context.gatewayStatus);
    errors = result.errors;
    if (!result.ok) {
      render();
      setStatus('Fix the highlighted fields.', 'error');
      body.querySelector('[aria-invalid="true"]')?.focus?.();
      return;
    }
    busy = true; submit.disabled = true; form.setAttribute('aria-busy', 'true'); setStatus('Spawning…', 'saving');
    const idempotencyKey = keyring.keyFor(state.workspaceId, result.input);
    try {
      const response = await api(`/workspaces/${encodeURIComponent(state.workspaceId)}/agents`, { method: 'POST', body: JSON.stringify({ ...result.input, idempotencyKey }) });
      const spawned = response?.data ?? {};
      keyring.reset();
      setStatus('');
      dialog.close();
      announce(spawned.replayed ? 'This run was already started; opening it.' : 'Agent spawned.');
      await onSpawned?.({ agentId: spawned.agentId, workspaceId: state.workspaceId });
    } catch (error) {
      // The key is kept, so resending the same request after a transient failure replays rather than duplicates.
      setStatus(error?.message ? `${error.message}` : 'The agent could not be started.', 'error');
    } finally {
      busy = false; submit.disabled = false; form.removeAttribute('aria-busy');
    }
  });

  return {
    open({ workspaces = [], profiles = [], gatewayStatus = null, workspace: fixed = null, trigger } = {}) {
      invoker = trigger;
      context = {
        workspaces, profiles, gatewayStatus, lockedWorkspace: Boolean(fixed),
        lockedStatus: fixed?.status, lockedNetwork: fixed?.networkProfile, lockedExpiresAt: fixed?.expiresAt
      };
      const firstWorkspace = fixed?.workspaceId ?? workspaces.find((entry) => workspaceEligibility(entry).eligible)?.workspaceId ?? '';
      const firstProfile = profiles.find((entry) => profileReadiness(entry, gatewayStatus).spawnable) ?? null;
      state = initialSpawnState({ workspaceId: firstWorkspace, profile: firstProfile });
      errors = {};
      query = '';
      keyring.reset();
      setStatus('');
      render();
      if (!dialog.open) dialog.showModal();
      body.querySelector('#agent-spawn-prompt')?.focus?.();
    }
  };
}
