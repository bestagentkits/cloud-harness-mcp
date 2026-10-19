import { DEFAULT_GLOBAL_EXECUTION_POLICY, GlobalExecutionPolicySchema, ProjectExecutionPolicySchema } from '@cloud-harness/contracts';
import type { PolicySnapshot } from './gate-evaluator.js';
import { AGENT_GOVERNANCE_PORTS_VERSION, type PolicyResolver } from './ports.js';
import type { PolicyStore } from './policy-store.js';

/** Whether Cloud Harness knows an ACTIVE project with this id for the principal. */
export type ProjectStateLookup = (principalId: string, projectId: string) => 'active' | 'unknown';

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * Loads the current heads for (principal, project) into a frozen snapshot. The project id must come
 * from an owner-authored binding or the authenticated route, never from event payload text; the
 * lookup re-checks it against the metadata projects table on every resolve.
 */
export class StorePolicyResolver implements PolicyResolver {
  readonly contractVersion = AGENT_GOVERNANCE_PORTS_VERSION;

  constructor(private readonly store: PolicyStore, private readonly projectState: ProjectStateLookup) {}

  resolve(principalId: string, projectId: string | null): PolicySnapshot {
    const globalHead = this.store.head(principalId, 'global', null);
    const globalDocument = globalHead ? GlobalExecutionPolicySchema.parse(globalHead.document) : structuredClone(DEFAULT_GLOBAL_EXECUTION_POLICY);
    const snapshot: PolicySnapshot = {
      global: { revisionId: globalHead?.revisionId ?? null, document: globalDocument, source: globalHead ? 'stored' : 'default' },
      project: null
    };
    if (projectId !== null) {
      const projectHead = this.store.head(principalId, 'project', projectId);
      snapshot.project = {
        projectId,
        state: this.projectState(principalId, projectId),
        revisionId: projectHead?.revisionId ?? null,
        document: projectHead ? ProjectExecutionPolicySchema.parse(projectHead.document) : null,
        source: projectHead ? 'stored' : 'absent'
      };
    }
    return deepFreeze(snapshot);
  }
}
