import { describe, expect, it } from 'vitest';
import {
  AgentProxyOperationSchema,
  AutomationRuleActionSchema,
  BROKERED_ONLY_PROXY_OPERATIONS,
  CODING_PROXY_OPERATIONS,
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
    for (const baseBranch of ['', 'agent/x', '-main', 'a..b', 'main branch']) {
      expect(CodingRuleActionSchema.safeParse({ ...base, baseBranch }).success, baseBranch).toBe(false);
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
});
