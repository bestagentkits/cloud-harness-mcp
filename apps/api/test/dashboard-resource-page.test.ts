import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderApiKeyIndex, renderArtifactIndex, renderCopyChip, renderFormDialog, renderGitHubActions,
  renderGlobalSecrets, renderMcpActions, renderModelsActions, renderPrimaryAction, renderProjectIndex,
  renderResourcePage, renderSecondaryAction
} from '../dashboard/dashboard-render.js';
import { dashboardNavigationPath } from '../dashboard/dashboard.js';

describe('shared resource-page layout', () => {
  it('states one primary action and at most one secondary action per page', () => {
    const models = renderModelsActions();
    expect((models.match(/accent-btn/g) ?? [])).toHaveLength(1);
    expect(models).toContain('id="open-add-profile-btn"');
    expect(models).toContain('id="open-add-credential-btn"');
    expect((renderMcpActions().match(/accent-btn/g) ?? [])).toHaveLength(1);
    expect(renderGitHubActions({})).toContain('disabled');
    expect(renderGitHubActions({ installation: { installationId: '101' } })).toContain('id="reconcile-github"');

    expect(renderPrimaryAction({ id: 'p', label: 'Primary', dialogId: 'd' })).toContain('data-dialog="d"');
    expect(renderPrimaryAction({ id: 'p', label: 'Primary', dialogId: 'd' })).toContain('accent-btn');
    expect(renderSecondaryAction({ id: 's', label: 'Secondary', dialogId: 'd' })).not.toContain('accent-btn');
    // A page action without a dialog is a plain trigger the loader binds itself.
    expect(renderPrimaryAction({ id: 'p', label: 'Primary' })).not.toContain('data-dialog');
  });

  it('keeps creation flows inside dialogs instead of the page body', () => {
    const pages: Array<[string, string, string]> = [
      [renderProjectIndex([]), 'create-project-dialog', 'create-project-form'],
      [renderGlobalSecrets([], { ready: true }), 'create-global-secret-dialog', 'create-global-secret-form'],
      [renderArtifactIndex([], undefined), 'snapshot-dialog', 'snapshot-form'],
      [renderApiKeyIndex({ keys: [], readiness: { ready: true } }), 'create-api-key-dialog', 'create-api-key-form']
    ];
    for (const [markup, dialogId, formId] of pages) {
      expect(markup, dialogId).toContain(`<dialog id="${dialogId}"`);
      expect(markup.indexOf(`id="${formId}"`), formId).toBeGreaterThan(markup.indexOf(`<dialog id="${dialogId}"`));
    }
  });

  it('labels and describes every dialog, with a cancel affordance and live status', () => {
    const dialog = renderFormDialog({
      id: 'x-dialog', title: 'X', description: 'Describe the effect.',
      formId: 'x-form', body: '<label for="x">Name</label><input id="x" name="n">',
      submitLabel: 'Save', submitId: 'x-submit'
    });
    expect(dialog).toContain('aria-labelledby="x-dialog-title"');
    expect(dialog).toContain('aria-describedby="x-dialog-description"');
    expect(dialog).toContain('<h2 id="x-dialog-title">X</h2>');
    expect(dialog).toContain('data-dialog-close');
    expect(dialog).toContain('id="x-submit"');
    expect(dialog).toContain('aria-live="polite"');
  });

  it('keeps identifiers as copy affordances rather than page labels', () => {
    const chip = renderCopyChip({ value: 'prj_abc"onerror', label: 'Project ID' });
    expect(chip).toContain('data-copy="prj_abc&quot;onerror"');
    expect(chip).toContain('aria-label="Copy Project ID"');
    // The raw quote is escaped, so the attribute cannot be broken out of.
    expect(chip).not.toContain('data-copy="prj_abc"');
    expect(chip).toContain('&quot;onerror');
    expect(renderProjectIndex([{ id: 'prj_abcdefghijklmnopqrst', name: 'Alpha', generation: 1 }])).toContain('data-copy="prj_abcdefghijklmnopqrst"');
  });

  it('refuses a navigation target outside the dashboard allowlist', () => {
    expect(dashboardNavigationPath('/dashboard/workspaces')).toBe('/dashboard/workspaces');
    expect(dashboardNavigationPath('/dashboard?q=1')).toBe('/dashboard?q=1');
    expect(dashboardNavigationPath('/dashboard/workspaces/ws_1/files?path=.')).toBe('/dashboard/workspaces/ws_1/files?path=.');
    for (const refused of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', '/other', '', undefined, null]) {
      expect(dashboardNavigationPath(refused), String(refused)).toBe('/dashboard');
    }
  });

  it('binds dialog opening by delegation so the shell action slot is covered', () => {
    // Browser QA caught the original shape of this: the openers were bound only on
    // `#content`, so the primary action — which lives in the shell header — opened
    // nothing. Delegation on the document is what makes the action slot work, and
    // this assertion fails if a future change goes back to a root-scoped query.
    const script = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
    expect(script).toContain("document.addEventListener('click', (event) => {");
    expect(script).toContain("event.target?.closest?.('[data-dialog]')");
    expect(script).not.toContain('bindDialogOpeners');
    expect(script).toContain("bindCopyAffordances(document.querySelector('#page-actions'))");
  });

  it('renders an empty state that names the next useful action', () => {
    expect(renderResourcePage({ body: '<p>x</p>' })).toContain('<div class="resource-body">');
    expect(renderResourcePage({ filters: '<input>', body: 'x' })).toContain('<div class="resource-filters">');
    expect(renderProjectIndex([])).toContain('No projects yet');
    expect(renderArtifactIndex([], undefined)).toContain('No retained snapshots yet');
    expect(renderApiKeyIndex({ keys: [], readiness: { ready: true } })).toContain('No API keys yet');
    expect(renderGlobalSecrets([])).toContain('No global secrets yet');
  });
});
