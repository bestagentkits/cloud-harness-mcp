/** Realistic `/projects` and `/projects/:id/environments` projections (`metadataKeys`, `environmentKeys`). */
export const PROJECT_ID = `prj_${'a'.repeat(24)}`;
export const OTHER_PROJECT_ID = `prj_${'b'.repeat(24)}`;
export const ENVIRONMENT_ID = `env_${'c'.repeat(24)}`;
export const STAGING_ID = `env_${'d'.repeat(24)}`;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export const projectsList = {
  data: {
    projects: [
      { id: PROJECT_ID, name: 'Rocket', state: 'ACTIVE', generation: 2, createdAt: at(600), updatedAt: at(30), deletedAt: null },
      // A hostile name is data: it must render as text.
      { id: OTHER_PROJECT_ID, name: '<img src=x onerror=alert(1)>', state: 'ACTIVE', generation: 1, createdAt: at(900), updatedAt: at(800), deletedAt: null }
    ]
  },
  truncated: false
};

export const environmentsList = {
  data: {
    environments: [
      { id: ENVIRONMENT_ID, projectId: PROJECT_ID, name: 'Production', state: 'ACTIVE', generation: 3, createdAt: at(500), updatedAt: at(40), deletedAt: null },
      { id: STAGING_ID, projectId: PROJECT_ID, name: 'Staging', state: 'ACTIVE', generation: 1, createdAt: at(400), updatedAt: at(400), deletedAt: null }
    ]
  },
  truncated: false
};
