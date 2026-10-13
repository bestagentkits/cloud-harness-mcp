import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { RunnerConfigSchema, RunnerOperationSchema, TOOL_SCHEMA_BY_NAME, TOOL_SPECS } from '../src/index.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const schema = TOOL_SCHEMA_BY_NAME.bash;

describe('bash tool contract', () => {
  it('registers as a runner operation with exec_run-equivalent annotations', () => {
    expect(RunnerOperationSchema.options).toContain('bash');
    const spec = TOOL_SPECS.find(({ name }) => name === 'bash');
    const execRun = TOOL_SPECS.find(({ name }) => name === 'exec_run');
    expect(spec).toMatchObject({ title: 'Run bash command', readOnly: false, idempotent: false, openWorld: true });
    expect(spec?.destructive).toBe(execRun?.destructive);
    expect(spec?.description).toMatch(/exec_run/);
    expect(spec?.description).toMatch(/privileged/i);
  });

  it('defaults to the workspace target with exec_run bounds', () => {
    expect(schema.parse({ workspaceId, command: 'pwd' })).toEqual({
      workspaceId,
      command: 'pwd',
      target: 'workspace',
      cwd: '.',
      timeoutMs: 60_000,
      maxOutputBytes: 262_144,
      async: false
    });
    // workspaceId stays optional so the active workspace resolves it, exactly as for exec_run.
    expect(schema.parse({ command: 'pwd' })).toMatchObject({ target: 'workspace' });
    expect(schema.parse({ workspaceId, command: 'make', async: true, cwd: 'pkg' })).toMatchObject({ async: true, cwd: 'pkg' });
  });

  it('keeps the same command, timeout, and output bounds as exec_run', () => {
    expect(() => schema.parse({ workspaceId, command: '' })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'x'.repeat(32_769) })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'true', timeoutMs: 99 })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'true', timeoutMs: 300_001 })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'true', maxOutputBytes: 1_023 })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'true', maxOutputBytes: 1_048_577 })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'true', cwd: '../outside' })).toThrow();
  });

  it('accepts the toolbox target without a workspace and refuses workspace-only fields', () => {
    expect(schema.parse({ command: 'node --version', target: 'toolbox' })).toMatchObject({ target: 'toolbox', cwd: '.', async: false });
    expect(() => schema.parse({ workspaceId, command: 'true', target: 'toolbox' })).toThrow(/workspaceId is not allowed/);
    expect(() => schema.parse({ command: 'true', target: 'toolbox', cwd: 'src' })).toThrow(/cwd is only valid/);
    expect(() => schema.parse({ command: 'true', target: 'toolbox', async: true })).toThrow(/async is only valid/);
    expect(() => schema.parse({ command: 'true', target: 'host' })).toThrow();
  });

  it('has no privileged path and refuses approval fields instead of ignoring them', () => {
    const jsonSchema = z.toJSONSchema(schema, { io: 'input' });
    expect(jsonSchema.type).toBe('object');
    expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual(['async', 'command', 'cwd', 'maxOutputBytes', 'target', 'timeoutMs', 'workspaceId']);
    expect(() => schema.parse({ workspaceId, command: 'id', privileged: true })).toThrow();
    expect(() => schema.parse({ workspaceId, command: 'id', approvalGrantToken: 'grant' })).toThrow();
  });

  it('ships the toolbox gate off by default', () => {
    const runner = {
      serviceToken: 'runner-token-that-is-longer-than-32-characters', jobsRoot: '/jobs', stateDb: '/state/state.db',
      executorImage: 'executor:latest', allowedGitHosts: ['github.com']
    };
    expect(RunnerConfigSchema.parse(runner).packagesEnabled).toBe(false);
    expect(RunnerConfigSchema.parse({ ...runner, packagesEnabled: 'true' }).packagesEnabled).toBe(true);
    expect(RunnerConfigSchema.parse({ ...runner, packagesEnabled: 'yes' }).packagesEnabled).toBe(false);
  });
});
