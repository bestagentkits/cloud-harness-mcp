import type { NextFunction, Response, Router } from 'express';
import {
  AgentPoliciesRunnerDataSchemas,
  AgentPoliciesRunnerRequestSchema,
  type AgentPoliciesRunnerErrorCode,
  type AgentPoliciesRunnerOperation,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { withPathIds } from './dashboard-path-ids.js';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';

const ERROR_STATUS: Record<AgentPoliciesRunnerErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_WIDENS: 422,
  CONFIRMATION_REQUIRED: 428,
  RESOURCE_EXHAUSTED: 429,
  FEATURE_DISABLED: 503,
  UNAVAILABLE: 503,
  INTERNAL: 503
};

const jsonObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
/** Only a single string query value is forwarded; anything else becomes null and fails the runner schema. */
const queryValue = (value: unknown): unknown => (value === undefined || value === '' ? undefined : typeof value === 'string' ? value : null);
const queryNumber = (value: unknown): unknown => {
  const text = queryValue(value);
  return typeof text === 'string' && /^\d{1,9}$/u.test(text) ? Number(text) : text;
};
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const historyQuery = (request: DashboardRequest) => defined({ beforeVersion: queryNumber(request.query.beforeVersion), limit: queryNumber(request.query.limit) });

/**
 * Owner Dashboard routes for agent execution policies (`/api/v1/agent-policies`). The session decides
 * the principal; the route decides scope and project from the path, after the body, so a body field
 * cannot redirect a write, and a body that repeats a path id with a different value is refused. Every request is validated against the full runner schema before it is
 * forwarded, and mutations pass the Dashboard Origin and CSRF checks like every other write.
 */
export function registerAgentPolicyRoutes(
  router: Router,
  runner: DashboardRunnerClient,
  principal: (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined
): void {
  const base = '/api/v1/agent-policies';
  router.get(base, endpoint('policy_overview', () => ({})));
  router.get(`${base}/global`, endpoint('policy_get', () => ({ scope: 'global' })));
  router.put(`${base}/global`, endpoint('policy_put', (request) => ({ ...jsonObject(request.body), scope: 'global' })));
  router.post(`${base}/global/validate`, endpoint('policy_validate', (request) => ({ ...jsonObject(request.body), scope: 'global' })));
  router.get(`${base}/global/history`, endpoint('policy_history', (request) => ({ ...historyQuery(request), scope: 'global' })));
  router.get(`${base}/projects/:projectId`, endpoint('policy_get', (request) => ({ scope: 'project', projectId: request.params.projectId })));
  router.put(`${base}/projects/:projectId`, endpoint('policy_put', (request) => ({ ...withPathIds(request.body, { projectId: request.params.projectId }), scope: 'project' })));
  router.delete(`${base}/projects/:projectId`, endpoint('policy_delete', (request) => withPathIds(request.body, { projectId: request.params.projectId })));
  router.post(`${base}/projects/:projectId/validate`, endpoint('policy_validate', (request) => ({ ...withPathIds(request.body, { projectId: request.params.projectId }), scope: 'project' })));
  router.get(`${base}/projects/:projectId/history`, endpoint('policy_history', (request) => ({ ...historyQuery(request), scope: 'project', projectId: request.params.projectId })));
  router.get(`${base}/revisions/:revisionId`, endpoint('policy_revision_get', (request) => ({ revisionId: request.params.revisionId })));
  router.post(`${base}/revisions/:revisionId/rollback`, endpoint('policy_rollback', (request) => withPathIds(request.body, { revisionId: request.params.revisionId })));
  router.get(`${base}/diff`, endpoint('policy_diff', (request) => defined({ fromRevisionId: queryValue(request.query.from), toRevisionId: queryValue(request.query.to) })));
  router.post(`${base}/simulate`, endpoint('policy_simulate', (request) => jsonObject(request.body)));

  function endpoint<O extends AgentPoliciesRunnerOperation>(operation: O, input: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        if (!runner.callAgentPolicies) {
          response.status(503).json({ error: 'unavailable', message: 'Agent policies are not available.' });
          return;
        }
        const parsed = AgentPoliciesRunnerRequestSchema.safeParse({ version: 1, principal: selected, operation, input: input(request) });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 2 ? `${issue.path.slice(2).join('.')}: ` : '';
          response.status(400).json({ error: 'invalid_request', message: `${where}${issue?.message ?? 'The request could not be processed.'}`.slice(0, 500) });
          return;
        }
        const result = await runner.callAgentPolicies(parsed.data);
        if (!result.ok) {
          const status = ERROR_STATUS[result.error.code];
          const generic = status === 503 && result.error.code !== 'FEATURE_DISABLED';
          response.status(status).json({
            error: result.error.code.toLowerCase(),
            message: generic ? 'Agent policies are temporarily unavailable.' : result.error.message,
            ...(result.error.details && !generic ? { details: result.error.details } : {})
          });
          return;
        }
        const data = AgentPoliciesRunnerDataSchemas[operation].safeParse(result.data);
        if (!data.success) {
          response.status(503).json({ error: 'unavailable', message: 'Agent policies are temporarily unavailable.' });
          return;
        }
        response.json({ data: data.data });
      } catch (error) { next(error); }
    };
  }
}
