import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentActionDescriptorSchema, DEFAULT_GLOBAL_EXECUTION_POLICY, GlobalExecutionPolicySchema, ProjectExecutionPolicySchema
} from '@cloud-harness/contracts';
import './dashboard-test-dom.js';
import {
  actionFromSimulationForm, createAgentPolicyEditor, globalPolicyFromForm, linesToList, projectPolicyFromForm,
  renderAgentPolicyPage, renderPolicyDecision, renderPolicyValidation
} from '../dashboard/dashboard-policies.js';
import { FakeElement } from './dashboard-test-dom.js';

const PROJECT = `prj_${'a'.repeat(32)}`;
const REVISION = `apr_${'1'.repeat(32)}`;
const OLDER = `apr_${'2'.repeat(32)}`;

/** FormData stand-in: the controller reads fields only through get/getAll. */
class Values {
  constructor(private readonly fields: Record<string, string | string[]>) {}
  get(name: string) { const value = this.fields[name]; return Array.isArray(value) ? value[0] ?? null : value ?? null; }
  getAll(name: string) { const value = this.fields[name]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
}

/** The form fields the global editor renders for a document, so a round trip proves form and schema agree. */
function globalFields(document: typeof DEFAULT_GLOBAL_EXECUTION_POLICY): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {
    hardDeny: [...document.hardDeny], mandatoryApproval: [...document.mandatoryApproval], allowedActionClasses: [...document.allowedActionClasses],
    'approval-ttlSeconds': String(document.approval.ttlSeconds)
  };
  for (const [actionClass, rule] of Object.entries(document.defaults)) {
    if (!rule) continue;
    fields[`effect-${actionClass}`] = rule.effect;
    if (rule.delegable) fields[`delegable-${actionClass}`] = 'on';
  }
  for (const [key, value] of Object.entries(document.scope)) fields[`scope-${key}`] = (value as string[]).join('\n');
  for (const [key, value] of Object.entries(document.budget)) fields[`budget-${key}`] = String(value);
  return fields;
}

const effective = {
  hardDeny: [], mandatoryApproval: [], allowedActionClasses: ['read'],
  effects: [{ actionClass: 'read', effect: 'allow', source: 'global', delegable: false, mandatoryApproval: false }],
  scope: DEFAULT_GLOBAL_EXECUTION_POLICY.scope, budget: DEFAULT_GLOBAL_EXECUTION_POLICY.budget, approval: DEFAULT_GLOBAL_EXECUTION_POLICY.approval,
  ignoredProjectFields: []
};
const revision = (version: number, revisionId: string, document: unknown) => ({
  revisionId, scope: 'global', projectId: null, version, digest: 'd'.repeat(64), createdAt: '2026-10-19T00:00:00.000Z', createdBy: 'owner', rollbackOf: null, note: null, document
});
const decision = (value: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY', detail = 'checked') => ({
  version: 1, decision: value, reasonCode: value === 'DENY' ? 'HARD_DENY' : 'ALLOWED_BY_POLICY',
  reasons: [{ code: value === 'DENY' ? 'HARD_DENY' : 'ALLOWED_BY_POLICY', source: 'global', detail }],
  matchedRules: ['global.defaults.edit'], actionClass: 'edit',
  policy: { globalRevisionId: REVISION, globalSource: 'stored', projectId: null, projectRevisionId: null, projectSource: 'none' },
  inputFingerprint: 'f'.repeat(64), advisor: { required: false, consulted: false, effect: null, decisionId: null, risk: null, confidence: null, fallbackReason: null, fallback: null, minConfidence: null },
  approval: { ttlSeconds: 3600, approverRoles: ['owner'] }
});

describe('agent policy form mapping', () => {
  it('splits textareas into trimmed unique lines', () => {
    expect(linesToList(' a \r\n\nb\na\n')).toEqual(['a', 'b']);
    expect(linesToList(undefined)).toEqual([]);
  });

  it('round-trips the default global policy through the form into a schema-valid document', () => {
    const document = globalPolicyFromForm(new Values(globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY)));
    expect(GlobalExecutionPolicySchema.parse(document)).toEqual(DEFAULT_GLOBAL_EXECUTION_POLICY);
  });

  it('keeps "Projects may choose" on a class with no default effect as an explicit delegable approval', () => {
    const fields = { ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), allowedActionClasses: ['read', 'edit'], 'delegable-edit': 'on' };
    const document = globalPolicyFromForm(new Values(fields));
    expect(document.defaults.edit).toEqual({ effect: 'require_approval', delegable: true });
    expect(GlobalExecutionPolicySchema.safeParse(document).success).toBe(true);
    expect(globalPolicyFromForm(new Values({ ...fields, 'delegable-edit': [] })).defaults.edit).toBeUndefined();
  });

  it('sends a malformed number as typed so the runner names the field instead of the browser dropping it', () => {
    const document = globalPolicyFromForm(new Values({ ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), 'budget-maxRunSeconds': '15 minutes' }));
    expect(document.budget.maxRunSeconds).toBe('15 minutes');
    expect(GlobalExecutionPolicySchema.safeParse(document).success).toBe(false);
  });

  it('builds a project document that only carries the fields the owner chose to narrow', () => {
    expect(projectPolicyFromForm(new Values({}))).toEqual({ version: 1 });
    const document = projectPolicyFromForm(new Values({
      hardDeny: ['network', 'not-a-class'], restrictClasses: 'on', allowedActionClasses: ['read', 'edit'], 'rule-edit': 'require_approval',
      'override-repositories': 'on', 'scope-repositories': 'acme/widgets', 'scope-commands': 'npm test', 'budget-maxRunSeconds': '600'
    }));
    expect(document).toEqual({
      version: 1, hardDeny: ['network'], allowedActionClasses: ['read', 'edit'], rules: { edit: 'require_approval' },
      scope: { repositories: ['acme/widgets'] }, budget: { maxRunSeconds: 600 }
    });
    expect(ProjectExecutionPolicySchema.parse(document)).toEqual(document);
  });

  it('maps the execution-risk advisor fields, leaving an untouched disabled advisor out', () => {
    const fields = globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY);
    const untouched = { ...fields, 'advisor-riskThreshold': '0.5', 'advisor-minConfidence': '0.7', 'advisor-fallback': 'require_approval' };
    expect(globalPolicyFromForm(new Values(untouched))).not.toHaveProperty('advisor');
    const enabled = globalPolicyFromForm(new Values({ ...untouched, 'advisor-enabled': 'on', 'advisor-riskThreshold': '.4', 'advisor-minConfidence': '0.85', 'advisor-fallback': 'deny' }));
    expect(enabled.advisor).toEqual({ enabled: true, riskThreshold: 0.4, minConfidence: 0.85, fallback: 'deny' });
    expect(GlobalExecutionPolicySchema.parse(enabled).advisor).toEqual(enabled.advisor);
    // An unknown fallback falls back to the safe default; a malformed number is sent as typed for the runner to name.
    const odd = globalPolicyFromForm(new Values({ ...untouched, 'advisor-enabled': 'on', 'advisor-riskThreshold': 'high', 'advisor-fallback': 'allow' }));
    expect(odd.advisor).toMatchObject({ riskThreshold: 'high', fallback: 'require_approval' });
    expect(GlobalExecutionPolicySchema.safeParse(odd).success).toBe(false);

    expect(projectPolicyFromForm(new Values({ 'advisor-enabled': '', 'advisor-fallback': '' }))).toEqual({ version: 1 });
    const project = projectPolicyFromForm(new Values({ 'advisor-enabled': 'off', 'advisor-riskThreshold': '0.25', 'advisor-minConfidence': '1', 'advisor-fallback': 'deny' }));
    expect(project).toEqual({ version: 1, advisor: { enabled: false, riskThreshold: 0.25, minConfidence: 1, fallback: 'deny' } });
    expect(ProjectExecutionPolicySchema.parse(project)).toEqual(project);
  });

  it('builds a schema-valid action descriptor and never carries a reason', () => {
    const action = actionFromSimulationForm(new Values({
      actionClass: 'package_install', repository: 'acme/widgets', branch: '', command: ' npm  install ', paths: 'src/a.ts\nsrc/a.ts',
      packageEcosystem: 'npm', packageName: 'left-pad', packageRegistry: 'registry.npmjs.org', platformEffects: ['docker_access', 'bogus'], reason: 'please allow'
    }));
    expect(action).toEqual({
      version: 1, actionClass: 'package_install', repository: 'acme/widgets', paths: ['src/a.ts'], command: ['npm', 'install'],
      package: { ecosystem: 'npm', name: 'left-pad', registry: 'registry.npmjs.org' }, platformEffects: ['docker_access']
    });
    expect(AgentActionDescriptorSchema.safeParse(action).success).toBe(true);
  });
});

describe('agent policy renderers', () => {
  const hostile = '<img src=x onerror=alert(1)>';

  it('escapes every runner-supplied string and uses no inline style or script', () => {
    const markup = [
      renderPolicyValidation({ valid: false, errors: [hostile], widenings: [hostile], weakenings: [hostile], changes: [{ path: hostile, before: hostile, after: null }], effective }),
      renderPolicyDecision(decision('DENY', hostile)),
      renderAgentPolicyPage({
        status: 'ready', scope: 'global', mode: 'json', jsonText: hostile, note: hostile, document: DEFAULT_GLOBAL_EXECUTION_POLICY, head: null, effective,
        history: { revisions: [], headRevisionId: null, nextBeforeVersion: null },
        overview: { projects: [{ projectId: PROJECT, head: { version: 1 }, orphaned: true }] }, projectNames: { [PROJECT]: hostile }
      })
    ].join('');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Escaped text and quoted attribute values may still read "onerror="; only a real attribute name would run.
    expect(markup.replace(/"[^"]*"/gu, '""')).not.toMatch(/<[^>]*\s(?:style|on[a-z]+)=|<script/iu);
  });

  it('marks each gate outcome with its own status tone', () => {
    expect(renderPolicyDecision(decision('ALLOW'))).toContain('class="status active"');
    expect(renderPolicyDecision({ ...decision('REQUIRE_APPROVAL'), reasonCode: 'APPROVAL_REQUIRED' })).toContain('class="status pending"');
    expect(renderPolicyDecision(decision('DENY'))).toContain('class="status failed"');
  });

  it('says whether Jev was consulted, with its decision, risk and confidence or the fallback reason', () => {
    const advised = (advisor: Record<string, unknown>) => renderPolicyDecision({ ...decision('REQUIRE_APPROVAL'), reasonCode: 'ADVISOR_ESCALATED', advisor: { ...decision('ALLOW').advisor, required: true, ...advisor } });
    const consulted = advised({ consulted: true, effect: 'escalate', decisionId: 'dec_123', risk: 0.82, confidence: 0.9, fallback: 'require_approval' });
    expect(consulted).toContain('Jev consulted: escalated to a human (risk 0.82, confidence 0.9)');
    expect(consulted).toContain('dec_123');
    expect(advised({ effect: 'escalate', decisionId: 'dec_9', fallbackReason: 'rate_limited', fallback: 'deny' })).toContain('Jev not consulted (rate limited), falls back to Deny');
    expect(advised({ fallbackReason: 'unconfigured', fallback: 'require_approval' })).toContain('Jev not consulted (no TypeSafe key)');
    // A CI or dependency change always waits for a human, so the deny fallback is not shown for it.
    const sensitive = advised({ effect: 'escalate', fallbackReason: 'sensitive_paths', fallback: 'deny' });
    expect(sensitive).toContain('Jev not consulted (CI or dependency files always need approval)');
    expect(sensitive).not.toContain('falls back to');
    expect(advised({})).toContain('Required before the action runs');
    expect(renderPolicyDecision(decision('ALLOW'))).toContain('<dt>Advisor</dt><dd>Not required</dd>');
  });

  it('renders the advisor settings in both editors, the effective policy and the inheritance table', () => {
    const page = (scope: 'global' | 'project', document: unknown, extra: Record<string, unknown> = {}) => renderAgentPolicyPage({
      status: 'ready', scope, mode: 'form', document, head: null, effective: { ...effective, advisor: { enabled: true, riskThreshold: 0.4, minConfidence: 0.8, fallback: 'deny' } },
      history: { revisions: [], headRevisionId: null, nextBeforeVersion: null }, ...extra
    });
    const global = page('global', { ...DEFAULT_GLOBAL_EXECUTION_POLICY, advisor: { enabled: true, riskThreshold: 0.4, minConfidence: 0.8, fallback: 'deny' } });
    expect(global).toContain('<legend>Execution-risk advisor</legend>');
    expect(global).toMatch(/name="advisor-enabled" value="on" checked/u);
    expect(global).toContain('name="advisor-riskThreshold" inputmode="decimal" value="0.4"');
    expect(global).toContain('<option value="deny" selected>Deny</option>');
    expect(global).toContain('On: escalates at risk 0.4 or above, needs confidence 0.8, otherwise Deny');
    // A global policy without an advisor block shows the defaults, unticked.
    const unset = page('global', DEFAULT_GLOBAL_EXECUTION_POLICY);
    expect(unset).toMatch(/name="advisor-enabled" value="on">/u);
    expect(unset).toContain('name="advisor-minConfidence" inputmode="decimal" value="0.7"');
    const projectDocument = { version: 1, advisor: { enabled: false } };
    const project = page('project', projectDocument, {
      projectId: PROJECT, savedDocument: projectDocument,
      globalDocument: { ...DEFAULT_GLOBAL_EXECUTION_POLICY, advisor: { enabled: true, riskThreshold: 0.4, minConfidence: 0.8, fallback: 'deny' } }
    });
    expect(project).toContain('<option value="off" selected>Turn off for this project</option>');
    expect(project).toContain('name="advisor-riskThreshold" inputmode="decimal" value="" placeholder="Inherit"');
    expect(project).toContain('<tr><th scope="row">Advisor</th><td>On</td><td>Off</td><td>On</td></tr>');
    expect(project).toContain('<tr><th scope="row">Advisor fallback</th><td>Deny</td><td><span class="policy-muted">inherit</span></td><td>Deny</td></tr>');
  });

  it('separates refused widenings from weakenings that need confirmation', () => {
    const refused = renderPolicyValidation({ valid: false, errors: [], widenings: ['scope.repositories adds *'], weakenings: [], changes: [], effective: null });
    expect(refused).toContain('refused');
    expect(refused).toContain('Widens the global policy');
    const weaker = renderPolicyValidation({ valid: true, errors: [], widenings: [], weakenings: ['edit is no longer hard-denied'], changes: [], effective });
    expect(weaker).toContain('weakens');
    expect(weaker).toContain('edit is no longer hard-denied');
  });

  it('shows the off switch instead of an editor while the feature is disabled', () => {
    const markup = renderAgentPolicyPage({ status: 'disabled' });
    expect(markup).toContain('AGENT_POLICIES_ENABLED=true');
    expect(markup).toContain('refuses every policy operation');
    expect(markup).not.toContain('policy-form');
  });

  it('shows no effective permissions for an orphaned project', () => {
    const markup = renderAgentPolicyPage({
      status: 'ready', scope: 'project', projectId: PROJECT, projectState: 'unknown', mode: 'form', document: { version: 1 }, head: revision(1, REVISION, { version: 1 }),
      effective: null, globalDocument: DEFAULT_GLOBAL_EXECUTION_POLICY, savedDocument: { version: 1 }, history: { revisions: [], headRevisionId: null, nextBeforeVersion: null }
    });
    expect(markup).toContain('every agent action for it is denied');
    expect(markup).not.toContain('Saved effective policy');
    expect(markup).not.toContain('policy-inheritance');
  });

  it('says when the project list is truncated', () => {
    const page = (projectsTruncated: boolean) => renderAgentPolicyPage({
      status: 'ready', scope: 'global', mode: 'form', document: DEFAULT_GLOBAL_EXECUTION_POLICY, head: null, effective,
      history: { revisions: [], headRevisionId: null, nextBeforeVersion: null },
      overview: { projects: [{ projectId: PROJECT, head: { version: 1 }, orphaned: false }], projectsTruncated }
    });
    expect(page(true)).toContain('most recently changed project policies');
    expect(page(false)).not.toContain('most recently changed project policies');
  });
});

/** A root that hands the controller form doubles carrying the values the owner "typed". */
class Root extends FakeElement {
  forms: Record<string, FakeElement & { values?: Values }> = {};
  querySelector(selector: string) { return this.forms[selector.replace('#', '')] ?? null; }
}

function form(id: string, values: Values) {
  const element = Object.assign(new FakeElement(), { id, values });
  (element as unknown as { querySelector: () => FakeElement }).querySelector = () => new FakeElement();
  return element;
}

const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

describe('agent policy editor controller', () => {
  let root: Root;
  let api: ReturnType<typeof vi.fn>;
  let confirm: ReturnType<typeof vi.fn>;
  let weakenings: string[];
  let digest: string;
  let putStatus: number[];
  let deferred: Array<() => void>;
  let unreviewable: boolean;

  beforeEach(() => {
    unreviewable = false;
    vi.stubGlobal('FormData', class { constructor(element: { values: Values }) { return element.values; } });
    root = new Root();
    weakenings = [];
    digest = 'a'.repeat(64);
    putStatus = [];
    deferred = [];
    confirm = vi.fn();
    const stored = revision(1, REVISION, DEFAULT_GLOBAL_EXECUTION_POLICY);
    api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === '/agent-policies/global' && !init) {
        return { data: { scope: 'global', projectId: null, projectState: null, head: stored, global: { revision: stored, document: DEFAULT_GLOBAL_EXECUTION_POLICY, source: 'stored' }, effective } };
      }
      if (path === '/agent-policies/global/history') return { data: { revisions: [stored, revision(0, OLDER, DEFAULT_GLOBAL_EXECUTION_POLICY)], headRevisionId: REVISION, nextBeforeVersion: null } };
      if (path === '/agent-policies') return { data: { global: null, projects: [], defaultGlobal: DEFAULT_GLOBAL_EXECUTION_POLICY } };
      if (path === '/agent-policies/global/validate') {
        if (unreviewable) return { data: { valid: false, errors: ['too many weakenings; save it in smaller steps'], widenings: [], weakenings, changes: [], effective, weakeningDigest: null } };
        return { data: { valid: true, errors: [], widenings: [], weakenings, changes: [], effective, weakeningDigest: weakenings.length ? digest : null } };
      }
      if (path === `/agent-policies/revisions/${OLDER}` && !init) return { data: { revision: revision(0, OLDER, DEFAULT_GLOBAL_EXECUTION_POLICY) } };
      if (path === `/agent-policies/revisions/${OLDER}/rollback`) return { data: { head: stored, weakenings } };
      if (path === '/agent-policies/global' && init?.method === 'PUT') {
        const status = putStatus.shift();
        if (status) throw Object.assign(new Error('The policy changed.'), { status, code: status === 409 ? 'conflict' : 'confirmation_required' });
        return { data: { head: stored, weakenings } };
      }
      if (path === '/agent-policies/simulate') return { data: { decision: decision('ALLOW'), effective } };
      throw new Error(`unexpected ${path}`);
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function mount() {
    const editor = createAgentPolicyEditor({ root, insert: (target: FakeElement, markup: string) => { target.innerHTML = markup; }, api, confirm, scope: 'global', defer: (task: () => void) => { deferred.push(task); } });
    await editor.load();
    return editor;
  }
  const submit = (id: string, fields: Record<string, string | string[]>) => {
    const element = form(id, new Values(fields));
    root.forms['policy-form'] = id === 'policy-form' ? element : root.forms['policy-form'] ?? form('policy-form', new Values({ ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), note: '' }));
    root.dispatch('submit', { target: element, preventDefault: vi.fn() });
  };
  const puts = () => api.mock.calls.filter(([, init]) => init?.method === 'PUT');

  it('loads the saved policy, its history and the effective preview', async () => {
    await mount();
    expect(root.innerHTML).toContain('Global policy');
    expect(root.innerHTML).toContain('Effective policy preview');
    expect(root.innerHTML).toContain('Roll back to v0');
  });

  it('saves a non-weakening change without asking, with the head version as the CAS token', async () => {
    await mount();
    submit('policy-form', { ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), note: 'tighten' });
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(JSON.parse(puts()[0][1].body)).toMatchObject({ expectedVersion: 1, confirmWeakening: false, note: 'tighten' });
  });

  it('asks before saving a weaker policy and only then sends the confirmation flag', async () => {
    weakenings = ['edit is now allowed'];
    await mount();
    submit('policy-form', { ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), allowedActionClasses: ['read', 'edit'], note: '' });
    await flush();
    expect(puts()).toHaveLength(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].target).toContain('edit is now allowed');
    await confirm.mock.calls[0][0].action();
    await flush();
    expect(JSON.parse(puts()[0][1].body)).toMatchObject({ confirmWeakening: true, weakeningDigest: digest });
  });

  it('asks again with the current weakenings when the runner answers 428', async () => {
    weakenings = ['edit is now allowed'];
    putStatus = [428];
    await mount();
    submit('policy-form', { ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), allowedActionClasses: ['read', 'edit'], note: '' });
    await flush();
    // Another save moved the head: the runner refuses the stale confirmation.
    weakenings = ['edit is now allowed', 'budget.maxConcurrentRuns: 1 becomes 2'];
    digest = 'b'.repeat(64);
    await confirm.mock.calls[0][0].action();
    await flush();
    expect(root.innerHTML).toContain('The weakenings changed after you reviewed them');
    // The fresh review opens once the first dialog has closed, listing the current weakenings.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);
    deferred[0]?.();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0].target).toContain('budget.maxConcurrentRuns: 1 becomes 2');
    await confirm.mock.calls[1][0].action();
    await flush();
    expect(puts()).toHaveLength(2);
    expect(JSON.parse(puts()[1][1].body)).toMatchObject({ confirmWeakening: true, weakeningDigest: 'b'.repeat(64) });
    expect(root.innerHTML).toContain('Saved.');
  });

  const rollbackButton = () => ({ dataset: { policyAction: 'rollback', revisionId: OLDER, version: '0' }, closest() { return this; } });
  const validations = () => api.mock.calls.filter(([path]) => path === '/agent-policies/global/validate').map(([, init]) => JSON.parse(init.body));

  it('previews a rollback with the rollback intent and confirms it with that digest', async () => {
    weakenings = ['edit is now allowed'];
    await mount();
    const button = rollbackButton();
    root.dispatch('click', { target: button });
    await flush();
    expect(validations().at(-1)).toMatchObject({ intent: 'rollback' });
    expect(confirm.mock.calls[0][0].target).toContain('edit is now allowed');
    await confirm.mock.calls[0][0].action();
    await flush();
    const call = api.mock.calls.find(([path]) => path === `/agent-policies/revisions/${OLDER}/rollback`);
    expect(JSON.parse(call![1].body)).toMatchObject({ confirmWeakening: true, weakeningDigest: digest });
  });

  it('explains instead of asking when the weakenings are too many to show in full', async () => {
    weakenings = ['edit is now allowed'];
    unreviewable = true;
    await mount();
    root.dispatch('click', { target: rollbackButton() });
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(root.innerHTML).toContain('smaller steps');
  });

  it('keeps the draft and explains a concurrent save', async () => {
    putStatus = [409];
    const editor = await mount();
    submit('policy-form', { ...globalFields(DEFAULT_GLOBAL_EXECUTION_POLICY), hardDeny: ['network'], note: '' });
    await flush();
    expect(editor.view.document.hardDeny).toEqual(['network']);
    expect(root.innerHTML).toContain('Someone saved this policy while you were editing');
  });

  it('simulates through the runner evaluator, with the unsaved draft only when asked', async () => {
    await mount();
    submit('policy-simulate-form', { actionClass: 'edit', repository: 'acme/widgets', useDraft: 'on' });
    await flush();
    const call = api.mock.calls.find(([path]) => path === '/agent-policies/simulate');
    const body = JSON.parse(call![1].body);
    expect(body.action).toEqual({ version: 1, actionClass: 'edit', repository: 'acme/widgets' });
    expect(body.draft.scope).toBe('global');
    expect(GlobalExecutionPolicySchema.parse(body.draft.document)).toEqual(DEFAULT_GLOBAL_EXECUTION_POLICY);
    expect(root.innerHTML).toContain('class="status active"');
  });

  it('shows the disabled notice when the runner reports the feature off', async () => {
    api.mockImplementation(async () => { throw Object.assign(new Error('off'), { status: 503, code: 'feature_disabled' }); });
    await mount();
    expect(root.innerHTML).toContain('AGENT_POLICIES_ENABLED=true');
  });
});
