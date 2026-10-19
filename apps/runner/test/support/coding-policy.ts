import type { DatabaseSync } from 'node:sqlite';
import type { GlobalExecutionPolicy, RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { AgentPolicyService } from '../../src/agent-governance/policy-service.js';
import { initializeAutomationSchema } from '../../src/automation-schema.js';

/**
 * Shared fixtures for coding-broker tests: a global policy that permits the coding loop for one
 * repository, the owner confirmation flow that saving it needs, and a coding workflow row.
 */

export const CODING_REPOSITORY = 'acme/widgets';
export const CODING_PROJECT = `prj_${'c'.repeat(32)}`;
export const VERIFY_COMMAND = 'node test/run.mjs';

/** Allows read, edit, test, local commits, `agent/` branches and pull requests; packages stay outside the ceiling. */
export const CODING_GLOBAL_POLICY: GlobalExecutionPolicy = {
  version: 1,
  hardDeny: [],
  mandatoryApproval: [],
  allowedActionClasses: ['read', 'edit', 'test', 'vcs_local', 'publish_branch', 'open_pr'],
  defaults: {
    read: { effect: 'allow', delegable: false },
    edit: { effect: 'allow', delegable: false },
    test: { effect: 'allow', delegable: false },
    vcs_local: { effect: 'allow', delegable: false },
    publish_branch: { effect: 'allow', delegable: false },
    open_pr: { effect: 'allow', delegable: false }
  },
  scope: {
    repositories: [CODING_REPOSITORY], branchPrefixes: ['agent/'], pathScopes: ['src/', 'test/'],
    commands: [VERIFY_COMMAND], packages: [], registries: [], networkHosts: []
  },
  budget: { maxCostMicrosPerRun: 1_000_000, maxInputTokensPerRun: 100_000, maxOutputTokensPerRun: 10_000, maxRunSeconds: 3_600, maxConcurrentRuns: 2 },
  approval: { ttlSeconds: 3_600, approverRoles: ['owner'] }
};

export type PolicyServiceSetup = {
  service: AgentPolicyService;
  /** Saves a global policy through validation and the owner's weakening confirmation. */
  saveGlobal(document: GlobalExecutionPolicy): void;
  /** Saves a project policy for the coding project. */
  saveProject(document: Record<string, unknown>): void;
};

export function createPolicyService(
  database: DatabaseSync,
  resolvePrincipal: (selector: RunnerPrincipalSelector) => string,
  owner: RunnerPrincipalSelector,
  projects: ReadonlySet<string> = new Set([CODING_PROJECT])
): PolicyServiceSetup {
  const service = new AgentPolicyService({
    database,
    enabled: true,
    resolvePrincipal,
    projectState: (_principalId, projectId) => (projects.has(projectId) ? 'active' : 'unknown'),
    activeProjectIds: () => new Set(projects),
    audit: () => undefined
  });
  const data = <T>(operation: string, input: Record<string, unknown>): T => {
    const response = service.execute({ version: 1, principal: owner, operation, input });
    if (!response.ok) throw new Error(`${operation} failed: ${response.error.code} ${response.error.message}`);
    return response.data as T;
  };
  const save = (scope: 'global' | 'project', document: unknown, projectId?: string) => {
    const target = projectId ? { projectId } : {};
    const current = data<{ head: { version: number } | null }>('policy_get', { scope, ...target });
    const { weakeningDigest } = data<{ weakeningDigest: string | null }>('policy_validate', { scope, document, ...target });
    data('policy_put', {
      scope, document, ...target, expectedVersion: current.head?.version ?? 0,
      ...(weakeningDigest ? { confirmWeakening: true, weakeningDigest } : {})
    });
  };
  return {
    service,
    saveGlobal: (document) => save('global', document),
    saveProject: (document) => save('project', document, CODING_PROJECT)
  };
}

export type CodingWorkflowFields = {
  id: string;
  ownerId: string;
  state?: string;
  workspaceId?: string | null;
  workspaceGeneration?: number | null;
  agentId?: string | null;
  agentGeneration?: number | null;
  projectId?: string;
  repository?: string;
  resourceNumber?: number;
  codingPhase?: string;
  baseOid?: string | null;
  policyRevisionJson?: string | null;
  createdAt?: number;
  coding?: Record<string, unknown>;
  ruleId?: string;
};

/** Inserts a coding workflow row as the automation engine would have admitted it. */
export function insertCodingWorkflow(database: DatabaseSync, fields: CodingWorkflowFields): void {
  initializeAutomationSchema(database);
  const now = fields.createdAt ?? Date.now();
  const repository = fields.repository ?? CODING_REPOSITORY;
  const snapshot = {
    name: 'Fix issues',
    match: { repository, events: ['issues'], label: 'claude' },
    action: {
      profileId: 'default', instructions: 'Fix the issue.', publishComment: false,
      coding: fields.coding ?? { projectId: fields.projectId ?? CODING_PROJECT, verifyCommand: VERIFY_COMMAND, baseBranch: 'main' }
    }
  };
  database.prepare(`INSERT INTO automation_workflows (id, owner_id, rule_id, rule_generation, rule_snapshot_json, connection_id, delivery_id,
    event_type, repository, resource_number, resource_url, resource_key, label, prompt, state, workspace_id, agent_id, publish_state,
    next_attempt_at, created_at, updated_at, project_id, coding_phase, coding_started_at, workspace_generation, agent_generation, base_oid,
    policy_revision_json)
    VALUES (?, ?, ?, 1, ?, 'con_1', ?, 'github.issue.label_added', ?, ?, ?, ?, 'claude', 'prompt', ?, ?, ?, 'NONE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    fields.id, fields.ownerId, fields.ruleId ?? `rule_${fields.id}`, JSON.stringify(snapshot), `delivery_${fields.id}`, repository,
    fields.resourceNumber ?? 7, `https://github.com/${repository}/issues/${fields.resourceNumber ?? 7}`, `${repository}#${fields.resourceNumber ?? 7}`,
    fields.state ?? 'RUNNING', fields.workspaceId === undefined ? `ws_${'w'.repeat(24)}` : fields.workspaceId, fields.agentId ?? null, now, now, now,
    fields.projectId ?? CODING_PROJECT, fields.codingPhase ?? 'AGENT', now,
    fields.workspaceGeneration === undefined ? 1 : fields.workspaceGeneration, fields.agentGeneration ?? null, fields.baseOid ?? null,
    fields.policyRevisionJson ?? null
  );
}
