import { escapeHtml as escape, renderCopyChip } from './dashboard-render.js';

/**
 * Settings > Agent policies (global) and Project > Agent policies.
 *
 * The owner edits a versioned execution policy as a form or as JSON. Every preview on this page
 * comes from the runner: "Check changes" returns the effective policy the runner's merge computes,
 * and "Simulate" runs the same gate evaluator execution uses. Nothing here decides an outcome in the
 * browser. A save that weakens the effective policy is confirmed explicitly, and a project policy
 * that tries to widen the global one is refused with the offending fields listed.
 */

export const POLICY_ACTION_CLASSES = Object.freeze(['read', 'edit', 'test', 'vcs_local', 'publish_branch', 'open_pr', 'network', 'package_install']);
export const POLICY_ACTION_LABELS = Object.freeze({
  read: 'Read', edit: 'Edit files', test: 'Run tests', vcs_local: 'Local git', publish_branch: 'Publish branch',
  open_pr: 'Open pull request', network: 'Network', package_install: 'Install packages'
});
export const POLICY_EFFECTS = Object.freeze(['allow', 'advisor_or_approval', 'require_approval']);
export const POLICY_EFFECT_LABELS = Object.freeze({ allow: 'Allow', advisor_or_approval: 'Advisor or approval', require_approval: 'Require approval' });
export const POLICY_SCOPE_FIELDS = Object.freeze([
  { key: 'repositories', label: 'Repositories', help: '*, owner/* or owner/name, one per line.' },
  { key: 'branchPrefixes', label: 'Branch prefixes', help: 'Branch names agents may publish, such as agent/.' },
  { key: 'pathScopes', label: 'Path scopes', help: 'Workspace-relative files or directories (src/), or *.' },
  { key: 'commands', label: 'Commands', help: 'Command prefixes such as npm test. Empty allows none.' },
  { key: 'packages', label: 'Packages', help: 'ecosystem:name or ecosystem:*. Empty allows none.' },
  { key: 'registries', label: 'Registries', help: 'Registry hostnames. Empty allows none.' },
  { key: 'networkHosts', label: 'Network hosts', help: 'Hostnames or *.domain. Empty allows none.' }
]);
export const POLICY_BUDGET_FIELDS = Object.freeze([
  { key: 'maxCostMicrosPerRun', label: 'Cost per run (micro-dollars)' },
  { key: 'maxInputTokensPerRun', label: 'Input tokens per run' },
  { key: 'maxOutputTokensPerRun', label: 'Output tokens per run' },
  { key: 'maxRunSeconds', label: 'Run time (seconds)' },
  { key: 'maxConcurrentRuns', label: 'Concurrent runs' }
]);
/** The execution-risk advisor (Jev). Absent from a global policy means off with these settings. */
export const POLICY_ADVISOR_DEFAULTS = Object.freeze({ enabled: false, riskThreshold: 0.5, minConfidence: 0.7, fallback: 'require_approval' });
export const POLICY_ADVISOR_FALLBACK_LABELS = Object.freeze({ require_approval: 'Require approval', deny: 'Deny' });
export const POLICY_ADVISOR_REASON_LABELS = Object.freeze({
  disabled: 'not enabled', unconfigured: 'no TypeSafe key', timeout: 'timed out', rate_limited: 'rate limited',
  invalid_answer: 'invalid answer', low_confidence: 'low confidence', redaction_failed: 'redaction failed', unavailable: 'unavailable',
  sensitive_paths: 'CI or dependency files are never sent to Jev'
});
export const POLICY_PLATFORM_EFFECTS = Object.freeze(['credential_access', 'docker_access', 'network_escalation', 'outside_workspace', 'privilege_escalation']);
const DECISION_STATUS = Object.freeze({ ALLOW: 'active', REQUIRE_APPROVAL: 'pending', DENY: 'failed' });
const DECISION_LABELS = Object.freeze({ ALLOW: 'Allow', REQUIRE_APPROVAL: 'Requires approval', DENY: 'Deny' });

const list = (value) => (Array.isArray(value) ? value : []);
const label = (actionClass) => POLICY_ACTION_LABELS[actionClass] ?? actionClass;
const joinOrNone = (values) => (list(values).length ? list(values).map((value) => escape(label(value))).join(', ') : '<span class="policy-muted">None</span>');
const entries = (values) => (list(values).length ? list(values).map((value) => `<code>${escape(value)}</code>`).join(' ') : '<span class="policy-muted">None</span>');

/** Splits a textarea into trimmed, de-duplicated, non-empty lines. */
export function linesToList(text) {
  const seen = new Set();
  const result = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const value = line.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** A decimal field becomes a number; anything else is sent as typed so the runner reports the field. */
function numberField(text) {
  const value = String(text ?? '').trim();
  if (value === '') return undefined;
  return /^\d{1,15}$/u.test(value) ? Number(value) : value;
}
/** A value between 0 and 1 becomes a number; anything else is sent as typed so the runner reports the field. */
function unitField(text) {
  const value = String(text ?? '').trim();
  if (value === '') return undefined;
  return /^(?:0|1|0?\.\d{1,6}|1\.0{1,6})$/u.test(value) ? Number(value) : value;
}
const selected = (values, name) => values.getAll(name).map(String).filter((value) => POLICY_ACTION_CLASSES.includes(value));

/** The global policy document a submitted form describes. `values` is FormData or anything with get/getAll. */
export function globalPolicyFromForm(values) {
  const defaults = {};
  for (const actionClass of POLICY_ACTION_CLASSES) {
    const effect = String(values.get(`effect-${actionClass}`) ?? '');
    const delegable = values.get(`delegable-${actionClass}`) === 'on';
    if (POLICY_EFFECTS.includes(effect)) defaults[actionClass] = { effect, delegable };
    // "No default" means require approval; keeping the delegation turns it into that explicit default.
    else if (delegable) defaults[actionClass] = { effect: 'require_approval', delegable: true };
  }
  const scope = {};
  for (const field of POLICY_SCOPE_FIELDS) scope[field.key] = linesToList(values.get(`scope-${field.key}`));
  const budget = {};
  for (const field of POLICY_BUDGET_FIELDS) budget[field.key] = numberField(values.get(`budget-${field.key}`));
  return {
    version: 1,
    hardDeny: selected(values, 'hardDeny'),
    mandatoryApproval: selected(values, 'mandatoryApproval'),
    allowedActionClasses: selected(values, 'allowedActionClasses'),
    defaults,
    scope,
    budget,
    approval: { ttlSeconds: numberField(values.get('approval-ttlSeconds')), approverRoles: ['owner'] },
    ...globalAdvisorFromForm(values)
  };
}

function globalAdvisorFromForm(values) {
  const fallback = String(values.get('advisor-fallback') ?? '');
  const advisor = {
    enabled: values.get('advisor-enabled') === 'on',
    riskThreshold: unitField(values.get('advisor-riskThreshold')) ?? POLICY_ADVISOR_DEFAULTS.riskThreshold,
    minConfidence: unitField(values.get('advisor-minConfidence')) ?? POLICY_ADVISOR_DEFAULTS.minConfidence,
    fallback: Object.hasOwn(POLICY_ADVISOR_FALLBACK_LABELS, fallback) ? fallback : POLICY_ADVISOR_DEFAULTS.fallback
  };
  // An untouched, disabled advisor is the same as none, so a policy that never used it stays unchanged.
  const untouched = Object.keys(POLICY_ADVISOR_DEFAULTS).every((key) => advisor[key] === POLICY_ADVISOR_DEFAULTS[key]);
  return untouched ? {} : { advisor };
}

/** The project policy document a submitted form describes. Absent fields inherit the global value. */
export function projectPolicyFromForm(values) {
  const document = { version: 1 };
  const hardDeny = selected(values, 'hardDeny');
  const mandatoryApproval = selected(values, 'mandatoryApproval');
  if (hardDeny.length) document.hardDeny = hardDeny;
  if (mandatoryApproval.length) document.mandatoryApproval = mandatoryApproval;
  if (values.get('restrictClasses') === 'on') document.allowedActionClasses = selected(values, 'allowedActionClasses');
  const rules = {};
  for (const actionClass of POLICY_ACTION_CLASSES) {
    const effect = String(values.get(`rule-${actionClass}`) ?? '');
    if (POLICY_EFFECTS.includes(effect)) rules[actionClass] = effect;
  }
  if (Object.keys(rules).length) document.rules = rules;
  const scope = {};
  for (const field of POLICY_SCOPE_FIELDS) {
    if (values.get(`override-${field.key}`) === 'on') scope[field.key] = linesToList(values.get(`scope-${field.key}`));
  }
  if (Object.keys(scope).length) document.scope = scope;
  const budget = {};
  for (const field of POLICY_BUDGET_FIELDS) {
    const value = numberField(values.get(`budget-${field.key}`));
    if (value !== undefined) budget[field.key] = value;
  }
  if (Object.keys(budget).length) document.budget = budget;
  const ttlSeconds = numberField(values.get('approval-ttlSeconds'));
  if (ttlSeconds !== undefined) document.approval = { ttlSeconds };
  const advisor = {};
  if (values.get('advisor-enabled') === 'off') advisor.enabled = false;
  const riskThreshold = unitField(values.get('advisor-riskThreshold'));
  if (riskThreshold !== undefined) advisor.riskThreshold = riskThreshold;
  const minConfidence = unitField(values.get('advisor-minConfidence'));
  if (minConfidence !== undefined) advisor.minConfidence = minConfidence;
  if (values.get('advisor-fallback') === 'deny') advisor.fallback = 'deny';
  if (Object.keys(advisor).length) document.advisor = advisor;
  return document;
}

/** The action descriptor a simulation form describes. Empty fields are left out. */
export function actionFromSimulationForm(values) {
  const text = (name) => String(values.get(name) ?? '').trim();
  const action = { version: 1, actionClass: text('actionClass'), repository: text('repository') };
  if (text('branch')) action.branch = text('branch');
  const paths = linesToList(values.get('paths'));
  if (paths.length) action.paths = paths;
  const command = text('command').split(/\s+/u).filter(Boolean);
  if (command.length) action.command = command;
  if (text('packageName') || text('packageEcosystem') || text('packageRegistry')) {
    action.package = { ecosystem: text('packageEcosystem'), name: text('packageName'), registry: text('packageRegistry') };
  }
  if (text('host')) action.host = text('host');
  const platformEffects = values.getAll('platformEffects').map(String).filter((value) => POLICY_PLATFORM_EFFECTS.includes(value));
  if (platformEffects.length) action.platformEffects = platformEffects;
  return action;
}

// ---------------------------------------------------------------- renderers

const checkbox = (name, value, checked, text) => `<label class="checkbox-label policy-check"><input type="checkbox" name="${escape(name)}" value="${escape(value)}"${checked ? ' checked' : ''}><span>${escape(text)}</span></label>`;
const options = (values, current, labels, blank) => `${blank === undefined ? '' : `<option value=""${current ? '' : ' selected'}>${escape(blank)}</option>`}${values.map((value) => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(labels[value] ?? value)}</option>`).join('')}`;

function renderClassMatrix(scope, document) {
  const rows = POLICY_ACTION_CLASSES.map((actionClass) => {
    const has = (field) => list(document?.[field]).includes(actionClass);
    if (scope === 'global') {
      const rule = document?.defaults?.[actionClass];
      return `<tr><th scope="row">${escape(label(actionClass))}</th>
        <td>${checkbox('allowedActionClasses', actionClass, has('allowedActionClasses'), 'Allowed')}</td>
        <td>${checkbox('hardDeny', actionClass, has('hardDeny'), 'Hard deny')}</td>
        <td>${checkbox('mandatoryApproval', actionClass, has('mandatoryApproval'), 'Always approve')}</td>
        <td><label class="policy-select"><span class="sr-only">${escape(label(actionClass))} default</span><select name="effect-${escape(actionClass)}">${options(POLICY_EFFECTS, rule?.effect, POLICY_EFFECT_LABELS, 'Require approval (no default)')}</select></label></td>
        <td>${checkbox(`delegable-${actionClass}`, 'on', rule?.delegable === true, 'Projects may choose')}</td></tr>`;
    }
    return `<tr><th scope="row">${escape(label(actionClass))}</th>
      <td>${checkbox('allowedActionClasses', actionClass, has('allowedActionClasses'), 'Keep')}</td>
      <td>${checkbox('hardDeny', actionClass, has('hardDeny'), 'Deny here')}</td>
      <td>${checkbox('mandatoryApproval', actionClass, has('mandatoryApproval'), 'Always approve')}</td>
      <td><label class="policy-select"><span class="sr-only">${escape(label(actionClass))} rule</span><select name="rule-${escape(actionClass)}">${options(POLICY_EFFECTS, document?.rules?.[actionClass], POLICY_EFFECT_LABELS, 'Inherit')}</select></label></td></tr>`;
  }).join('');
  const head = scope === 'global'
    ? '<tr><th scope="col">Action</th><th scope="col">Allowed</th><th scope="col">Hard deny</th><th scope="col">Mandatory approval</th><th scope="col">Default effect</th><th scope="col">Delegation</th></tr>'
    : '<tr><th scope="col">Action</th><th scope="col">Allowed classes</th><th scope="col">Hard deny</th><th scope="col">Mandatory approval</th><th scope="col">Rule</th></tr>';
  const restrict = scope === 'project'
    ? `<p class="field-help">${checkbox('restrictClasses', 'on', Array.isArray(document?.allowedActionClasses), 'Restrict this project to the classes marked Keep')}</p>`
    : '<p class="field-help">With no default effect a class requires approval. Ticking Projects may choose on such a class saves Require approval as its default, which projects may then change.</p>';
  return `<fieldset class="policy-fieldset"><legend>Action classes</legend>${restrict}<div class="policy-scroll"><table class="data-table policy-matrix"><thead>${head}</thead><tbody>${rows}</tbody></table></div></fieldset>`;
}

function renderScopeFields(scope, document) {
  return `<fieldset class="policy-fieldset"><legend>Scope</legend><div class="policy-grid">${POLICY_SCOPE_FIELDS.map((field) => {
    const value = document?.scope?.[field.key];
    const override = scope === 'project'
      ? checkbox(`override-${field.key}`, 'on', Array.isArray(value), 'Override the global list')
      : '';
    return `<div class="policy-field"><label for="policy-scope-${escape(field.key)}">${escape(field.label)}</label>${override}<textarea id="policy-scope-${escape(field.key)}" name="scope-${escape(field.key)}" rows="3" spellcheck="false"${scope === 'project' ? ' placeholder="Inherit"' : ''}>${escape(list(value).join('\n'))}</textarea><p class="field-help">${escape(field.help)}</p></div>`;
  }).join('')}</div></fieldset>`;
}

function renderBudgetFields(scope, document) {
  const fields = POLICY_BUDGET_FIELDS.map((field) => {
    const value = document?.budget?.[field.key];
    return `<label>${escape(field.label)}<input name="budget-${escape(field.key)}" inputmode="numeric" value="${escape(value ?? '')}"${scope === 'project' ? ' placeholder="Inherit"' : ''}></label>`;
  }).join('');
  const ttl = document?.approval?.ttlSeconds;
  return `<fieldset class="policy-fieldset"><legend>Budget and approval</legend><div class="policy-grid">${fields}<label>Approval expiry (seconds)<input name="approval-ttlSeconds" inputmode="numeric" value="${escape(ttl ?? '')}"${scope === 'project' ? ' placeholder="Inherit"' : ''}></label></div>${scope === 'project' ? '<p class="field-help">A project value can only be lower than the global value.</p>' : ''}</fieldset>`;
}

function renderAdvisorFields(scope, document) {
  const advisor = document?.advisor ?? {};
  const project = scope === 'project';
  const number = (key, text) => `<label>${escape(text)}<input name="advisor-${escape(key)}" inputmode="decimal" value="${escape(advisor[key] ?? (project ? '' : POLICY_ADVISOR_DEFAULTS[key]))}"${project ? ' placeholder="Inherit"' : ''}></label>`;
  const enabled = project
    ? `<label class="policy-select">Advisor<select name="advisor-enabled">${options(['off'], advisor.enabled === false ? 'off' : '', { off: 'Turn off for this project' }, 'Inherit')}</select></label>`
    : checkbox('advisor-enabled', 'on', advisor.enabled === true, 'Let the advisor clear Advisor or approval actions');
  const fallback = project
    ? options(['deny'], advisor.fallback === 'deny' ? 'deny' : '', POLICY_ADVISOR_FALLBACK_LABELS, 'Inherit')
    : options(Object.keys(POLICY_ADVISOR_FALLBACK_LABELS), advisor.fallback ?? POLICY_ADVISOR_DEFAULTS.fallback, POLICY_ADVISOR_FALLBACK_LABELS);
  const help = project
    ? 'A project can only turn the advisor off, lower the risk threshold, raise the confidence floor or fall back to Deny.'
    : 'Applies only to actions whose effect is Advisor or approval. The advisor can clear such an action or escalate it to a human; it never overrides a deny or a required approval. It also needs a TypeSafe key and the execution-risk Decision Plane purpose.';
  return `<fieldset class="policy-fieldset"><legend>Execution-risk advisor</legend>${enabled}<div class="policy-grid">${number('riskThreshold', 'Escalate at risk (0 to 1)')}${number('minConfidence', 'Minimum confidence (0 to 1)')}<label class="policy-select">When the advisor cannot answer<select name="advisor-fallback">${fallback}</select></label></div><p class="field-help">${escape(help)}</p></fieldset>`;
}

/** The effective advisor as one line. */
function advisorSummary(advisor) {
  const value = { ...POLICY_ADVISOR_DEFAULTS, ...(advisor ?? {}) };
  if (!value.enabled) return 'Off';
  return `On: escalates at risk ${escape(value.riskThreshold)} or above, needs confidence ${escape(value.minConfidence)}, otherwise ${escape(POLICY_ADVISOR_FALLBACK_LABELS[value.fallback] ?? value.fallback)}`;
}

/** What the advisor contributed to one gate decision. */
function decisionAdvisorSummary(advisor) {
  if (!advisor) return 'Not required';
  const details = [
    typeof advisor.risk === 'number' ? `risk ${escape(advisor.risk)}` : '',
    typeof advisor.confidence === 'number' ? `confidence ${escape(advisor.confidence)}` : ''
  ].filter(Boolean).join(', ');
  const id = advisor.decisionId ? ` ${renderCopyChip({ value: advisor.decisionId, label: 'Advisor decision' })}` : '';
  if (advisor.consulted) {
    return `Jev consulted: ${advisor.effect === 'escalate' ? 'escalated to a human' : 'no change'}${details ? ` (${details})` : ''}${id}`;
  }
  if (advisor.fallbackReason) {
    const reason = escape(POLICY_ADVISOR_REASON_LABELS[advisor.fallbackReason] ?? advisor.fallbackReason);
    const fallback = advisor.fallback ? `, falls back to ${escape(POLICY_ADVISOR_FALLBACK_LABELS[advisor.fallback] ?? advisor.fallback)}` : '';
    return `Jev not consulted (${reason})${fallback}${details ? `; ${details}` : ''}${id}`;
  }
  return advisor.required ? 'Required before the action runs' : 'Not required';
}

/** The editor: a form or a JSON view of the same draft document. */
export function renderPolicyEditor(view) {
  const tabs = `<div class="row-actions policy-modes" role="group" aria-label="Editor view">
    <button type="button" data-policy-action="mode-form" aria-pressed="${view.mode === 'form'}">Form</button>
    <button type="button" data-policy-action="mode-json" aria-pressed="${view.mode === 'json'}">JSON</button></div>`;
  const body = view.mode === 'json'
    ? `<label for="policy-json">Policy document (JSON)</label><textarea id="policy-json" name="document" rows="18" spellcheck="false" class="mono">${escape(view.jsonText ?? '')}</textarea>
      <div class="row-actions"><button type="button" data-policy-action="json-to-form">Load JSON into form</button></div>`
    : `${renderClassMatrix(view.scope, view.document)}${renderScopeFields(view.scope, view.document)}${renderBudgetFields(view.scope, view.document)}${renderAdvisorFields(view.scope, view.document)}`;
  const remove = view.scope === 'project' && view.head
    ? '<button type="button" class="danger" data-policy-action="delete">Remove project policy</button>'
    : '';
  return `<section class="panel" aria-labelledby="policy-editor-title"><h2 id="policy-editor-title">${view.scope === 'global' ? 'Global policy' : 'Project policy'}</h2>
    ${tabs}
    <form id="policy-form" class="policy-form" novalidate>${body}
      <label>Change note<input name="note" maxlength="500" value="${escape(view.note ?? '')}" placeholder="Optional, kept in the history"></label>
      <div class="row-actions">${remove}<button type="button" data-policy-action="reset">Discard changes</button><button type="button" data-policy-action="validate">Check changes</button><button type="submit" class="accent-btn"${view.busy ? ' disabled' : ''}>Save policy</button></div>
      <p class="form-status" role="status" data-save-state="${escape(view.message?.tone === 'error' ? 'error' : '')}">${escape(view.message?.text ?? '')}</p>
    </form></section>`;
}

/** Errors, refused widenings, weakenings to confirm and the field diff from "Check changes". */
export function renderPolicyValidation(validation) {
  if (!validation) return '';
  const block = (title, items, tone) => (items.length
    ? `<div class="policy-callout ${tone}"><h3>${escape(title)}</h3><ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></div>`
    : '');
  const verdict = validation.valid
    ? (validation.weakenings.length ? '<p class="policy-verdict"><span class="status pending">weakens</span> Saving asks you to confirm the weakening.</p>' : '<p class="policy-verdict"><span class="status active">valid</span> This change does not weaken the effective policy.</p>')
    : '<p class="policy-verdict"><span class="status failed">refused</span> Fix the items below before saving.</p>';
  return `<section class="panel" aria-labelledby="policy-check-title"><h2 id="policy-check-title">Check result</h2>${verdict}
    ${block('Invalid fields', list(validation.errors), 'error')}
    ${block('Widens the global policy (a project can only narrow it)', list(validation.widenings), 'error')}
    ${block('Weakens the effective policy', list(validation.weakenings), 'warning')}
    ${renderPolicyChanges(validation.changes, 'Changes against the saved policy')}
    ${validation.effective ? renderEffectivePolicy(validation.effective, 'Effective policy after this change') : ''}</section>`;
}

/** A field-level diff between two policy documents. */
export function renderPolicyChanges(changes, title = 'Changes') {
  const rows = list(changes);
  if (!rows.length) return `<p class="empty-note">${escape(title)}: none.</p>`;
  return `<h3>${escape(title)}</h3><div class="policy-scroll"><table class="data-table policy-diff"><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows.map((change) => `<tr><th scope="row"><code>${escape(change.path)}</code></th><td>${change.before === null ? '<span class="policy-muted">unset</span>' : `<code>${escape(change.before)}</code>`}</td><td>${change.after === null ? '<span class="policy-muted">unset</span>' : `<code>${escape(change.after)}</code>`}</td></tr>`).join('')}</tbody></table></div>`;
}

/** The merged policy the runner enforces, with where each effect comes from. */
export function renderEffectivePolicy(effective, title = 'Effective policy') {
  if (!effective) return '';
  const rows = POLICY_ACTION_CLASSES.map((actionClass) => {
    const rule = list(effective.effects).find((entry) => entry.actionClass === actionClass);
    const denied = list(effective.hardDeny).includes(actionClass);
    const outcome = denied ? '<span class="status failed">hard deny</span>' : rule
      ? (rule.mandatoryApproval ? '<span class="status pending">always approve</span>' : `<span class="status ${rule.effect === 'allow' ? 'active' : 'pending'}">${escape(POLICY_EFFECT_LABELS[rule.effect] ?? rule.effect)}</span>`)
      : '<span class="status">not allowed</span>';
    return `<tr><th scope="row">${escape(label(actionClass))}</th><td>${outcome}</td><td>${rule ? escape(rule.source) : '<span class="policy-muted">—</span>'}</td><td>${rule?.delegable ? 'Yes' : 'No'}</td></tr>`;
  }).join('');
  const scope = POLICY_SCOPE_FIELDS.map((field) => `<dt>${escape(field.label)}</dt><dd>${entries(effective.scope?.[field.key])}</dd>`).join('');
  const budget = POLICY_BUDGET_FIELDS.map((field) => `<dt>${escape(field.label)}</dt><dd>${escape(effective.budget?.[field.key] ?? '')}</dd>`).join('');
  const ignored = list(effective.ignoredProjectFields);
  return `<h3>${escape(title)}</h3><div class="policy-scroll"><table class="data-table policy-effective"><thead><tr><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Source</th><th scope="col">Delegable</th></tr></thead><tbody>${rows}</tbody></table></div>
    <dl class="policy-facts">${scope}${budget}<dt>Approval expiry (seconds)</dt><dd>${escape(effective.approval?.ttlSeconds ?? '')}</dd><dt>Execution-risk advisor</dt><dd>${advisorSummary(effective.advisor)}</dd></dl>
    ${ignored.length ? `<div class="policy-callout warning"><h3>Ignored project fields</h3><ul>${ignored.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></div>` : ''}`;
}

/** Global value, project setting and the effective result side by side. */
export function renderPolicyInheritance(global, project, effective) {
  if (!global || !effective) return '';
  const inherit = '<span class="policy-muted">inherit</span>';
  const row = (name, globalValue, projectValue, effectiveValue) => `<tr><th scope="row">${escape(name)}</th><td>${globalValue}</td><td>${projectValue}</td><td>${effectiveValue}</td></tr>`;
  const classRows = [
    row('Allowed classes', joinOrNone(global.allowedActionClasses), project?.allowedActionClasses ? joinOrNone(project.allowedActionClasses) : inherit, joinOrNone(effective.allowedActionClasses)),
    row('Hard deny', joinOrNone(global.hardDeny), project?.hardDeny ? joinOrNone(project.hardDeny) : inherit, joinOrNone(effective.hardDeny)),
    row('Mandatory approval', joinOrNone(global.mandatoryApproval), project?.mandatoryApproval ? joinOrNone(project.mandatoryApproval) : inherit, joinOrNone(effective.mandatoryApproval))
  ];
  const effectRows = POLICY_ACTION_CLASSES.map((actionClass) => {
    const base = global.defaults?.[actionClass];
    const rule = list(effective.effects).find((entry) => entry.actionClass === actionClass);
    return row(`${label(actionClass)} effect`,
      base ? `${escape(POLICY_EFFECT_LABELS[base.effect])}${base.delegable ? ' <span class="tag-badge">delegable</span>' : ''}` : '<span class="policy-muted">require approval</span>',
      project?.rules?.[actionClass] ? escape(POLICY_EFFECT_LABELS[project.rules[actionClass]] ?? project.rules[actionClass]) : inherit,
      rule ? escape(POLICY_EFFECT_LABELS[rule.effect] ?? rule.effect) : '<span class="policy-muted">not allowed</span>');
  });
  const scopeRows = POLICY_SCOPE_FIELDS.map((field) => row(field.label, entries(global.scope?.[field.key]), project?.scope?.[field.key] ? entries(project.scope[field.key]) : inherit, entries(effective.scope?.[field.key])));
  const budgetRows = POLICY_BUDGET_FIELDS.map((field) => row(field.label, escape(global.budget?.[field.key] ?? ''), project?.budget?.[field.key] !== undefined ? escape(project.budget[field.key]) : inherit, escape(effective.budget?.[field.key] ?? '')));
  budgetRows.push(row('Approval expiry (seconds)', escape(global.approval?.ttlSeconds ?? ''), project?.approval?.ttlSeconds !== undefined ? escape(project.approval.ttlSeconds) : inherit, escape(effective.approval?.ttlSeconds ?? '')));
  const advisorValue = (source, key) => {
    if (key === 'enabled') return source.enabled ? 'On' : 'Off';
    if (key === 'fallback') return escape(POLICY_ADVISOR_FALLBACK_LABELS[source.fallback] ?? source.fallback);
    return escape(source[key]);
  };
  const advisorRows = [['enabled', 'Advisor'], ['riskThreshold', 'Advisor risk threshold'], ['minConfidence', 'Advisor minimum confidence'], ['fallback', 'Advisor fallback']].map(([key, name]) => row(name,
    advisorValue({ ...POLICY_ADVISOR_DEFAULTS, ...(global.advisor ?? {}) }, key),
    project?.advisor?.[key] !== undefined ? advisorValue(project.advisor, key) : inherit,
    advisorValue({ ...POLICY_ADVISOR_DEFAULTS, ...(effective.advisor ?? {}) }, key)));
  return `<section class="panel" aria-labelledby="policy-inheritance-title"><h2 id="policy-inheritance-title">Inheritance</h2>
    <p class="page-note">A project policy can only narrow the global policy. Where the owner marked a class as delegable, the project may choose its effect.</p>
    <div class="policy-scroll"><table class="data-table policy-inheritance"><thead><tr><th scope="col">Field</th><th scope="col">Global</th><th scope="col">Project</th><th scope="col">Effective</th></tr></thead><tbody>${[...classRows, ...effectRows, ...scopeRows, ...budgetRows, ...advisorRows].join('')}</tbody></table></div></section>`;
}

/** One gate decision, as the runner's evaluator returned it. */
export function renderPolicyDecision(decision) {
  if (!decision) return '';
  const status = DECISION_STATUS[decision.decision] ?? 'info';
  const reasons = list(decision.reasons).map((reason) => `<li><code>${escape(reason.code)}</code> <span class="tag-badge">${escape(reason.source)}</span> ${escape(reason.detail)}</li>`).join('');
  const policy = decision.policy ?? {};
  return `<div class="policy-decision" data-decision="${escape(decision.decision)}">
    <p class="policy-verdict"><span class="status ${status}">${escape(DECISION_LABELS[decision.decision] ?? decision.decision)}</span> <code>${escape(decision.reasonCode)}</code></p>
    <ul class="policy-reasons">${reasons}</ul>
    <dl class="policy-facts">
      <dt>Matched rules</dt><dd>${entries(decision.matchedRules)}</dd>
      <dt>Global policy</dt><dd>${escape(policy.globalSource ?? '')}${policy.globalRevisionId ? ` ${renderCopyChip({ value: policy.globalRevisionId, label: 'Global revision' })}` : ''}</dd>
      <dt>Project policy</dt><dd>${escape(policy.projectSource ?? '')}${policy.projectRevisionId ? ` ${renderCopyChip({ value: policy.projectRevisionId, label: 'Project revision' })}` : ''}</dd>
      <dt>Advisor</dt><dd>${decisionAdvisorSummary(decision.advisor)}</dd>
      <dt>Approval expiry</dt><dd>${escape(decision.approval?.ttlSeconds ?? '')} seconds</dd>
      <dt>Input fingerprint</dt><dd>${renderCopyChip({ value: decision.inputFingerprint ?? '', label: 'Input fingerprint' })}</dd>
    </dl></div>`;
}

/** The simulation panel: one proposed action through the runner's gate. */
export function renderPolicySimulation(view) {
  const form = view.simulationForm ?? {};
  const value = (name, fallback = '') => escape(form[name] ?? fallback);
  const effects = POLICY_PLATFORM_EFFECTS.map((effect) => checkbox('platformEffects', effect, list(form.platformEffects).includes(effect), effect.replaceAll('_', ' '))).join('');
  return `<section class="panel" aria-labelledby="policy-simulate-title"><h2 id="policy-simulate-title">Simulate an action</h2>
    <p class="page-note">The runner evaluates this action with the same gate that execution uses${view.scope === 'project' ? ', bound to this project' : ''}. Free-text reasons are never part of a decision.</p>
    <form id="policy-simulate-form" class="policy-form" novalidate><div class="policy-grid">
      <label>Action<select name="actionClass">${options(POLICY_ACTION_CLASSES, form.actionClass ?? 'edit', POLICY_ACTION_LABELS)}</select></label>
      <label>Repository<input name="repository" value="${value('repository')}" placeholder="owner/name" spellcheck="false"></label>
      <label>Branch<input name="branch" value="${value('branch')}" placeholder="agent/fix-123" spellcheck="false"></label>
      <label>Command<input name="command" value="${value('command')}" placeholder="npm test" spellcheck="false"></label>
      <label>Paths<textarea name="paths" rows="2" spellcheck="false" placeholder="src/index.ts">${value('paths')}</textarea></label>
      <label>Network host<input name="host" value="${value('host')}" placeholder="api.github.com" spellcheck="false"></label>
      <label>Package ecosystem<input name="packageEcosystem" value="${value('packageEcosystem')}" placeholder="npm" spellcheck="false"></label>
      <label>Package name<input name="packageName" value="${value('packageName')}" spellcheck="false"></label>
      <label>Package registry<input name="packageRegistry" value="${value('packageRegistry')}" placeholder="registry.npmjs.org" spellcheck="false"></label>
    </div>
    <fieldset class="policy-fieldset"><legend>Platform effects the broker reports</legend>${effects}</fieldset>
    ${checkbox('useDraft', 'on', form.useDraft === true, 'Evaluate the unsaved editor draft instead of the saved policy')}
    <div class="row-actions"><button type="submit">Simulate</button></div>
    <p class="form-status" role="status">${escape(view.simulationMessage ?? '')}</p></form>
    ${view.simulation ? renderPolicyDecision(view.simulation.decision) : ''}</section>`;
}

/** Revision history with compare and rollback. */
export function renderPolicyHistory(view) {
  const history = view.history;
  if (!history) return '';
  const rows = list(history.revisions).map((revision) => {
    const current = revision.revisionId === history.headRevisionId;
    return `<tr><th scope="row">v${escape(revision.version)}${current ? ' <span class="status active">current</span>' : ''}</th>
      <td>${escape(revision.createdAt)}</td><td>${revision.note ? escape(revision.note) : '<span class="policy-muted">—</span>'}</td>
      <td>${revision.rollbackOf ? `rollback of ${renderCopyChip({ value: revision.rollbackOf, label: 'Source revision' })}` : '<span class="policy-muted">—</span>'}</td>
      <td class="row-actions">${current ? '' : `<button type="button" data-policy-action="compare" data-revision-id="${escape(revision.revisionId)}">Compare with current</button><button type="button" data-policy-action="rollback" data-revision-id="${escape(revision.revisionId)}" data-version="${escape(revision.version)}">Roll back to v${escape(revision.version)}</button>`}</td></tr>`;
  }).join('');
  const more = history.nextBeforeVersion ? `<div class="row-actions"><button type="button" data-policy-action="older" data-before-version="${escape(history.nextBeforeVersion)}">Older revisions</button></div>` : '';
  return `<section class="panel" aria-labelledby="policy-history-title"><h2 id="policy-history-title">History</h2>
    ${rows ? `<div class="policy-scroll"><table class="data-table policy-history"><thead><tr><th scope="col">Version</th><th scope="col">Saved</th><th scope="col">Note</th><th scope="col">Origin</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>${more}` : '<p class="empty-note">No saved revisions yet.</p>'}
    ${view.comparison ? renderPolicyChanges(view.comparison.changes, `Changes from v${view.comparison.version} to the current policy`) : ''}</section>`;
}

/** Project policies the owner saved, linked from the global page. */
export function renderPolicyProjects(overview, projectNames = {}) {
  const projects = list(overview?.projects);
  if (!projects.length) return '<section class="panel" aria-labelledby="policy-projects-title"><h2 id="policy-projects-title">Project policies</h2><p class="empty-note">No project narrows the global policy. Open a project to add one.</p></section>';
  const truncated = overview?.projectsTruncated === true
    ? `<p class="page-note">Showing the ${escape(projects.length)} most recently changed project policies. Open a project to see a policy that is not listed.</p>`
    : '';
  return `<section class="panel" aria-labelledby="policy-projects-title"><h2 id="policy-projects-title">Project policies</h2>${truncated}<ul class="record-list">${projects.map((entry) => `<li class="policy-project">
    <a href="/dashboard/projects/${encodeURIComponent(entry.projectId)}/agent-policies">${escape(projectNames[entry.projectId] ?? entry.projectId)}</a>
    <span class="tag-badge">v${escape(entry.head?.version ?? '')}</span>${entry.orphaned ? ' <span class="status failed">orphaned</span>' : ''}</li>`).join('')}</ul></section>`;
}

/** Shown instead of the editor while `AGENT_POLICIES_ENABLED` is off. */
export function renderPoliciesDisabled() {
  return '<div class="empty policy-disabled"><h3>Agent policies are off on this instance.</h3><p>Set <code>AGENT_POLICIES_ENABLED=true</code> on the runner and restart it to edit, check and simulate execution policies. While it is off the runner refuses every policy operation.</p></div>';
}

function renderHeader(view) {
  const head = view.head;
  const source = view.scope === 'global'
    ? (head ? `<span class="status active">saved</span> v${escape(head.version)}` : '<span class="status info">default</span> The read-only default applies until you save a global policy.')
    : (head ? `<span class="status active">saved</span> v${escape(head.version)}` : '<span class="status info">inherits</span> No project policy: the global policy applies alone.');
  const orphaned = view.projectState === 'unknown' ? ' <span class="status failed">orphaned</span> The project no longer exists; remove this policy.' : '';
  const link = view.scope === 'project'
    ? '<a href="/dashboard/settings/agent-policies">Global agent policy</a>'
    : '<a href="/dashboard/settings">Back to Settings</a>';
  return `<div class="panel policy-header"><p class="policy-verdict">${source}${orphaned}</p><p class="field-help">${link}</p></div>`;
}

export function renderAgentPolicyPage(view) {
  if (view.status === 'loading') return '<div class="skeleton tile" aria-hidden="true"></div>';
  if (view.status === 'disabled') return renderPoliciesDisabled();
  if (view.status === 'error') return `<div class="empty"><h3>Agent policies could not load.</h3><p>${escape(view.error ?? '')}</p><button type="button" data-policy-action="retry">Try again</button></div>`;
  return `<div class="policy-page">${renderHeader(view)}
    ${renderPolicyEditor(view)}
    ${renderPolicyValidation(view.validation)}
    <section class="panel" aria-labelledby="policy-effective-title"><h2 id="policy-effective-title">Effective policy preview</h2>${view.effective ? renderEffectivePolicy(view.effective, 'Saved effective policy') : '<p class="empty-note">No effective permissions: this project no longer exists, so every agent action for it is denied.</p>'}</section>
    ${view.scope === 'project' ? renderPolicyInheritance(view.globalDocument, view.savedDocument, view.effective) : ''}
    ${renderPolicySimulation(view)}
    ${renderPolicyHistory(view)}
    ${view.scope === 'global' ? renderPolicyProjects(view.overview, view.projectNames) : ''}</div>`;
}

// ---------------------------------------------------------------- controller

const errorText = (error, fallback) => (error && typeof error.message === 'string' && error.message ? error.message : fallback);
const isDisabled = (error) => error?.status === 503 && error?.code === 'feature_disabled';
const clone = (value) => (value === undefined || value === null ? value : JSON.parse(JSON.stringify(value)));

/**
 * Mounts the editor on `root`. Dependencies are injected so the module stays testable and holds no
 * global state: `api(path, init)` is the CSRF-aware Dashboard client, `confirm` the shared
 * confirmation dialog, `insert` the CSP-safe renderer, `defer` schedules a task after the current dialog closes.
 */
export function createAgentPolicyEditor({ root, insert, api, announce = () => {}, confirm, scope, projectId = null, projectNames = {}, defer = (task) => globalThis.setTimeout(task, 0) }) {
  const base = scope === 'global' ? '/agent-policies/global' : `/agent-policies/projects/${encodeURIComponent(projectId)}`;
  const view = {
    status: 'loading', scope, projectId, projectNames, mode: 'form', document: null, jsonText: '', note: '',
    head: null, savedDocument: null, globalDocument: null, effective: null, projectState: null, overview: null,
    validation: null, simulation: null, simulationForm: { actionClass: 'edit' }, simulationMessage: '', history: null, comparison: null,
    message: null, busy: false, error: null
  };
  let busy = false;
  const render = () => insert(root, renderAgentPolicyPage(view));
  const formElement = () => root.querySelector('#policy-form');

  async function load() {
    try {
      const [{ data }, history, overview] = await Promise.all([
        api(base),
        api(`${base}/history`),
        scope === 'global' ? api('/agent-policies') : Promise.resolve(null)
      ]);
      const saved = data.head?.document ?? null;
      Object.assign(view, {
        status: 'ready', error: null, head: data.head, projectState: data.projectState, effective: data.effective,
        globalDocument: data.global?.document ?? null, savedDocument: scope === 'global' ? (saved ?? data.global?.document ?? null) : saved,
        history: history.data, overview: overview?.data ?? null
      });
      view.document = clone(scope === 'global' ? view.savedDocument : (saved ?? { version: 1 }));
      view.jsonText = JSON.stringify(view.document, null, 2);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (isDisabled(error)) Object.assign(view, { status: 'disabled' });
      else Object.assign(view, { status: 'error', error: errorText(error, 'The policy could not be loaded.') });
    }
  }

  async function refresh() { await load(); render(); }

  /** Pulls what the owner typed into the view, so a re-render never drops a draft. */
  function syncDraft() {
    const form = formElement();
    if (!form) return;
    const values = new globalThis.FormData(form);
    view.note = String(values.get('note') ?? '');
    if (view.mode === 'json') view.jsonText = String(values.get('document') ?? '');
    else view.document = scope === 'global' ? globalPolicyFromForm(values) : projectPolicyFromForm(values);
  }

  /** The draft as a document, or an error message when the JSON does not parse. */
  function draftDocument() {
    syncDraft();
    if (view.mode !== 'json') return { document: view.document };
    try {
      return { document: JSON.parse(view.jsonText) };
    } catch {
      return { error: 'The JSON view does not contain valid JSON.' };
    }
  }

  function setMessage(text, tone = '') {
    view.message = text ? { text, tone } : null;
    render();
  }

  /** Validates `document` as a preview of `intent` (save, rollback or delete); the digest only confirms that operation. */
  async function check(document, intent = 'save') {
    const result = await api(`${base}/validate`, { method: 'POST', body: JSON.stringify({ document, intent }) });
    view.validation = result.data;
    return result.data;
  }

  async function validate() {
    const draft = draftDocument();
    if (draft.error) return setMessage(draft.error, 'error');
    try {
      const result = await check(draft.document);
      setMessage(result.valid ? 'Checked. Review the result below.' : 'The draft cannot be saved as it is.', result.valid ? '' : 'error');
    } catch (error) {
      setMessage(errorText(error, 'The draft could not be checked.'), 'error');
    }
  }

  /** The confirmation fields for a write: bound to the digest of the weakening list the owner saw. */
  const confirmation = (weakeningDigest) => (weakeningDigest ? { confirmWeakening: true, weakeningDigest } : { confirmWeakening: false });

  /**
   * A 428 means the weakenings changed after the owner reviewed them (another save moved a head). The
   * confirmation dialog is still closing, so the fresh review opens on the next task.
   */
  function reconfirm(text, reopen) {
    setMessage(text, 'error');
    defer(reopen);
  }

  function promptWeakening(document, result, invoker, description) {
    confirm({
      title: 'Save a weaker policy?',
      description: description ?? 'This change lets agents do more than the current effective policy allows. Confirm only if you intend to loosen it.',
      target: result.weakenings.join('; '),
      label: 'Save weaker policy',
      pendingLabel: 'Saving…',
      action: () => run(() => put(document, result.weakeningDigest, invoker))
    }, invoker);
  }

  async function put(document, weakeningDigest, invoker) {
    view.busy = true;
    setMessage('Saving…');
    try {
      await api(base, { method: 'PUT', body: JSON.stringify({ document, expectedVersion: view.head?.version ?? 0, ...confirmation(weakeningDigest), ...(view.note.trim() ? { note: view.note.trim() } : {}) }) });
      view.validation = null;
      view.note = '';
      view.busy = false;
      announce('Agent policy saved.');
      await load();
      setMessage('Saved.');
    } catch (error) {
      view.busy = false;
      if (error?.status === 409) {
        // Keep the draft and show what changed underneath it.
        const draft = { document: view.document, jsonText: view.jsonText, mode: view.mode };
        await load();
        Object.assign(view, draft);
        return setMessage('Someone saved this policy while you were editing. The saved version was reloaded; check your draft again before saving.', 'error');
      }
      if (error?.status === 428) {
        let result;
        try {
          result = await check(document);
        } catch (checkError) {
          return setMessage(errorText(checkError, 'The draft could not be checked.'), 'error');
        }
        if (!result.valid || !result.weakenings.length) return setMessage('The effective policy changed after your check. Review the check result below and save again.', 'error');
        return reconfirm('The weakenings changed after you reviewed them. Confirm the current list to save.', () => promptWeakening(document, result, invoker, 'The effective policy changed after your review. This is the current list of weakenings this save would make.'));
      }
      setMessage(errorText(error, 'The policy could not be saved.'), 'error');
    }
  }

  async function save(invoker) {
    const draft = draftDocument();
    if (draft.error) return setMessage(draft.error, 'error');
    let result;
    try {
      result = await check(draft.document);
    } catch (error) {
      return setMessage(errorText(error, 'The draft could not be checked.'), 'error');
    }
    if (!result.valid) return setMessage('The draft cannot be saved as it is. See the check result below.', 'error');
    if (!result.weakenings.length) return await put(draft.document, null, invoker);
    render();
    promptWeakening(draft.document, result, invoker);
  }

  async function revisionCheck(revisionId) {
    const { data } = await api(`/agent-policies/revisions/${encodeURIComponent(revisionId)}`);
    return check(data.revision.document, 'rollback');
  }

  /** Weakenings without a digest cannot be confirmed (too many to show in full); explain instead of prompting. */
  const unconfirmable = (result) => list(result.weakenings).length > 0 && !result.weakeningDigest;

  async function rollback(button) {
    const revisionId = button.dataset.revisionId;
    let result;
    try {
      result = await revisionCheck(revisionId);
    } catch (error) {
      return setMessage(errorText(error, 'The revision could not be checked.'), 'error');
    }
    if (unconfirmable(result)) return setMessage(list(result.errors)[0] ?? 'This rollback weakens the policy too much to confirm at once.', 'error');
    const weakenings = list(result.weakenings);
    render();
    confirm({
      title: `Roll back to v${button.dataset.version}?`,
      description: weakenings.length
        ? 'The rollback creates a new revision and weakens the effective policy.'
        : 'The rollback creates a new revision with the older document. History is kept.',
      target: weakenings.length ? weakenings.join('; ') : `Revision ${revisionId}`,
      label: weakenings.length ? 'Roll back and weaken' : 'Roll back',
      pendingLabel: 'Rolling back…',
      action: () => run(async () => {
        try {
          await api(`/agent-policies/revisions/${encodeURIComponent(revisionId)}/rollback`, { method: 'POST', body: JSON.stringify({ expectedVersion: view.head?.version ?? 0, ...confirmation(result.weakeningDigest) }) });
          announce('Agent policy rolled back.');
          view.comparison = null;
          await refresh();
        } catch (error) {
          if (error?.status === 409) await load();
          if (error?.status === 428) return reconfirm('The weakenings changed after you reviewed them. Review the rollback again.', () => void run(() => rollback(button)));
          setMessage(errorText(error, 'The rollback failed.'), 'error');
        }
      })
    }, button);
  }

  async function removeProjectPolicy(button) {
    let result = { weakenings: [], weakeningDigest: null };
    try {
      // Validating an empty project document previews exactly what removing the policy does.
      if (view.projectState === 'active') result = await check({ version: 1 }, 'delete');
    } catch (error) {
      return setMessage(errorText(error, 'The removal could not be checked.'), 'error');
    }
    if (unconfirmable(result)) return setMessage(list(result.errors)[0] ?? 'Removing this policy weakens it too much to confirm at once.', 'error');
    const weakenings = list(result.weakenings);
    render();
    confirm({
      title: 'Remove the project policy?',
      description: 'The project falls back to the global policy. Revisions stay in the history.',
      target: weakenings.length ? weakenings.join('; ') : 'No effective permission changes',
      label: 'Remove policy',
      pendingLabel: 'Removing…',
      action: () => run(async () => {
        try {
          await api(base, { method: 'DELETE', body: JSON.stringify({ expectedVersion: view.head?.version ?? 0, ...confirmation(result.weakeningDigest) }) });
          announce('Project policy removed.');
          view.validation = null;
          await refresh();
        } catch (error) {
          if (error?.status === 409) await load();
          if (error?.status === 428) return reconfirm('The weakenings changed after you reviewed them. Review the removal again.', () => void run(() => removeProjectPolicy(button)));
          setMessage(errorText(error, 'The policy could not be removed.'), 'error');
        }
      })
    }, button);
  }

  async function simulate(form) {
    syncDraft();
    const values = new globalThis.FormData(form);
    view.simulationForm = {
      actionClass: String(values.get('actionClass') ?? ''), repository: String(values.get('repository') ?? ''), branch: String(values.get('branch') ?? ''),
      command: String(values.get('command') ?? ''), paths: String(values.get('paths') ?? ''), host: String(values.get('host') ?? ''),
      packageEcosystem: String(values.get('packageEcosystem') ?? ''), packageName: String(values.get('packageName') ?? ''), packageRegistry: String(values.get('packageRegistry') ?? ''),
      platformEffects: values.getAll('platformEffects').map(String), useDraft: values.get('useDraft') === 'on'
    };
    const body = { action: actionFromSimulationForm(values), ...(projectId ? { projectId } : {}) };
    if (view.simulationForm.useDraft) {
      const draft = draftDocument();
      if (draft.error) { view.simulationMessage = draft.error; return render(); }
      body.draft = { scope, document: draft.document };
    }
    try {
      const result = await api('/agent-policies/simulate', { method: 'POST', body: JSON.stringify(body) });
      view.simulation = result.data;
      view.simulationMessage = '';
    } catch (error) {
      view.simulation = null;
      view.simulationMessage = errorText(error, 'The action could not be simulated.');
    }
    render();
  }

  async function compare(revisionId) {
    if (!view.head) return;
    try {
      const { data } = await api(`/agent-policies/diff?from=${encodeURIComponent(revisionId)}&to=${encodeURIComponent(view.head.revisionId)}`);
      const revision = list(view.history?.revisions).find((entry) => entry.revisionId === revisionId);
      view.comparison = { version: revision?.version ?? '?', changes: data.changes };
      render();
    } catch (error) {
      setMessage(errorText(error, 'The revisions could not be compared.'), 'error');
    }
  }

  async function older(beforeVersion) {
    try {
      const { data } = await api(`${base}/history?beforeVersion=${encodeURIComponent(beforeVersion)}`);
      view.history = { ...data, revisions: [...list(view.history?.revisions), ...data.revisions] };
      render();
    } catch (error) {
      setMessage(errorText(error, 'Older revisions could not be loaded.'), 'error');
    }
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    try { await task(); } finally { busy = false; }
  }

  root.addEventListener('submit', (event) => {
    const form = event.target;
    if (form?.id === 'policy-form') { event.preventDefault(); void run(() => save(form.querySelector('button[type="submit"]'))); }
    else if (form?.id === 'policy-simulate-form') { event.preventDefault(); void run(() => simulate(form)); }
  });
  root.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-policy-action]');
    if (!button || busy) return;
    const action = button.dataset.policyAction;
    if (action === 'retry') { view.status = 'loading'; render(); void run(refresh); }
    else if (action === 'mode-json' && view.mode !== 'json') { syncDraft(); view.jsonText = JSON.stringify(view.document, null, 2); view.mode = 'json'; render(); }
    else if (action === 'mode-form' && view.mode !== 'form') {
      const draft = draftDocument();
      if (draft.error) return setMessage(draft.error, 'error');
      view.document = draft.document; view.mode = 'form'; render();
    }
    else if (action === 'json-to-form') {
      const draft = draftDocument();
      if (draft.error) return setMessage(draft.error, 'error');
      view.document = draft.document; view.mode = 'form'; setMessage('JSON loaded into the form.');
    }
    else if (action === 'reset') {
      view.document = clone(scope === 'global' ? view.savedDocument : (view.savedDocument ?? { version: 1 }));
      view.jsonText = JSON.stringify(view.document, null, 2);
      view.validation = null; view.note = '';
      setMessage('Draft discarded.');
    }
    else if (action === 'validate') void run(validate);
    else if (action === 'delete') void run(() => removeProjectPolicy(button));
    else if (action === 'rollback') void run(() => rollback(button));
    else if (action === 'compare') void run(() => compare(button.dataset.revisionId));
    else if (action === 'older') void run(() => older(button.dataset.beforeVersion));
  });

  return {
    async load() { render(); await refresh(); },
    get view() { return view; }
  };
}
