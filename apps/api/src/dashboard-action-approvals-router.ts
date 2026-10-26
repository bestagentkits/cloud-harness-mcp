import type { NextFunction, Response, Router } from 'express';
import {
  AgentApprovalsRunnerDataSchemas,
  AgentApprovalsRunnerRequestSchema,
  type AgentApprovalsRunnerErrorCode,
  type AgentApprovalsRunnerOperation,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';

const ERROR_STATUS: Record<AgentApprovalsRunnerErrorCode, number> = {
  INVALID_INPUT: 400,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_FORBIDDEN: 403,
  APPROVAL_ALREADY_DECIDED: 409,
  APPROVAL_STALE: 409,
  APPROVAL_EXPIRED: 410,
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

/**
 * Owner Dashboard routes for approvals of held coding workflow steps (`/api/v1/agent-approvals`). The
 * session decides the principal, so an approval can only be read or decided by its owner; a decision
 * names the descriptor digest the owner reviewed and is accepted once. Every request is validated
 * against the full runner schema before it is forwarded, and the decision passes the Dashboard Origin
 * and CSRF checks like every other write.
 */
export function registerAgentApprovalRoutes(
  router: Router,
  runner: DashboardRunnerClient,
  principal: (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined
): void {
  router.get('/api/v1/agent-approvals', endpoint('approvals_list', (request) => defined({
    state: queryValue(request.query.state),
    limit: queryNumber(request.query.limit)
  })));
  router.get('/api/v1/agent-approvals/:approvalId', endpoint('approval_get', (request) => ({ approvalId: request.params.approvalId })));
  router.post('/api/v1/agent-approvals/:approvalId/decision', endpoint('approval_decide', (request) => {
    const body = jsonObject(request.body);
    return { approvalId: request.params.approvalId, decision: body.decision, expectedDigest: body.expectedDigest };
  }));

  function endpoint<O extends AgentApprovalsRunnerOperation>(operation: O, input: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        if (!runner.callAgentApprovals) {
          response.status(503).json({ error: 'unavailable', message: 'Agent approvals are not available.' });
          return;
        }
        const parsed = AgentApprovalsRunnerRequestSchema.safeParse({ version: 1, principal: selected, operation, input: input(request) });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 2 ? `${issue.path.slice(2).join('.')}: ` : '';
          response.status(400).json({ error: 'invalid_request', message: `${where}${issue?.message ?? 'The request could not be processed.'}`.slice(0, 500) });
          return;
        }
        const result = await runner.callAgentApprovals(parsed.data);
        if (!result.ok) {
          const status = ERROR_STATUS[result.error.code];
          const generic = status === 503 && result.error.code !== 'FEATURE_DISABLED';
          response.status(status).json({
            error: result.error.code.toLowerCase(),
            message: generic ? 'Agent approvals are temporarily unavailable.' : result.error.message
          });
          return;
        }
        const data = AgentApprovalsRunnerDataSchemas[operation].safeParse(result.data);
        if (!data.success) {
          response.status(503).json({ error: 'unavailable', message: 'Agent approvals are temporarily unavailable.' });
          return;
        }
        response.json({ data: data.data });
      } catch (error) { next(error); }
    };
  }
}
