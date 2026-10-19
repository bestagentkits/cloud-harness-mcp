import { describe, expect, it } from 'vitest';
import {
  AgentProxyOperationSchema,
  AutomationRuleActionSchema,
  AutomationsRunnerDataSchemas,
  AutomationsRunnerRequestSchema,
  BROKERED_ONLY_PROXY_OPERATIONS,
  CODING_PROXY_OPERATIONS,
  CodingActionOutcomeSchema,
  CodingActionReceiptSchema,
  CodingActionRequestSchema,
  CodingRuleActionSchema,
  CodingVerifyCommandSchema
} from '../src/index.js';

const PROJECT = `prj_${'c'.repeat(32)}`;
const WORKFLOW = `wfl_${'a'.repeat(32)}`;

describe('coding action contracts', () => {
  it('grants a coding agent only known proxy operations, deletion excluded', () => {
    for (const operation of CODING_PROXY_OPERATIONS) expect(AgentProxyOperationSchema.safeParse(operation).success).toBe(true);
    expect(CODING_PROXY_OPERATIONS).not.toContain('files_delete');
    for (const operation of BROKERED_ONLY_PROXY_OPERATIONS) expect(CODING_PROXY_OPERATIONS).toContain(operation);
  });

  it('accepts only argv-shaped verify commands', () => {
    expect(CodingVerifyCommandSchema.safeParse('npm test').success).toBe(true);
    expect(CodingVerifyCommandSchema.safeParse('npx vitest run --reporter=dot').success).toBe(true);
    for (const command of ['npm test && curl x', 'echo $HOME', 'a | b', 'a  b', ' npm test', 'npm `x`']) {
      expect(CodingVerifyCommandSchema.safeParse(command).success, command).toBe(false);
    }
  });

  it('requires an explicit, non-agent base branch and a project', () => {
    const base = { projectId: PROJECT, verifyCommand: 'npm test', baseBranch: 'main' };
    expect(CodingRuleActionSchema.parse(base)).toEqual(base);
    for (const baseBranch of ['', 'agent/x', '-main', 'a..b', 'main branch', 'main.lock', 'release/v1.lock', 'main/', 'a//b', 'main.', '.hidden', 'release/.x']) {
      expect(CodingRuleActionSchema.safeParse({ ...base, baseBranch }).success, baseBranch).toBe(false);
    }
    for (const baseBranch of ['develop', 'release/v1.2', 'feature/a-b_c']) {
      expect(CodingRuleActionSchema.safeParse({ ...base, baseBranch }).success, baseBranch).toBe(true);
    }
    expect(CodingRuleActionSchema.safeParse({ verifyCommand: 'npm test', baseBranch: 'main' }).success).toBe(false);
    expect(CodingRuleActionSchema.safeParse({ ...base, principalId: 'someone' }).success).toBe(false);
  });

  it('keeps the coding block optional on rule actions', () => {
    const action = { profileId: 'default', instructions: 'Fix it.' };
    expect(AutomationRuleActionSchema.parse(action).coding).toBeUndefined();
    expect(AutomationRuleActionSchema.parse({ ...action, coding: { projectId: PROJECT, verifyCommand: 'npm test', baseBranch: 'main' } }).coding?.baseBranch).toBe('main');
  });

  it('describes an action without principal, project or policy fields', () => {
    const request = {
      workflowId: WORKFLOW, origin: 'runner', step: 'push', idempotencyKey: `automation:${WORKFLOW}:push`,
      descriptor: { version: 1, actionClass: 'publish_branch', repository: 'acme/widgets', branch: 'agent/7-aaaaaaaa' }
    };
    expect(CodingActionRequestSchema.safeParse(request).success).toBe(true);
    expect(CodingActionRequestSchema.safeParse({ ...request, projectId: PROJECT }).success).toBe(false);
    expect(CodingActionRequestSchema.safeParse({ ...request, descriptor: { ...request.descriptor, principalId: 'x' } }).success).toBe(false);
  });

  it('validates receipts, including refusals decided before the gate', () => {
    const receipt = {
      actionId: `act_${'d'.repeat(32)}`, workflowId: WORKFLOW, origin: 'agent', step: 'exec_run', actionClass: 'test',
      repository: 'acme/widgets', branch: null, paths: [], command: null, decision: 'DENY', reasonCode: 'COMMAND_UNSUPPORTED',
      state: 'REJECTED', projectId: PROJECT, globalRevisionId: null, projectRevisionId: null, inputFingerprint: null,
      workspaceId: null, agentId: null, traceId: null, spanId: null, outcome: {}, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z'
    };
    expect(CodingActionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(CodingActionReceiptSchema.safeParse({ ...receipt, reasonCode: 'PATH_OUT_OF_SCOPE' }).success).toBe(true);
    expect(CodingActionReceiptSchema.safeParse({ ...receipt, reasonCode: 'MADE_UP' }).success).toBe(false);
    expect(CodingActionReceiptSchema.safeParse({ ...receipt, state: 'DONE' }).success).toBe(false);
  });

  it('describes an install by its package count and package-list digest', () => {
    const digest = 'f'.repeat(64);
    expect(CodingActionOutcomeSchema.parse({ exitCode: 0, packageCount: 2, packagesDigest: digest })).toEqual({ exitCode: 0, packageCount: 2, packagesDigest: digest });
    expect(CodingActionOutcomeSchema.safeParse({ packageCount: -1 }).success).toBe(false);
    expect(CodingActionOutcomeSchema.safeParse({ packagesDigest: 'xyz' }).success).toBe(false);
  });

  it('pages workflow receipts with an opaque cursor', () => {
    const request = { version: 1, principal: { kind: 'owner', ownerId: 'owner' }, operation: 'workflow_get', input: { id: WORKFLOW } };
    expect(AutomationsRunnerRequestSchema.safeParse(request).success).toBe(true);
    expect(AutomationsRunnerRequestSchema.safeParse({ ...request, input: { id: WORKFLOW, actionsCursor: 'MTc2MDgzMjAwMDAwMDoxMg' } }).success).toBe(true);
    for (const actionsCursor of ['', 'a b', 'x'.repeat(65), '../etc']) {
      expect(AutomationsRunnerRequestSchema.safeParse({ ...request, input: { id: WORKFLOW, actionsCursor } }).success, actionsCursor).toBe(false);
    }
    const data = AutomationsRunnerDataSchemas.workflow_get.shape;
    expect(data.actionsCursor.parse(undefined)).toBeNull();
    expect(data.actions.parse(undefined)).toEqual([]);
  });
});
