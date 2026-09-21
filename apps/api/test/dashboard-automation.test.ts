import { describe, expect, it } from 'vitest';
import {
  HOOK_LIFECYCLE, groupHooksByLifecycle, renderAutomationPanel, renderDeployPanel, renderHookPipeline,
  renderHooks, renderWorkspaceSkills
} from '../dashboard/dashboard-render.js';

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
    expect(markup).toContain('id="hook-run-form"');
    expect(markup).toContain('this page runs only what is already active');
    expect(renderHooks([])).toContain('No hooks run at this stage.');
  });

  it('lists workspace skills with a guarded run form rather than a bare run button', () => {
    const markup = renderWorkspaceSkills([{ name: 'typescript', tier: 'owner', description: 'TS guidance', sha256: 'a'.repeat(64) }]);
    expect(markup).toContain('typescript');
    expect(markup).toContain('TS guidance');
    expect(markup).toContain('id="skill-run-form"');
    expect(markup).toContain('id="skill-run-script"');
    expect(markup).toContain('Nothing runs unless you name it here');
    expect(renderWorkspaceSkills([])).toContain('No skills are resolved for this workspace.');
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
    const panel = renderAutomationPanel({ skills: [{ name: 'typescript' }], hooks: [hook()] });
    expect(panel).toContain('id="skills-heading"');
    expect(panel).toContain('id="hooks-heading"');
    expect(panel).toContain('Workspace automation');
  });
});
