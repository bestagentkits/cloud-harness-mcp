import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AUTOMATION_TOOL_SCHEMA_BY_NAME,
  AUTOMATION_TOOL_SCOPES,
  AUTOMATION_TOOL_SPECS,
  AutomationsRunnerRequestSchema,
  TOOL_SPECS
} from '../src/index.js';

const CONNECTION_ID = `whc_${'a'.repeat(32)}`;
const createInput = {
  connectionId: CONNECTION_ID,
  name: 'Triage',
  match: { provider: 'linear', trigger: 'label_added', label: 'agent' },
  action: { repository: 'acme/widgets', profileId: 'reviewer', instructions: 'Summarize.' }
};

describe('automation tool contract', () => {
  it('names each tool once, apart from the workspace tools, on an owner channel operation', () => {
    const names = AUTOMATION_TOOL_SPECS.map((spec) => spec.name);
    expect(names).toEqual(['automation_rules_list', 'automation_rule_create', 'automation_rule_disable', 'automation_runs_list', 'automation_run_get', 'automation_run_cancel']);
    expect(names.filter((name) => TOOL_SPECS.some((spec) => spec.name === name))).toEqual([]);
    expect(Object.keys(AUTOMATION_TOOL_SCHEMA_BY_NAME).sort()).toEqual([...names].sort());
    const channelOperations = AutomationsRunnerRequestSchema.options.map((option) => option.shape.operation.value);
    for (const spec of AUTOMATION_TOOL_SPECS) {
      expect(channelOperations, spec.name).toContain(spec.operation);
      expect(spec.operation, spec.name).not.toBe('webhook_ingest');
      expect(spec.operation, spec.name).not.toMatch(/^connection/u);
    }
  });

  it('needs the write scope for every tool that changes state and the read scope otherwise', () => {
    for (const spec of AUTOMATION_TOOL_SPECS) {
      expect(spec.requiredScope, spec.name).toBe(spec.readOnly ? AUTOMATION_TOOL_SCOPES.read : AUTOMATION_TOOL_SCOPES.write);
      expect(spec.description, spec.name).toContain('AUTOMATIONS_ENABLED');
    }
    expect(AUTOMATION_TOOL_SPECS.find((spec) => spec.name === 'automation_rule_create')?.description).toMatch(/always saved DISABLED/u);
  });

  it('accepts no input that names a principal or enables a rule', () => {
    const create = AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_rule_create;
    expect(create.parse(createInput)).not.toHaveProperty('enabled');
    expect(create.safeParse({ ...createInput, enabled: true }).success).toBe(false);
    expect(create.safeParse({ ...createInput, principal: { kind: 'owner', ownerId: 'x' } }).success).toBe(false);
    expect(AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_rules_list.safeParse({ ownerId: 'x' }).success).toBe(false);
    expect(AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_rule_disable.safeParse({ ruleId: `arl_${'b'.repeat(32)}`, expectedGeneration: 1, enabled: true }).success).toBe(false);
    for (const spec of AUTOMATION_TOOL_SPECS) {
      const properties = Object.keys((z.toJSONSchema(spec.inputSchema, { io: 'input' }) as { properties?: object }).properties ?? {});
      expect(properties, spec.name).not.toEqual(expect.arrayContaining(['principal']));
      expect(properties, spec.name).not.toContain('enabled');
    }
  });

  it('keeps the owner-authored repository rule of the channel schema', () => {
    const create = AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_rule_create;
    const { repository: _repository, ...unpinned } = createInput.action;
    void _repository;
    expect(create.safeParse({ ...createInput, action: unpinned }).success).toBe(false);
    expect(create.safeParse({ ...createInput, match: { repository: 'acme/widgets', events: ['issues'], label: 'agent' } }).success).toBe(false);
  });

  it('bounds list limits', () => {
    expect(AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_runs_list.parse({})).toEqual({ limit: 20 });
    expect(AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_rules_list.parse({})).toEqual({ limit: 50 });
    expect(AUTOMATION_TOOL_SCHEMA_BY_NAME.automation_runs_list.safeParse({ limit: 101 }).success).toBe(false);
  });
});
