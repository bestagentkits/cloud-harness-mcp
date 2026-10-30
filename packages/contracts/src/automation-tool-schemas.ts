import { z } from 'zod';
import {
  AutomationConnectionIdSchema,
  AutomationRuleActionSchema,
  AutomationRuleIdSchema,
  AutomationRuleMatchSchema,
  AutomationWorkflowIdSchema,
  AutomationWorkflowStateSchema,
  automationRuleProblem,
  type AutomationsRunnerOperation
} from './automations-api.js';
import type { ToolSpec } from './tool-schemas.js';

/**
 * MCP tools for owner automation management. Each tool maps onto one owner-scoped operation of the
 * API ⇄ runner automations channel; the principal always comes from the authenticated MCP session,
 * so no input names an owner. Webhook ingest is not reachable from here, and connections (which
 * carry webhook secrets and outbound credentials) are managed only on the Dashboard.
 */

export const AUTOMATION_TOOL_LIMITS = {
  /** Most rules or runs one list call returns. */
  maxListLimit: 100,
  /** Serialized bound on one list result; trailing items past it are dropped and `truncated` is set. */
  maxListBytes: 262_144
} as const;

/** The scope an authenticated MCP session needs for each kind of automation tool. */
export const AUTOMATION_TOOL_SCOPES = { read: 'workspace:read', write: 'workspace:write' } as const;

const listLimit = (fallback: number) => z.number().int().min(1).max(AUTOMATION_TOOL_LIMITS.maxListLimit).default(fallback);

const schemas = {
  automation_rules_list: z.object({
    connectionId: AutomationConnectionIdSchema.optional().describe('Only rules of this connection.'),
    limit: listLimit(50)
  }).strict(),
  automation_rule_create: z.object({
    connectionId: AutomationConnectionIdSchema.describe('The webhook connection whose deliveries the rule matches; its provider must equal match.provider.'),
    name: z.string().trim().min(1).max(100),
    match: AutomationRuleMatchSchema,
    action: AutomationRuleActionSchema
  }).strict().superRefine((input, context) => {
    const problem = automationRuleProblem(input.match, input.action);
    if (problem) context.addIssue({ code: 'custom', path: ['action', 'repository'], message: problem });
  }),
  automation_rule_disable: z.object({
    ruleId: AutomationRuleIdSchema,
    expectedGeneration: z.number().int().positive().describe('The rule generation from automation_rules_list; a moved generation returns CONFLICT.')
  }).strict(),
  automation_runs_list: z.object({
    ruleId: AutomationRuleIdSchema.optional().describe('Only runs of this rule.'),
    state: AutomationWorkflowStateSchema.optional(),
    limit: listLimit(20)
  }).strict(),
  automation_run_get: z.object({ runId: AutomationWorkflowIdSchema }).strict(),
  automation_run_cancel: z.object({
    runId: AutomationWorkflowIdSchema,
    reason: z.string().max(500).optional()
  }).strict()
};

export type AutomationToolName = keyof typeof schemas;

export type AutomationToolSpec = Omit<ToolSpec, 'name'> & {
  name: AutomationToolName;
  /** The automations-channel operation the tool calls. */
  operation: Exclude<AutomationsRunnerOperation, 'webhook_ingest'>;
  /** Scope the session must hold; the tool answers FORBIDDEN without it. */
  requiredScope: (typeof AUTOMATION_TOOL_SCOPES)[keyof typeof AUTOMATION_TOOL_SCOPES];
};

const DISABLED_NOTE = 'Off unless the operator sets AUTOMATIONS_ENABLED=true; otherwise every automation tool returns UNAVAILABLE.';

const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false, requiredScope: AUTOMATION_TOOL_SCOPES.read } as const;

export const AUTOMATION_TOOL_SPECS: AutomationToolSpec[] = [
  {
    name: 'automation_rules_list',
    operation: 'rules_list',
    title: 'List automation rules',
    description: 'List your webhook automation rules: what each one matches, the repository, profile, and instructions its read-only agent gets, whether it is enabled, and its generation (pass it as expectedGeneration to automation_rule_disable). Optional connectionId narrows the list; past limit or the size bound the result sets truncated. Connections, webhook secrets, and outbound credentials are never returned. ' + DISABLED_NOTE,
    inputSchema: schemas.automation_rules_list,
    ...read
  },
  {
    name: 'automation_rule_create',
    operation: 'rule_create',
    title: 'Create automation rule (disabled)',
    description: 'Create a webhook automation rule on one of your connections. Rules created over MCP are always saved DISABLED, whatever the input: the owner reviews and enables them on the Dashboard before any delivery can start a run. match is provider-specific (GitHub: repository, events, label; Linear: trigger label_added or state_changed; Jira: projectKey with label_added or status_changed; custom: event). GitHub rules check out match.repository and must leave action.repository unset; every other provider must pin action.repository. The triggered agent is read-only. ' + DISABLED_NOTE,
    inputSchema: schemas.automation_rule_create,
    readOnly: false, destructive: false, idempotent: false, openWorld: false, requiredScope: AUTOMATION_TOOL_SCOPES.write
  },
  {
    name: 'automation_rule_disable',
    operation: 'rule_update',
    title: 'Disable automation rule',
    description: 'Disable one of your automation rules so new deliveries no longer start runs; its queued runs are cancelled before they start. Needs the generation you last read (expectedGeneration from automation_rules_list); a moved generation returns CONFLICT, so re-read and retry. Disabling an already disabled rule still bumps its generation. Re-enabling is done by the owner on the Dashboard. ' + DISABLED_NOTE,
    inputSchema: schemas.automation_rule_disable,
    readOnly: false, destructive: true, idempotent: false, openWorld: false, requiredScope: AUTOMATION_TOOL_SCOPES.write
  },
  {
    name: 'automation_runs_list',
    operation: 'workflows_list',
    title: 'List automation runs',
    description: 'List your most recent automation runs, newest first, with the rule, event type, source reference, repository, state, workspace and agent ids, error code, comment publish state, and token and cost usage. Optional ruleId and state narrow the list; past limit or the size bound the result sets truncated. ' + DISABLED_NOTE,
    inputSchema: schemas.automation_runs_list,
    ...read
  },
  {
    name: 'automation_run_get',
    operation: 'workflow_get',
    title: 'Read automation run',
    description: 'Read one of your automation runs with its state transitions and, once it finished, the agent answer (bounded, untrusted model output). ' + DISABLED_NOTE,
    inputSchema: schemas.automation_run_get,
    ...read
  },
  {
    name: 'automation_run_cancel',
    operation: 'workflow_cancel',
    title: 'Cancel automation run',
    description: 'Cancel one of your queued, starting, running, or waiting (WAITING_FOR_HUMAN) automation runs; the result is the run in its CANCELLED state, and a waiting run\'s pending approval expires. Cancelling a finished run changes nothing and returns it as it is. Optional reason is recorded in the audit log. ' + DISABLED_NOTE,
    inputSchema: schemas.automation_run_cancel,
    readOnly: false, destructive: true, idempotent: true, openWorld: false, requiredScope: AUTOMATION_TOOL_SCOPES.write
  }
];

export const AUTOMATION_TOOL_SCHEMA_BY_NAME = schemas;
