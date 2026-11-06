import { WORKSPACE_ID } from './workspaces';

// One retained artifact and one managed-package binding with history, shared by the page
// specs and the screenshot baselines.

export const ARTIFACT = { artifactId: 'art_page_01', logicalName: 'report.json', sha256: 'c'.repeat(64), sizeBytes: 512, workspaceId: WORKSPACE_ID, expiresAt: '2030-01-01T00:00:00.000Z', generation: 4 };

export const PACKAGES = {
  data: {
    enabled: true, approvalMode: 'required', ecosystems: ['npm'], lifecycleScripts: 'disabled',
    bindings: [{
      bindingId: 'pkb_tsx_01', name: 'tsx', ecosystem: 'npm', scope: 'owner', generation: 5, affectedWorkspaces: [WORKSPACE_ID],
      release: { releaseId: 'pkr_tsx_2', name: 'tsx', version: '4.1.0', status: 'VERIFIED', binaries: ['tsx'], source: { registry: 'npm' } },
      history: [
        { releaseId: 'pkr_tsx_2', version: '4.1.0', generation: 5, reason: 'apply', actor: 'dashboard', available: true },
        { releaseId: 'pkr_tsx_1', version: '4.0.0', generation: 4, reason: 'apply', actor: 'agent', available: true }
      ]
    }],
    releases: [{ releaseId: 'pkr_tsx_2', name: 'tsx', version: '4.1.0', status: 'VERIFIED' }],
    inFlight: [], recentApplies: [], pendingPlans: []
  }
};
