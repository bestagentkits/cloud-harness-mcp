import { describe, expect, it } from 'vitest';
import {
  HOOK_LIFECYCLE, groupHooksByLifecycle, renderAutomationPanel, renderDeployPanel, renderHookPipeline,
  renderHooks, renderSkillRunResult, renderWorkspaceSkills, skillRunApprovalPrompt
} from '../dashboard/dashboard-render.js';
import { skillApprovalRequest, skillRunFailure } from '../dashboard/dashboard.js';

const hook = (overrides: Record<string, unknown> = {}) => ({ name: 'format', events: ['pre_commit'], active: true, ...overrides });

describe('automation and deploy renderers', () => {
  it('groups hooks by the lifecycle event that runs them', () => {
    expect(HOOK_LIFECYCLE.map((event) => event.id)).toEqual(['on_workspace_open', 'post_checkout', 'pre_commit', 'post_commit', 'manual']);
    const groups = groupHooksByLifecycle([
      hook({ name: 'setup', events: ['on_workspace_open'] }),
      hook({ name: 'commit-format', events: ['pre_commit', 'manual'] }),
      // A hook that predates the `events` array carries a single `event` instead.
      { name: 'legacy', event: 'post_commit', active: true }
    ]);
    expect(groups.map((group) => group.hooks.length)).toEqual([1, 0, 1, 1, 1]);
    expect(groups[2].hooks[0].name).toBe('commit-format');
    expect(groups[1].hooks).toEqual([]);
  });

  it('renders the pipeline as ordered text stages with counts', () => {
    const pipeline = renderHookPipeline(groupHooksByLifecycle([hook({ events: ['pre_commit'] }), hook({ name: 'two', events: ['pre_commit'] })]));
    expect(pipeline).toContain('<ol class="hook-pipeline"');
    expect(pipeline).toContain('On workspace open');
    expect(pipeline).toContain('0 hook(s)');
    expect(pipeline).toContain('2 hook(s)');
    // Order is the run order, so the label order is asserted rather than assumed.
    expect(pipeline.indexOf('On workspace open')).toBeLessThan(pipeline.indexOf('After checkout'));
    expect(pipeline.indexOf('After checkout')).toBeLessThan(pipeline.indexOf('Before commit'));
  });

  it('keeps the text list beside the pipeline and states empty stages', () => {
    const markup = renderHooks([hook({ name: 'format', active: false, description: 'Runs the formatter' })]);
    expect(markup).toContain('id="hooks-pre_commit"');
    expect(markup).toContain('format');
    expect(markup).toContain('Inactive');
    expect(markup).toContain('Runs the formatter');
    expect(markup).toContain('No hooks run at this stage.');
    // Without the manifest digest a run could name, no form renders.
    expect(markup).not.toContain('id="hook-run-form"');
    expect(markup).toContain('No hook can run from this page.');
    expect(markup).toContain('it does not activate the hook');
    expect(renderHooks([])).toContain('No hooks run at this stage.');
  });

  it('runs one named hook from the manifest against the digest the page rendered', () => {
    const manifest = 'b'.repeat(64);
    // A manual run is independent of activation, so every named hook is a choice, active or not.
    const markup = renderHooks([hook({ name: 'format', active: true }), hook({ name: 'lint', active: false }), { events: ['manual'] }], manifest);
    expect(markup).toContain(`<form id="hook-run-form" class="stack-form" data-manifest-sha256="${manifest}">`);
    expect(markup).toContain('Run a hook from the repository manifest');
    expect(markup).toContain('<option value="format">format</option>');
    expect(markup).toContain('<option value="lint">lint</option>');
    expect(markup.match(/<option /g)).toHaveLength(2);
    // A name hooks_run would refuse is not offered.
    expect(renderHooks([hook({ name: 'run tests' })], manifest)).not.toContain('id="hook-run-form"');
    // Without a manifest digest there is nothing a run could name, so no form renders.
    expect(renderHooks([hook({ name: 'format' })])).not.toContain('id="hook-run-form"');
    expect(renderHooks([hook({ name: 'format' })], 'nope')).not.toContain('id="hook-run-form"');
  });

  it('badges a hook only with the activation state the runner reported', () => {
    const active = renderHooks([hook({ name: 'lint', active: true })]);
    expect(active).toContain('<span class="status active">Active</span>');
    expect(active).not.toContain('Inactive');

    const inactive = renderHooks([hook({ name: 'lint', active: false })]);
    expect(inactive).toContain('<span class="status">Inactive</span>');
    expect(inactive).not.toContain('>Active<');

    // A hook without an `active` field is not claimed to be active or inactive.
    const unreported = renderHooks([{ name: 'lint', events: ['pre_commit'] }]);
    expect(unreported).toContain('<strong>lint</strong>');
    expect(unreported).not.toContain('>Active<');
    expect(unreported).not.toContain('Inactive');
  });

  it('lists workspace skills with a guarded run form rather than a bare run button', () => {
    const markup = renderWorkspaceSkills([{ name: 'typescript', tier: 'owner', description: 'TS guidance', contentSha256: 'a'.repeat(64) }]);
    expect(markup).toContain('typescript');
    expect(markup).toContain('TS guidance');
    expect(markup).toContain('id="skill-run-form"');
    expect(markup).toContain('id="skill-run-script"');
    expect(markup).toContain('<div id="skill-run-result"></div>');
    expect(markup).toContain('Nothing runs unless you name it here');
    expect(markup).toContain('each run asks for your approval first');
    // The run names the listed revision, so the option carries the digest the runner verifies.
    expect(markup).toContain(`<option value="typescript" data-content-sha256="${'a'.repeat(64)}">typescript</option>`);
    expect(renderWorkspaceSkills([])).toContain('No skills are resolved for this workspace.');
  });

  it('offers no run form for a skill without a verifiable digest', () => {
    const markup = renderWorkspaceSkills([{ name: 'unverified' }, { name: 'short', contentSha256: 'abc' }]);
    expect(markup).toContain('unverified');
    expect(markup).not.toContain('id="skill-run-form"');
  });

  it('states what the owner approves before a skill run', () => {
    const prompt = skillRunApprovalPrompt({ name: 'demo', script: 'run.sh', contentSha256: 'b'.repeat(64), expiresAt: '2026-10-21T09:00:00.000Z' });
    expect(prompt.title).toBe('Approve and run this skill script?');
    expect(prompt.description).toContain('disposable helper container');
    expect(prompt.description).toContain('used by this one run');
    expect(prompt.description).toContain(new Date('2026-10-21T09:00:00.000Z').toLocaleTimeString());
    expect(prompt.description).not.toContain('<');
    expect(prompt.target).toBe(`demo / run.sh @ ${'b'.repeat(16)}`);
  });

  it('recognises only an approval request that names a grant', () => {
    const grant = { grantId: 'pvg_1', expiresAt: '2026-10-21T09:00:00.000Z' };
    expect(skillApprovalRequest({ code: 'privilege_approval_required', grantRequest: grant })).toEqual(grant);
    expect(skillApprovalRequest({ code: 'privilege_approval_required' })).toBeUndefined();
    expect(skillApprovalRequest({ code: 'conflict', grantRequest: grant })).toBeUndefined();
    expect(skillApprovalRequest(undefined)).toBeUndefined();
  });

  it('shows a skill run result with its exit code, isolation and escaped output', () => {
    const done = renderSkillRunResult({ output: '<b>ok</b>', exitCode: 0, executionMode: 'helper-container', truncated: true });
    expect(done).toContain('Script finished');
    expect(done).toContain('<dt>Exit code</dt><dd>0</dd>');
    expect(done).toContain('Disposable helper container');
    expect(done).toContain('&lt;b&gt;ok&lt;/b&gt;');
    expect(done).not.toContain('<b>ok</b>');
    expect(done).toContain('Output is truncated.');
    const failed = renderSkillRunResult({ exitCode: 3 }, { failed: true });
    expect(failed).toContain('Script exited with an error');
    expect(failed).toContain('<dd>3</dd>');
    expect(failed).toContain('No output.');
    expect(failed).not.toContain('truncated');
    expect(failed).not.toContain('Duration');
    expect(failed).not.toContain('Stopped by');
    expect(renderSkillRunResult({ exitCode: 1, signal: 'SIGTERM' }, { failed: true })).toContain('<dt>Stopped by</dt><dd>SIGTERM</dd>');
  });

  it('recognises only a script failure that carries its result', () => {
    const data = { output: 'boom', exitCode: 3 };
    expect(skillRunFailure({ code: 'execution_failed', data })).toEqual(data);
    expect(skillRunFailure({ code: 'execution_failed' })).toBeUndefined();
    expect(skillRunFailure({ code: 'internal_error', data })).toBeUndefined();
    expect(skillRunFailure(undefined)).toBeUndefined();
  });

  it('labels deployment risk, last result and failure detail', () => {
    const markup = renderDeployPanel([{ name: 'staging', cwd: 'deploy', lastResult: 'failed', durationMs: 1_500, error: 'exit 1' }, { name: 'prod', cwd: 'deploy' }]);
    expect(markup).toContain('Deployments run repository-defined commands');
    expect(markup).toContain('staging');
    expect(markup).toContain('class="accent-btn run-deployment"');
    expect(markup).toContain('data-deployment-name="staging"');
    expect(markup).toContain('failed');
    expect(markup).toContain('1500 ms');
    expect(markup).toContain('exit 1');
    // A target the runner never reported on says so instead of showing a zero.
    expect(markup).toContain('Not reported');
    expect(renderDeployPanel([])).toContain('No deployment targets are defined for this repository.');
  });

  it('composes the workspace automation panel', () => {
    const panel = renderAutomationPanel({ skills: [{ name: 'typescript' }], hooks: [hook()], manifestSha256: 'b'.repeat(64) });
    expect(panel).toContain('id="skills-heading"');
    expect(panel).toContain('id="hooks-heading"');
    expect(panel).toContain(`data-manifest-sha256="${'b'.repeat(64)}"`);
    expect(panel).toContain('Workspace automation');
  });
});
