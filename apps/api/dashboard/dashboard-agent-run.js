import { agentRunEnded, escapeHtml as escape } from './dashboard-render.js';
import { MUTATING_PROXY_OPERATIONS, PERMISSION_PRESETS, PROXY_OPERATIONS, normalizeOperations, permissionPresetFor } from './dashboard-models.js';

/**
 * Run Pi agent: one bounded `agent_spawn` from the Dashboard.
 *
 * The pure helpers own every rule the dialog shows (eligibility, ceilings, the request it sends),
 * so they are unit-tested without a browser. They only mirror the runner: the runner still
 * rejects a workspace that is not network-disabled, a profile that is not active, and any
 * operation or budget above the profile, whatever the browser sends.
 */

/** The `agent_spawn` schema defaults, so an untouched field asks for what MCP callers get. */
export const SPAWN_DEFAULTS = Object.freeze({
  ttlSeconds: 900, maxOutputBytes: 262_144, maxInputTokens: 200_000, maxOutputTokens: 32_000, maxCostMicros: 10_000_000
});
const TTL_MINUTES = Object.freeze({ min: 1, max: 1_440 });
const PROMPT_MAX_BYTES = 131_072;
const REPOSITORY_CONTEXTS = Object.freeze([
  ['codex', 'AGENTS.md family, REVIEW.md and DESIGN.md (default)'],
  ['claude', 'CLAUDE.md family'],
  ['cursor', 'Cursor rules'],
  ['aider', 'Aider conventions'],
  ['all', 'Every supported guidance file'],
  ['none', 'Task only, no repository guidance']
]);

export { agentRunEnded };

/** Agents run only in an active, network-disabled workspace; the reason is shown beside the choice. */
export function workspaceEligibility(workspace) {
  if (!workspace || workspace.status !== 'ACTIVE') return { eligible: false, reason: 'not active' };
  if (workspace.networkProfile !== 'network-none') return { eligible: false, reason: 'needs the No network profile' };
  return { eligible: true, reason: '' };
}

/** Only an ACTIVE profile with an active revision resolves at spawn time. */
export function profileEligibility(profile) {
  if (!profile) return { eligible: false, reason: 'not found' };
  if (profile.status !== 'ACTIVE') return { eligible: false, reason: String(profile.status ?? 'unknown').toLowerCase().replaceAll('_', ' ') };
  if (!profile.activeRevision) return { eligible: false, reason: 'no active revision' };
  return { eligible: true, reason: '' };
}

/** The profile's ceilings: a run may ask for less, never more. */
export function profileCeilings(profile) {
  const revision = profile?.activeRevision ?? {};
  const limits = revision.limits ?? {};
  return {
    maxInputTokens: Number(limits.maxInputTokens) || 0,
    maxOutputTokens: Number(limits.maxOutputTokens) || 0,
    maxCostMicros: Number.isFinite(Number(limits.maxCostMicros)) ? Number(limits.maxCostMicros) : 0,
    operations: normalizeOperations(revision.maxProxyOperations)
  };
}

/** A preset narrowed to what the profile allows, so choosing it never asks for more. */
export function presetWithin(presetId, allowed) {
  const preset = PERMISSION_PRESETS[presetId];
  if (!preset) return [];
  const ceiling = new Set(allowed);
  return normalizeOperations(preset.operations.filter((operation) => ceiling.has(operation)));
}

/** A fresh draft for a profile: read-only permissions and the schema defaults capped by the profile. */
export function draftForProfile(profile, base = {}) {
  const ceilings = profileCeilings(profile);
  const cap = (value, max) => (max > 0 ? Math.min(value, max) : value);
  return {
    workspaceId: base.workspaceId ?? '',
    profileId: profile?.id ?? '',
    prompt: base.prompt ?? '',
    repositoryContext: base.repositoryContext ?? 'codex',
    operations: presetWithin('read', ceilings.operations),
    ttlMinutes: SPAWN_DEFAULTS.ttlSeconds / 60,
    maxInputTokens: cap(SPAWN_DEFAULTS.maxInputTokens, ceilings.maxInputTokens),
    maxOutputTokens: cap(SPAWN_DEFAULTS.maxOutputTokens, ceilings.maxOutputTokens),
    maxCostUsd: cap(SPAWN_DEFAULTS.maxCostMicros, ceilings.maxCostMicros) / 1_000_000
  };
}

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** Every error the dialog can show before sending, keyed by field. Empty means the request may go. */
export function validateRunDraft(draft, { workspace, profile } = {}) {
  const errors = {};
  if (!workspace) errors.workspaceId = 'Choose a workspace.';
  else if (!workspaceEligibility(workspace).eligible) errors.workspaceId = `This workspace cannot run agents: ${workspaceEligibility(workspace).reason}.`;
  if (!profile) errors.profileId = 'Choose a model profile.';
  else if (!profileEligibility(profile).eligible) errors.profileId = `This profile cannot run agents: ${profileEligibility(profile).reason}.`;
  const promptBytes = new globalThis.TextEncoder().encode(String(draft.prompt ?? '')).length;
  if (!String(draft.prompt ?? '').trim()) errors.prompt = 'Describe the task.';
  else if (promptBytes > PROMPT_MAX_BYTES) errors.prompt = `The task is ${promptBytes} bytes; the limit is ${PROMPT_MAX_BYTES}.`;
  const ceilings = profileCeilings(profile);
  const operations = normalizeOperations(draft.operations);
  if (!operations.length) errors.operations = 'Allow at least one operation.';
  else if (profile && operations.some((operation) => !ceilings.operations.includes(operation))) errors.operations = 'An operation is not allowed by this profile.';
  if (!integerIn(draft.ttlMinutes, TTL_MINUTES.min, TTL_MINUTES.max)) errors.ttlMinutes = `Use ${TTL_MINUTES.min} to ${TTL_MINUTES.max} minutes.`;
  if (!integerIn(draft.maxInputTokens, 1, ceilings.maxInputTokens || 2_000_000)) errors.maxInputTokens = `Use 1 to ${ceilings.maxInputTokens || 2_000_000} tokens.`;
  if (!integerIn(draft.maxOutputTokens, 1, ceilings.maxOutputTokens || 2_000_000)) errors.maxOutputTokens = `Use 1 to ${ceilings.maxOutputTokens || 2_000_000} tokens.`;
  const costMicros = Math.round(Number(draft.maxCostUsd) * 1_000_000);
  if (!Number.isFinite(Number(draft.maxCostUsd)) || costMicros < 0 || costMicros > ceilings.maxCostMicros) errors.maxCostUsd = `Use $0 to $${(ceilings.maxCostMicros / 1_000_000).toFixed(2)}.`;
  return errors;
}

/** The exact `agent_spawn` body the Dashboard sends; the route supplies the workspace. */
export function buildSpawnRequest(draft) {
  return {
    prompt: String(draft.prompt),
    profileId: draft.profileId,
    proxyOperations: normalizeOperations(draft.operations),
    ttlSeconds: draft.ttlMinutes * 60,
    maxOutputBytes: SPAWN_DEFAULTS.maxOutputBytes,
    maxInputTokens: draft.maxInputTokens,
    maxOutputTokens: draft.maxOutputTokens,
    maxCostMicros: Math.round(Number(draft.maxCostUsd) * 1_000_000),
    ...(draft.repositoryContext && draft.repositoryContext !== 'codex' ? { repositoryContext: draft.repositoryContext } : {})
  };
}

/**
 * The most the token caps could cost at the profile's pinned base prices. It is an estimate:
 * the model gateway enforces the cost cap and charges long-prompt tiers and cache prices.
 */
export function tokenCapEstimateMicros(profile, draft) {
  const pricing = profile?.activeRevision?.pricing ?? {};
  const input = Number(pricing.inputMicrosPerMillionTokens);
  const output = Number(pricing.outputMicrosPerMillionTokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return Math.ceil((draft.maxInputTokens * input + draft.maxOutputTokens * output) / 1_000_000);
}

const usd = (micros) => `$${(micros / 1_000_000).toFixed(micros > 0 && micros < 10_000 ? 4 : 2)}`;
const fieldError = (errors, name) => (errors[name] ? `<p class="field-error" id="run-agent-${name}-error" role="alert">${escape(errors[name])}</p>` : '');
const described = (errors, name) => (errors[name] ? ` aria-invalid="true" aria-describedby="run-agent-${name}-error"` : '');

/** The gateway line of the preflight; an unknown status never reads as ready. */
export function gatewayReadiness(status) {
  if (!status) return { ready: false, label: 'Gateway status unavailable. The spawn checks it again.' };
  if (status.gatewaySynced === true) return { ready: true, label: 'Model gateway synced.' };
  return { ready: false, label: `Model gateway not synced${status.error ? `: ${status.error}` : ''}. The spawn retries the sync and fails if it cannot.` };
}

/** The whole dialog body for one draft. Every value is escaped; nothing here reads the DOM. */
export function renderRunAgentForm({ draft, errors = {}, workspaces = [], profiles = [], configStatus = null }) {
  const workspaceOptions = ['<option value="">Choose a workspace</option>', ...workspaces.map((workspace) => {
    const eligibility = workspaceEligibility(workspace);
    const name = String(workspace.repositoryUrl ?? workspace.workspaceId ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    return `<option value="${escape(workspace.workspaceId)}"${draft.workspaceId === workspace.workspaceId ? ' selected' : ''}${eligibility.eligible ? '' : ' disabled'}>${escape(name)} · ${escape(workspace.workspaceId)}${eligibility.eligible ? '' : ` (${escape(eligibility.reason)})`}</option>`;
  })].join('');
  const eligibleWorkspaces = workspaces.filter((workspace) => workspaceEligibility(workspace).eligible).length;
  const workspaceHelp = eligibleWorkspaces
    ? 'Agents run only in a workspace opened with the No network profile.'
    : 'No active workspace uses the No network profile. Open one with Network profile “No network” first.';
  const profileOptions = ['<option value="">Choose a model profile</option>', ...profiles.map((profile) => {
    const eligibility = profileEligibility(profile);
    const model = profile.activeRevision?.model ? ` · ${profile.activeRevision.model}` : '';
    return `<option value="${escape(profile.id)}"${draft.profileId === profile.id ? ' selected' : ''}${eligibility.eligible ? '' : ' disabled'}>${escape(profile.displayName ?? profile.id)}${escape(model)}${eligibility.eligible ? '' : ` (${escape(eligibility.reason)})`}</option>`;
  })].join('');
  const profile = profiles.find((entry) => entry.id === draft.profileId);
  const ceilings = profileCeilings(profile);
  const operations = normalizeOperations(draft.operations);
  const preset = permissionPresetFor(operations);
  const presets = [...Object.entries(PERMISSION_PRESETS), ['custom', { label: 'Custom', description: 'Choose operations one by one, within the profile.' }]]
    .map(([id, entry]) => {
      const unavailable = id !== 'custom' && presetWithin(id, ceilings.operations).length !== normalizeOperations(PERMISSION_PRESETS[id].operations).length;
      return `<label class="wizard-choice wizard-choice-compact"><input type="radio" name="runPermissionPreset" value="${escape(id)}"${preset === id ? ' checked' : ''}${profile && unavailable && id !== 'read' ? ' disabled' : ''}><span class="wizard-choice-title">${escape(entry.label)}</span><span class="wizard-choice-note">${escape(entry.description)}${profile && unavailable ? ' Narrowed to what this profile allows.' : ''}</span></label>`;
    }).join('');
  const boxes = PROXY_OPERATIONS.map((operation) => {
    const allowed = ceilings.operations.includes(operation);
    return `<label class="checkbox-label"><input type="checkbox" name="runOperation" value="${escape(operation)}"${operations.includes(operation) ? ' checked' : ''}${allowed ? '' : ' disabled'}><span class="mono">${escape(operation)}</span>${allowed ? '' : ' <small>not allowed by this profile</small>'}</label>`;
  }).join('');
  const contexts = REPOSITORY_CONTEXTS.map(([value, label]) => `<option value="${value}"${draft.repositoryContext === value ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const costCeiling = ceilings.maxCostMicros / 1_000_000;
  return `<label for="run-agent-workspace">Workspace</label>
<select id="run-agent-workspace" name="workspaceId" required${described(errors, 'workspaceId')}>${workspaceOptions}</select>
<p class="field-help">${escape(workspaceHelp)}</p>${fieldError(errors, 'workspaceId')}
<label for="run-agent-profile">Model profile</label>
<select id="run-agent-profile" name="profileId" required${described(errors, 'profileId')}>${profileOptions}</select>
<p class="field-help">Only active profiles can run. Disabled, unsynced, or failed profiles are listed but cannot be chosen; manage them in <a href="/dashboard/models">Models &amp; Budgets</a>.</p>${fieldError(errors, 'profileId')}
<label for="run-agent-prompt">Task</label>
<textarea id="run-agent-prompt" name="prompt" rows="5" required maxlength="${PROMPT_MAX_BYTES}" spellcheck="true"${described(errors, 'prompt')}>${escape(draft.prompt)}</textarea>${fieldError(errors, 'prompt')}
<fieldset class="wizard-permissions"${errors.operations ? ' aria-invalid="true"' : ''}><legend>Allowed tools</legend><div class="wizard-choices">${presets}</div><div class="tools-checkbox-grid">${boxes}</div>${fieldError(errors, 'operations')}</fieldset>
<details class="row-edit"${['ttlMinutes', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'].some((name) => errors[name]) ? ' open' : ''}><summary>Limits and repository guidance</summary>
<label for="run-agent-ttl">Time limit (minutes)</label>
<input id="run-agent-ttl" name="ttlMinutes" type="number" inputmode="numeric" min="${TTL_MINUTES.min}" max="${TTL_MINUTES.max}" step="1" value="${escape(draft.ttlMinutes)}"${described(errors, 'ttlMinutes')}>
<p class="field-help">The run also ends when its workspace expires.</p>${fieldError(errors, 'ttlMinutes')}
<label for="run-agent-max-cost">Cost cap (USD)</label>
<input id="run-agent-max-cost" name="maxCostUsd" type="number" inputmode="decimal" min="0" max="${escape(costCeiling)}" step="0.01" value="${escape(draft.maxCostUsd)}"${described(errors, 'maxCostUsd')}>
<p class="field-help">At most ${escape(usd(ceilings.maxCostMicros))}, this profile's per-run limit.</p>${fieldError(errors, 'maxCostUsd')}
<label for="run-agent-max-input">Input token cap</label>
<input id="run-agent-max-input" name="maxInputTokens" type="number" inputmode="numeric" min="1" max="${escape(ceilings.maxInputTokens || 2_000_000)}" step="1" value="${escape(draft.maxInputTokens)}"${described(errors, 'maxInputTokens')}>${fieldError(errors, 'maxInputTokens')}
<label for="run-agent-max-output">Output token cap</label>
<input id="run-agent-max-output" name="maxOutputTokens" type="number" inputmode="numeric" min="1" max="${escape(ceilings.maxOutputTokens || 2_000_000)}" step="1" value="${escape(draft.maxOutputTokens)}"${described(errors, 'maxOutputTokens')}>${fieldError(errors, 'maxOutputTokens')}
<label for="run-agent-context">Repository guidance</label>
<select id="run-agent-context" name="repositoryContext">${contexts}</select>
</details>
<div id="run-agent-preview" class="preflight-box" aria-live="polite">${renderRunPreview({ draft, profile, configStatus })}</div>`;
}

/** The security and cost preview: what this exact request will be allowed to do. */
export function renderRunPreview({ draft, profile, configStatus }) {
  if (!profile) return '<p>Choose a workspace and a model profile to see what the run may do.</p>';
  const revision = profile.activeRevision ?? {};
  const operations = normalizeOperations(draft.operations);
  const mutating = operations.filter((operation) => MUTATING_PROXY_OPERATIONS.includes(operation));
  const gateway = gatewayReadiness(configStatus);
  const estimate = tokenCapEstimateMicros(profile, draft);
  const capMicros = Math.round(Number(draft.maxCostUsd) * 1_000_000);
  const estimateText = estimate === null
    ? 'No pinned price to estimate from.'
    : `Token caps at pinned base prices: about ${usd(estimate)}${Number.isFinite(capMicros) && estimate > capMicros ? `, so the ${usd(capMicros)} cost cap ends the run first` : ''}.`;
  return `<dl class="facts">
<dt>Run type</dt><dd>Bounded run: it ends on completion, its time limit, a cap, or cancel. Messages reach it only while it runs; no session survives it.</dd>
<dt>Model</dt><dd><span class="mono wrap">${escape(revision.model ?? 'Not reported')}</span> · ${escape(revision.apiMode ?? 'Not reported')}</dd>
<dt>Pinned revision</dt><dd class="mono wrap">${escape(revision.id ?? profile.activeRevisionId ?? 'Not reported')}</dd>
<dt>Gateway</dt><dd>${gateway.ready ? '' : '<span class="status warning">Check</span> '}${escape(gateway.label)}</dd>
<dt>Isolation</dt><dd>Own container with no network; model calls go only through the model gateway. Provider keys never enter it.</dd>
<dt>Tools</dt><dd>${operations.length ? operations.map((operation) => `<span class="mono">${escape(operation)}</span>`).join(', ') : 'None chosen'}${mutating.length ? ` <strong>Can change files: ${mutating.map((operation) => escape(operation)).join(', ')}.</strong>` : ' Read only.'}</dd>
<dt>Cost cap</dt><dd>${Number.isFinite(capMicros) ? escape(usd(capMicros)) : 'Invalid'} hard limit, enforced by the model gateway. ${escape(estimateText)}</dd>
</dl>`;
}

/** Reads the form into a draft. Number fields that are empty or malformed read as NaN and fail validation. */
export function readRunDraft(form, previous) {
  const text = (id) => String(form.querySelector(`#${id}`)?.value ?? '');
  const number = (id) => (text(id).trim() === '' ? Number.NaN : Number(text(id)));
  return {
    ...previous,
    workspaceId: text('run-agent-workspace'),
    profileId: text('run-agent-profile'),
    prompt: text('run-agent-prompt'),
    repositoryContext: text('run-agent-context') || previous.repositoryContext || 'codex',
    operations: normalizeOperations([...form.querySelectorAll('input[name="runOperation"]')].filter((box) => box.checked).map((box) => String(box.value))),
    ttlMinutes: number('run-agent-ttl'),
    maxInputTokens: number('run-agent-max-input'),
    maxOutputTokens: number('run-agent-max-output'),
    maxCostUsd: number('run-agent-max-cost')
  };
}

/**
 * The dialog controller. One idempotency key belongs to one request body: retrying the same body
 * after a lost response replays the first spawn, and an edited body gets a new key instead of a
 * CONFLICT.
 */
export function createRunAgentDialog({ dialog, insert, api, announce, onSpawned, newKey }) {
  const form = dialog.querySelector('#run-agent-form');
  const body = dialog.querySelector('#run-agent-body');
  const status = dialog.querySelector('#run-agent-status');
  const submit = dialog.querySelector('#submit-run-agent');
  const cancel = dialog.querySelector('#cancel-run-agent');
  let context = { workspaces: [], profiles: [], configStatus: null };
  let draft = draftForProfile(undefined);
  let errors = {};
  let attempt;
  let invoker;
  let busy = false;

  const setStatus = (message, tone = '') => { status.textContent = message; if (tone) status.dataset.saveState = tone; else delete status.dataset.saveState; };
  const lookup = () => ({
    workspace: context.workspaces.find((entry) => entry.workspaceId === draft.workspaceId),
    profile: context.profiles.find((entry) => entry.id === draft.profileId)
  });
  function render(focusId) {
    insert(body, renderRunAgentForm({ draft, errors, ...context }));
    if (focusId) dialog.querySelector(`#${focusId}`)?.focus?.();
  }
  function refreshPreview() {
    insert(dialog.querySelector('#run-agent-preview'), renderRunPreview({ draft, profile: lookup().profile, configStatus: context.configStatus }));
  }

  form.addEventListener('change', (event) => {
    const target = event.target;
    if (target?.name === 'profileId') {
      const profile = context.profiles.find((entry) => entry.id === target.value);
      draft = draftForProfile(profile, { ...readRunDraft(form, draft), profileId: target.value });
      draft.profileId = target.value;
      errors = {};
      render('run-agent-profile');
      return;
    }
    if (target?.name === 'runPermissionPreset' && target.value !== 'custom') {
      draft = { ...readRunDraft(form, draft), operations: presetWithin(target.value, profileCeilings(lookup().profile).operations) };
      render();
      dialog.querySelector(`input[name="runPermissionPreset"][value="${target.value}"]`)?.focus?.();
      return;
    }
    draft = readRunDraft(form, draft);
    if (target?.name === 'runOperation') {
      const preset = permissionPresetFor(draft.operations);
      for (const radio of dialog.querySelectorAll('input[name="runPermissionPreset"]')) radio.checked = radio.value === preset;
    }
    refreshPreview();
  });
  form.addEventListener('input', () => { draft = readRunDraft(form, draft); refreshPreview(); });
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { invoker?.focus?.(); });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    draft = readRunDraft(form, draft);
    const { workspace, profile } = lookup();
    errors = validateRunDraft(draft, { workspace, profile });
    if (Object.keys(errors).length) {
      render();
      setStatus('Fix the highlighted fields.', 'error');
      dialog.querySelector('[aria-invalid="true"]')?.focus?.();
      return;
    }
    const request = buildSpawnRequest(draft);
    const signature = JSON.stringify([draft.workspaceId, request]);
    if (attempt?.signature !== signature) attempt = { signature, key: newKey() };
    busy = true; submit.disabled = true; form.setAttribute('aria-busy', 'true');
    setStatus('Starting the agent…', 'saving');
    void (async () => {
      try {
        const result = await api(`/workspaces/${encodeURIComponent(draft.workspaceId)}/agents`, {
          method: 'POST', body: JSON.stringify({ ...request, idempotencyKey: attempt.key })
        });
        const agentId = result?.data?.agentId;
        setStatus('', 'saved');
        attempt = undefined;
        dialog.close();
        announce(result?.data?.replayed ? 'This run was already started; opening it.' : 'Agent started.');
        if (agentId) await onSpawned({ agentId, workspaceId: draft.workspaceId });
      } catch (error) {
        setStatus(error?.message ?? 'The agent could not start.', 'error');
      } finally {
        busy = false; submit.disabled = false; form.removeAttribute('aria-busy');
      }
    })();
  });

  return {
    /** Loads fresh workspaces, profiles, and gateway status, then opens on the given workspace. */
    async open({ workspaceId, trigger } = {}) {
      invoker = trigger;
      errors = {};
      attempt = undefined;
      setStatus('Loading workspaces and profiles…');
      if (!dialog.open) dialog.showModal();
      try {
        const [workspacesResult, profilesResult, configResult] = await Promise.all([
          api('/workspaces'),
          api('/agent-model-profiles'),
          api('/agent-model-config-status').catch(() => null)
        ]);
        context = {
          workspaces: (workspacesResult?.data?.workspaces ?? []).filter((workspace) => workspace.status === 'ACTIVE'),
          profiles: profilesResult?.data?.profiles ?? [],
          configStatus: configResult?.data?.status ?? null
        };
        const preferred = context.workspaces.find((workspace) => workspace.workspaceId === workspaceId && workspaceEligibility(workspace).eligible)
          ?? context.workspaces.find((workspace) => workspaceEligibility(workspace).eligible);
        const profile = context.profiles.find((entry) => profileEligibility(entry).eligible);
        draft = draftForProfile(profile, { workspaceId: preferred?.workspaceId ?? '' });
        setStatus('');
        render(preferred ? 'run-agent-prompt' : 'run-agent-workspace');
      } catch (error) {
        context = { workspaces: [], profiles: [], configStatus: null };
        draft = draftForProfile(undefined);
        render();
        setStatus(error?.message ?? 'Workspaces and profiles could not be loaded.', 'error');
      }
    }
  };
}
