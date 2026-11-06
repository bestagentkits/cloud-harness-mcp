/**
 * Realistic BFF projections for the Skills page (`apps/api/src/dashboard-response.ts`:
 * `skillKeys`, `skillRevisionKeys`, `skillSetKeys`, `skillImportJobKeys`, `skillCatalogKeys`).
 * Identifiers follow the runner's opaque id pattern so the page's validators accept them.
 */
export const SKILL_DEPLOY = 'sk_deploy0000000000000000001';
export const SKILL_DOCS = 'sk_docs000000000000000000002';
export const SKILL_OLD = 'sk_legacy00000000000000000003';
export const REV_DEPLOY_2 = 'skrev_deploy00000000000000002';
export const REV_DEPLOY_1 = 'skrev_deploy00000000000000001';
export const REV_DOCS_1 = 'skrev_docs0000000000000000001';
export const SET_RELEASE = 'skset_release000000000000000001';
export const IMPORT_JOB = 'skjob_import00000000000000000001';

export const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

export const skills = [
  {
    id: SKILL_DEPLOY, slug: 'deploy-checklist', displayName: 'Deploy checklist', description: 'Release steps for the API.',
    kind: 'owner', provider: 'custom', currentRevisionId: REV_DEPLOY_2, state: 'enabled', tags: ['ops', 'release'],
    generation: 3, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-19T09:00:00.000Z', version: '1.2.0'
  },
  {
    id: SKILL_DOCS, slug: 'docs-writer', displayName: 'Docs writer', description: '', kind: 'registry', provider: 'skills-sh',
    sourceRef: 'acme/docs-skills', currentRevisionId: REV_DOCS_1, state: 'disabled', tags: ['docs'], generation: 2,
    createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-10-10T09:00:00.000Z'
  },
  {
    id: SKILL_OLD, slug: 'legacy-lint', displayName: 'Legacy lint', kind: 'owner', provider: 'git', currentRevisionId: 'skrev_legacy0000000000000001',
    state: 'archived', tags: [], generation: 4, createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-03-01T09:00:00.000Z'
  }
];

export const skillsBody = { data: { skills } };
export const emptySkills = { data: { skills: [] } };
export const hostileSkills = { data: { skills: [{ ...skills[0], slug: HOSTILE, displayName: HOSTILE, description: HOSTILE, provider: HOSTILE, kind: HOSTILE, tags: [HOSTILE] }] } };

export const deployRevisions = {
  data: {
    revisions: [
      { id: REV_DEPLOY_2, skillSourceId: SKILL_DEPLOY, parentRevisionId: REV_DEPLOY_1, origin: 'edit', hasExecutableAssets: false, createdAt: '2026-10-19T09:00:00.000Z', version: '1.2.0' },
      { id: REV_DEPLOY_1, skillSourceId: SKILL_DEPLOY, origin: 'edit', hasExecutableAssets: false, createdAt: '2026-10-01T10:00:00.000Z', version: '1.1.0' }
    ]
  }
};

export const deployUsage = {
  data: {
    sets: [{ skillSetId: SET_RELEASE, name: 'Release kit' }],
    liveWorkspaces: [{ workspaceId: 'ws_live000000000000000000001', status: 'ACTIVE', name: 'deploy-checklist', revisionId: REV_DEPLOY_2 }]
  }
};

export const deployDiff = { data: { id: REV_DEPLOY_1, skillSourceId: SKILL_DEPLOY, diff: '--- a/SKILL.md\n+++ b/SKILL.md\n-Run the canary.\n+Run the canary twice.' } };

export const skillSets = { data: { sets: [{ id: SET_RELEASE, name: 'Release kit', description: 'Everything a release needs.', generation: 2, createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z' }] } };
export const releaseSet = {
  data: {
    id: SET_RELEASE, name: 'Release kit', description: 'Everything a release needs.', generation: 2,
    items: [{ skillSetId: SET_RELEASE, ordinal: 0, skillSourceId: SKILL_DEPLOY, revisionId: REV_DEPLOY_2, name: 'deploy-checklist' }]
  }
};

export const registry = {
  data: {
    entries: [{ id: 'cat_1', provider: 'skills-sh', slug: 'acme/docs-skills', displayName: 'Acme docs skills', cacheState: 'cached', pinnedCommit: 'a'.repeat(40), skillCount: 4, lockState: 'locked' }],
    presets: [{ id: 'preset_core', name: 'Core toolkit', description: 'The default skills for new owners.', defaultRevision: 'v1', installable: true }]
  }
};

export const searchResults = {
  data: {
    local: [skills[1]],
    providers: [{ provider: 'local', status: 'ok', count: 1 }, { provider: 'skills-sh', status: 'ok', count: 1 }, { provider: 'skillx', status: 'unavailable', warning: 'SkillX did not answer in time.', count: 0 }],
    results: [{ provider: 'skills-sh', reference: 'acme/review-skills', name: 'Code review', description: 'Review a pull request.', installs: 120 }]
  }
};

export function importJob(state: string, extra: Record<string, unknown> = {}) {
  return { data: { id: IMPORT_JOB, sourceKind: 'skills-sh', sourceRef: 'acme/review-skills', state, updatedAt: 1_760_000_000_000, ...extra } };
}
