import {
  AUTOMATION_TOOL_LIMITS,
  AutomationsRunnerDataSchemas,
  AutomationsRunnerRequestSchema,
  ToolResultSchema,
  type AutomationToolSpec,
  type AutomationsRunnerErrorCode,
  type AutomationsRunnerRequest,
  type AutomationsRunnerResponse,
  type ErrorCode,
  type RunnerPrincipalSelector,
  type ToolResult
} from '@cloud-harness/contracts';

/**
 * Owner automation management over MCP. Each tool calls one owner-scoped operation of the runner's
 * automations channel for the session principal; webhook ingest is never one of them. Inputs are
 * checked against the tool schema by the MCP server, then again against the channel schema here.
 */

export interface AutomationsBackend {
  /** The authenticated session principal; absent means every call answers AUTHENTICATION_FAILED. */
  readonly principal?: RunnerPrincipalSelector | undefined;
  /** Scopes the session was granted. */
  readonly scopes: readonly string[];
  /** The API's own `AUTOMATIONS_ENABLED`; the runner applies its own flag as well. */
  readonly enabled: boolean;
  callAutomations(request: AutomationsRunnerRequest, signal?: AbortSignal): Promise<AutomationsRunnerResponse>;
}

type Input = Record<string, unknown>;

const DISABLED_MESSAGE = 'Automations are disabled on this instance';

const failure = (code: ErrorCode, message: string, retryable = false): ToolResult =>
  ({ ok: false, message, error: { code, message, retryable }, truncated: false });

const success = (message: string, data: unknown, truncated = false): ToolResult => ({ ok: true, message, data, truncated });

const RUNNER_ERRORS: Record<AutomationsRunnerErrorCode, { code: ErrorCode; retryable: boolean }> = {
  INVALID_INPUT: { code: 'INVALID_INPUT', retryable: false },
  // Only webhook ingest answers UNAUTHORIZED; a management call never should.
  UNAUTHORIZED: { code: 'FORBIDDEN', retryable: false },
  NOT_FOUND: { code: 'NOT_FOUND', retryable: false },
  CONFLICT: { code: 'CONFLICT', retryable: false },
  RESOURCE_EXHAUSTED: { code: 'LIMIT_EXCEEDED', retryable: false },
  UNAVAILABLE: { code: 'UNAVAILABLE', retryable: true },
  INTERNAL: { code: 'INTERNAL_ERROR', retryable: true }
};

function runnerFailure(error: { code: AutomationsRunnerErrorCode; message: string }): ToolResult {
  const mapped = RUNNER_ERRORS[error.code];
  if (error.code === 'UNAVAILABLE' && error.message.toLowerCase().startsWith('automations are disabled')) {
    return failure('UNAVAILABLE', DISABLED_MESSAGE);
  }
  if (error.code === 'CONFLICT') return failure('CONFLICT', `${error.message}; re-read the rule with automation_rules_list and retry with its generation`);
  if (mapped.retryable) return failure(mapped.code, 'Automations are temporarily unavailable', true);
  if (error.code === 'UNAUTHORIZED') return failure(mapped.code, 'You cannot manage this automation');
  return failure(mapped.code, error.message);
}

/** The channel request for a tool. MCP-created rules are always saved disabled. */
function channelInput(spec: AutomationToolSpec, input: Input): Input {
  switch (spec.name) {
    case 'automation_rules_list': return input.connectionId === undefined ? {} : { connectionId: input.connectionId };
    case 'automation_rule_create': return { connectionId: input.connectionId, name: input.name, match: input.match, action: input.action, enabled: false };
    case 'automation_rule_disable': return { id: input.ruleId, expectedGeneration: input.expectedGeneration, enabled: false };
    // One more than asked shows whether the list was cut.
    case 'automation_runs_list': return { ...pick(input, ['ruleId', 'state']), limit: Number(input.limit) + 1 };
    case 'automation_run_get': return { id: input.runId };
    case 'automation_run_cancel': return { id: input.runId, ...pick(input, ['reason']) };
  }
}

function pick(input: Input, keys: string[]): Input {
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** At most `limit` items whose serialized size stays within the list bound. */
function boundedList<T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  let bytes = 2;
  for (const item of items.slice(0, limit)) {
    bytes += serializedBytes(item) + 1;
    if (bytes > AUTOMATION_TOOL_LIMITS.maxListBytes) break;
    kept.push(item);
  }
  return { items: kept, truncated: kept.length < items.length };
}

/** Shapes the runner's validated data into the tool result. Only rule and run fields ever leave here. */
function toolResult(spec: AutomationToolSpec, input: Input, data: unknown): ToolResult {
  const limit = Number(input.limit);
  switch (spec.operation) {
    case 'rules_list': {
      const { rules } = AutomationsRunnerDataSchemas.rules_list.parse(data);
      const page = boundedList(rules, limit);
      return success(`${page.items.length} automation rule(s)`, { rules: page.items }, page.truncated);
    }
    case 'rule_create': {
      const { rule } = AutomationsRunnerDataSchemas.rule_create.parse(data);
      return success(`Created automation rule ${rule.id} (disabled; the owner enables it on the Dashboard)`, { rule });
    }
    case 'rule_update': {
      const { rule } = AutomationsRunnerDataSchemas.rule_update.parse(data);
      return success(`Disabled automation rule ${rule.id}`, { rule });
    }
    case 'workflows_list': {
      const { workflows } = AutomationsRunnerDataSchemas.workflows_list.parse(data);
      const page = boundedList(workflows, limit);
      return success(`${page.items.length} automation run(s)`, { runs: page.items }, page.truncated);
    }
    case 'workflow_get': {
      const { workflow, result, transitions } = AutomationsRunnerDataSchemas.workflow_get.parse(data);
      return success(`Automation run ${workflow.id} is ${workflow.state}`, { run: workflow, result, transitions });
    }
    case 'workflow_cancel': {
      const { workflow } = AutomationsRunnerDataSchemas.workflow_cancel.parse(data);
      return success(`Automation run ${workflow.id} is ${workflow.state}`, { run: workflow });
    }
    default:
      throw new Error('unsupported automation tool');
  }
}

export async function callAutomationTool(backend: AutomationsBackend, spec: AutomationToolSpec, input: Input, signal?: AbortSignal): Promise<ToolResult> {
  const principal = backend.principal;
  if (!principal) return failure('AUTHENTICATION_FAILED', 'Authentication context unavailable');
  if (!backend.scopes.includes(spec.requiredScope)) {
    return failure('FORBIDDEN', `${spec.name} needs the ${spec.requiredScope} scope, which this session was not granted`);
  }
  if (!backend.enabled) return failure('UNAVAILABLE', DISABLED_MESSAGE);
  const request = AutomationsRunnerRequestSchema.safeParse({
    version: 1, principal, operation: spec.operation, input: channelInput(spec, input)
  });
  if (!request.success) return failure('INVALID_INPUT', request.error.issues[0]?.message.slice(0, 500) ?? 'Invalid automation request');
  let response: AutomationsRunnerResponse;
  try {
    response = await backend.callAutomations(request.data, signal);
  } catch {
    return failure('UNAVAILABLE', 'Automations are temporarily unavailable', true);
  }
  if (!response.ok) return runnerFailure(response.error);
  try {
    return ToolResultSchema.parse(toolResult(spec, input, response.data));
  } catch {
    // Strict data schemas refuse any field outside the rule and run summaries.
    return failure('UNAVAILABLE', 'Automations are temporarily unavailable', true);
  }
}
