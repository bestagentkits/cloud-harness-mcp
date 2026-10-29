import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTOMATION_TOOL_SPECS, TOOL_SPECS, type RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { bindWorkspace, createCloudHarnessServerFactory, createWorkspaceBoundServerFactory } from '../src/mcp-server.js';
import type { RunnerClient } from '../src/runner-client.js';

/**
 * Clients decide auto-approval from these annotations: read-only tools may run without a prompt and
 * destructive ones always prompt. The Claude directory review also requires a title, a name of at
 * most 64 characters, and a description that states what the tool does without steering the model.
 * This pins those properties for every tool a remote client can list.
 */
const owner: RunnerPrincipalSelector = { kind: 'owner' } as RunnerPrincipalSelector;
const authInfo: AuthInfo = { token: 'opaque', clientId: 'client', scopes: [], extra: { principal: owner } };
const runner = {
  async call() { return { ok: true, message: 'ok', data: {}, truncated: false }; },
  async callInternal() { return { ok: true, message: 'ok', data: {}, truncated: false }; },
  async callAutomations() { return { ok: true, data: {} }; }
} as unknown as RunnerClient;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listTools(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotation-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return (await client.listTools()).tools;
}

/** Phrases that instruct the model instead of describing the tool. */
const STEERING = /ignore (all |any )?(previous|prior|other)|system prompt|you must always|always call|never call|do not (call|use) (any )?other tools|instead of (claude|the assistant)/i;

describe('MCP tool annotations', () => {
  it('gives every listed tool a title, a short name, consistent hints, and a descriptive description', async () => {
    const tools = await listTools(createCloudHarnessServerFactory(runner, undefined, { enabled: true })({ era: 'modern', authInfo } as never));
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_SPECS, ...AUTOMATION_TOOL_SPECS].map((spec) => spec.name));

    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(tool.title, tool.name).toMatch(/\S/);
      const hints = tool.annotations ?? {};
      expect(typeof hints.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof hints.destructiveHint, tool.name).toBe('boolean');
      expect(typeof hints.idempotentHint, tool.name).toBe('boolean');
      expect(typeof hints.openWorldHint, tool.name).toBe('boolean');
      // A read-only tool cannot also be destructive.
      if (hints.readOnlyHint) expect(hints.destructiveHint, tool.name).toBe(false);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
      expect(tool.description!.length, tool.name).toBeLessThanOrEqual(2_500);
      expect(tool.description, tool.name).not.toMatch(STEERING);
    }
  });

  it('annotates removal, overwrite, execution, and publication as destructive', async () => {
    const tools = await listTools(createCloudHarnessServerFactory(runner, undefined, { enabled: true })({ era: 'modern', authInfo } as never));
    const destructive = new Set(tools.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name));
    for (const name of [
      'workspace_close', 'workspace_recover', 'workspace_repo_remove', 'files_write', 'files_write_batch', 'files_apply_patch',
      'files_delete', 'files_move', 'exec_run', 'bash', 'tasks_run', 'shell_io', 'sessions_io', 'skills_run', 'hooks_run',
      'git_push', 'git_pull', 'git_merge', 'git_rebase', 'git_checkout', 'github_action', 'deployments_run', 'agent_spawn',
      'packages_remove', 'packages_rollback', 'artifacts_delete', 'artifacts_restore', 'memories_delete', 'knowledge_delete',
      'automation_rule_disable', 'automation_run_cancel', 'operation_cancel', 'tasks_cancel', 'agent_cancel'
    ]) expect(destructive.has(name), name).toBe(true);
  });

  it('marks only inspection tools read-only', async () => {
    const tools = await listTools(createCloudHarnessServerFactory(runner, undefined, { enabled: true })({ era: 'modern', authInfo } as never));
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
    const inspectionVerb = /_(list|status|capabilities|context|read|search|references|summary|validate|get|spans|export|logs|graph|wait|diff|log|repo_status|repos_list)$|^(github_read|grep_search|model_catalog_search)$/;
    expect(readOnly.filter((name) => !inspectionVerb.test(name))).toEqual([]);
  });

  it('serves the same annotations on the workspace-bound endpoint', async () => {
    const unbound = await listTools(createCloudHarnessServerFactory(runner, undefined, { enabled: true })({ era: 'modern', authInfo } as never));
    const bound = await listTools(createWorkspaceBoundServerFactory(runner, undefined, { enabled: true })(
      { era: 'modern', authInfo: bindWorkspace(authInfo, `ws_${'a'.repeat(24)}`) } as never
    ));
    expect(bound.map((tool) => [tool.name, tool.title, tool.annotations])).toEqual(unbound.map((tool) => [tool.name, tool.title, tool.annotations]));
  });
});
