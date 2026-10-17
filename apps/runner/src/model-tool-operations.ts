import {
  HarnessError,
  MODEL_TOOL_RESULT_SCHEMAS,
  type ModelProfileEscalation,
  type ModelToolOperation,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';
import type { DashboardControlService } from './dashboard-control-service.js';

/**
 * Runs a public model tool on the control service that serves the Dashboard, so
 * both channels share one catalog cache, one verification rate limit, and one
 * gateway sync. A runner without that service answers UNAVAILABLE.
 */
export async function executeModelToolOperation(
  controls: Pick<DashboardControlService, 'executeModelTool'> | undefined,
  principal: RunnerPrincipalSelector,
  operation: ModelToolOperation,
  input: Record<string, unknown>
): Promise<RunnerResponse> {
  if (!controls) throw new HarnessError('UNAVAILABLE', 'model tools are unavailable on this runner', 503, true);
  return await controls.executeModelTool(principal, operation, input);
}

/**
 * A model tool's success envelope. The data is parsed against the tool's strict
 * result schema first, so a field the schema does not list, such as key material,
 * fails the call instead of reaching the caller.
 */
export function modelToolResult(operation: ModelToolOperation, message: string, data: unknown): RunnerResponse {
  const parsed = MODEL_TOOL_RESULT_SCHEMAS[operation].safeParse(data);
  if (!parsed.success) {
    // The issue names a field, never a value, but the caller learns nothing from it.
    throw new HarnessError('INTERNAL_ERROR', `${operation} produced a result outside its contract`, 500, false);
  }
  return { ok: true, message, data: parsed.data, truncated: false };
}

/** Thrown by the escalation guard inside a save's transaction, which it rolls back. */
export class ProfileChangeRefusal extends Error {
  constructor(readonly escalations: readonly ModelProfileEscalation[]) {
    super('model profile change needs owner approval');
  }
}

const ESCALATION_TEXT: Record<ModelProfileEscalation, string> = {
  custom_upstream_unbound: 'a custom upstream URL that none of your profiles on this credential uses',
  limits_raised: 'a raised token or cost limit',
  price_lowered: 'a lower price that is not catalog-verified',
  price_unverified_for_new_route: 'override prices carried to another model or credential',
  proxy_operations_widened: 'proxy operations the current revision does not allow'
};

/**
 * The refusal an MCP caller receives for a change only the owner may make. It is
 * not retryable: the same call fails the same way until the owner acts on the
 * Dashboard.
 */
export function ownerApprovalRequired(action: 'create' | 'update' | 'verify', escalations: readonly ModelProfileEscalation[]): HarnessError {
  const what = action === 'verify' ? 'This connection check' : `This profile ${action}`;
  return new HarnessError(
    'OWNER_APPROVAL_REQUIRED',
    `${what} needs the owner's approval on the Dashboard Models page and was not applied: ${escalations.map((escalation) => `${escalation} (${ESCALATION_TEXT[escalation]})`).join('; ')}`,
    403,
    false,
    { resumeAction: 'dashboard:models' }
  );
}
