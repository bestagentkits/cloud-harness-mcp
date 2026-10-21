import { describe, expect, it } from 'vitest';
import {
  activeOverrides, initialOpenWorkspaceDraft, launchBlocked, launchIntentOf, openWorkspaceRequest, parseOpenWorkspaceDraft, repositoryError,
  restorableRepositoryUrl, serializeOpenWorkspaceDraft, skillPreviewOf, skillSetsOf, toolkitsOf
} from './open-workspace-model';

const SET = `skset_${'a'.repeat(20)}`;
const REV_A = `skrev_${'a'.repeat(20)}`;
const REV_B = `skrev_${'b'.repeat(20)}`;
const draft = (patch = {}) => ({ ...initialOpenWorkspaceDraft(), open: true, repositoryUrl: 'https://github.com/org/repo', ...patch });

describe('open workspace draft restore', () => {
  it('never stores a URL that carries credentials, a query or a fragment', () => {
    expect(restorableRepositoryUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(restorableRepositoryUrl('https://user:token@github.com/org/repo')).toBe('');
    expect(restorableRepositoryUrl('https://github.com/org/repo?token=x')).toBe('');
    expect(restorableRepositoryUrl('http://github.com/org/repo')).toBe('');
    expect(serializeOpenWorkspaceDraft(draft({ repositoryUrl: 'https://u:p@host/r' }))).toMatchObject({ repositoryUrl: '' });
  });

  it('parses only allowlisted fields and values', () => {
    const parsed = parseOpenWorkspaceDraft({
      open: true, step: 'review', repositoryUrl: 'https://github.com/org/repo', networkProfile: 'bridge', secret: 'x',
      skillSetIds: [SET, SET, '../x'], skillOverrides: { lint: REV_A, 'bad name': REV_B }, presets: ['obra/superpowers', 'evil/kit'], agentkits: ['engineer', 'other'],
      launch: { key: 'not a key', intent: '{}' }
    });
    expect(parsed).toEqual({
      open: true, step: 'review', repositoryUrl: 'https://github.com/org/repo', ref: '', networkProfile: 'dependency-access',
      skillSetIds: [SET], skillOverrides: { lint: REV_A }, presets: ['obra/superpowers'], agentkits: ['engineer']
    });
    const key = 'c3f2b1a0-0000-4000-8000-000000000000';
    expect(parseOpenWorkspaceDraft({ launch: { key, intent: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })?.launch).toEqual({ key, intent: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    // A stored intent is only ever a digest; a raw request (which could hold a URL) is dropped.
    expect(parseOpenWorkspaceDraft({ launch: { key, intent: '{"repositoryUrl":"https://h/r?token=x"}' } })?.launch).toBeUndefined();
    expect(parseOpenWorkspaceDraft([])).toBeUndefined();
  });

  it('checks the repository URL before the runner does', () => {
    expect(repositoryError('')).toMatch(/Enter/);
    expect(repositoryError('git@github.com:org/repo')).toMatch(/valid URL|HTTPS/);
    expect(repositoryError('http://github.com/org/repo')).toMatch(/HTTPS/);
    expect(repositoryError('https://u:p@github.com/org/repo')).toMatch(/credentials/);
    expect(repositoryError('https://github.com/org/repo.git?private_token=x')).toMatch(/query and fragment/);
    expect(repositoryError('https://github.com/org/repo#x')).toMatch(/query and fragment/);
    expect(repositoryError('https://github.com/org/repo')).toBeUndefined();
  });
});

describe('open workspace launch intent', () => {
  it('is a stable SHA-256 digest that never contains the request', async () => {
    const request = { repositoryUrl: 'https://github.com/org/repo', ref: 'main' };
    const intent = await launchIntentOf(request);
    expect(intent).toMatch(/^[a-f0-9]{64}$/);
    expect(await launchIntentOf({ ...request })).toBe(intent);
    expect(await launchIntentOf({ ...request, ref: 'dev' })).not.toBe(intent);
    expect(intent).not.toContain('github');
  });
});

describe('open workspace request', () => {
  const sets = skillSetsOf({ sets: [{ id: SET, name: 'Core', generation: 4 }, { id: 'skset_nogen', name: 'Old' }] });
  const preview = skillPreviewOf({ resolved: [{}, {}], excluded: [], conflicts: [{ name: 'lint', candidates: [{ revisionId: REV_A, tier: 'library' }, { revisionId: REV_B, tier: 'set' }] }] });
  const catalog = toolkitsOf({ toolkits: [{ id: 'obra/superpowers', name: 'Superpowers' }, { id: 'evil/kit' }], licensedKits: [{ kitId: 'engineer', name: 'Engineer', defaultChannel: 'beta', available: true, credentialReady: false }] });

  it('reads sets, preview and the toolkit catalog', () => {
    expect(sets).toEqual([{ id: SET, name: 'Core', description: '', generation: 4 }, { id: 'skset_nogen', name: 'Old', description: '', generation: 0 }]);
    expect(preview.resolved).toBe(2);
    expect(catalog.presets.map((preset) => preset.id)).toEqual(['obra/superpowers']);
    expect(catalog.licensed[0]).toMatchObject({ kitId: 'engineer', channel: 'beta', ready: false });
  });

  it('blocks launch until every conflict has an override that names one of its candidates', () => {
    expect(launchBlocked(draft(), preview.conflicts)).toBe(true);
    expect(launchBlocked(draft({ skillOverrides: { lint: `skrev_${'c'.repeat(20)}` } }), preview.conflicts)).toBe(true);
    expect(launchBlocked(draft({ skillOverrides: { lint: REV_B } }), preview.conflicts)).toBe(false);
    expect(activeOverrides(draft({ skillOverrides: { lint: REV_B, gone: REV_A } }), preview.conflicts)).toEqual({ lint: REV_B });
  });

  it('fences each set by its generation and sends only owner-scoped, ready toolkits', () => {
    const request = openWorkspaceRequest(
      draft({ ref: ' main ', skillSetIds: [SET, 'skset_nogen'], skillOverrides: { lint: REV_B }, presets: ['obra/superpowers'], agentkits: ['engineer'] }),
      sets, preview.conflicts, catalog.licensed
    );
    expect(request).toEqual({
      repositoryUrl: 'https://github.com/org/repo', ref: 'main', networkProfile: 'dependency-access',
      skillSets: [{ skillSetId: SET, expectedGeneration: 4 }], skillOverrides: { lint: REV_B },
      toolkits: [{ kind: 'preset', id: 'obra/superpowers', scope: 'owner' }]
    });
    expect(openWorkspaceRequest(draft(), [], [], [])).not.toHaveProperty('ref');
  });
});
