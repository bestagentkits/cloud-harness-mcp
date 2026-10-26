/** Realistic BFF projections for the Workspaces list and the workspace cockpit. */

export const WORKSPACE_ID = 'ws_cockpitcockpitcock01';
export const CLOSED_ID = 'ws_closedclosedclosed01';
export const TASK_ID = 'task_build_01';
export const SESSION_ID = 'sess_review_01';

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const agoMinutes = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const activeWorkspace = {
  workspaceId: WORKSPACE_ID,
  repositoryUrl: 'https://github.com/acme/rocket.git',
  ref: 'main',
  status: 'ACTIVE',
  networkProfile: 'dependency-access',
  createdAt: agoMinutes(90),
  lastActivityAt: agoMinutes(3),
  expiresAt: inHours(5),
  canRenewLease: true,
  availableActions: ['workspace_lease_renew', 'workspace_context', 'workspace_close']
};

export const closedWorkspace = {
  workspaceId: CLOSED_ID,
  repositoryUrl: 'https://github.com/acme/legacy-site.git',
  status: 'CLOSED',
  networkProfile: 'network-none',
  createdAt: agoMinutes(600),
  lastActivityAt: agoMinutes(400),
  expiresAt: agoMinutes(300),
  availableActions: []
};

export const workspacesList = {
  data: {
    workspaces: [
      activeWorkspace,
      { ...activeWorkspace, workspaceId: 'ws_soonsoonsoonsoonsoo01', repositoryUrl: 'https://github.com/acme/billing.git', expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), lastActivityAt: agoMinutes(30) },
      closedWorkspace
    ]
  }
};

export const contextProjection = {
  data: { branch: 'feature/launch', capabilities: { git: true, tests: true, deploy: false }, manifest: { itemCount: 12, truncated: false } }
};

export const runtimeProjection = {
  data: {
    tasks: [
      { id: TASK_ID, name: 'npm run build', status: 'running', exitCode: null, dependsOn: [], startedAt: Date.now() - 12_000, finishedAt: null },
      { id: 'task_test_01', name: 'npm test', status: 'succeeded', exitCode: 0, dependsOn: [TASK_ID], startedAt: Date.now() - 90_000, finishedAt: Date.now() - 60_000 }
    ],
    sessions: [{ id: SESSION_ID, name: 'review', status: 'running' }],
    volatile: true
  }
};

export const taskStatus = {
  data: { task: { id: TASK_ID, status: 'running', exitCode: null, dependsOn: [], output: 'vite v6 building for production...\n<b>not markup</b>' } },
  truncated: true,
  cursor: 'c_2'
};

export const taskStatusNext = { data: { task: { id: TASK_ID, status: 'succeeded', exitCode: 0, dependsOn: [], output: 'built in 4.2s' } }, truncated: false };

export const sessionIo = { data: { output: '$ git status\nOn branch main', truncated: false } };

export const workspaceAgents = {
  data: {
    agents: [
      { agentId: 'agent_cockpit_01', workspaceId: WORKSPACE_ID, status: 'RUNNING', provider: 'claude', createdAt: agoMinutes(10), usage: { costMicros: 250_000 }, budget: { maxCostMicros: 1_000_000 } }
    ]
  }
};

export const workspaceActivity = {
  data: {
    events: [
      { at: agoMinutes(2), category: 'tasks', status: 'running', actor: 'agent_cockpit_01', summary: 'npm run build started', durable: false },
      { at: agoMinutes(40), category: 'audit', status: 'recorded', actor: 'owner', summary: 'Workspace lease renewed', durable: true }
    ]
  }
};
