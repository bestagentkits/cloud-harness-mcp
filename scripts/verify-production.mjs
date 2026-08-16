import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL(process.env.MCP_URL ?? '');
const token = process.env.MCP_BEARER_TOKEN;
const repositoryUrl = process.env.VERIFY_REPOSITORY_URL ?? 'https://github.com/bestagentkits/cloud-harness-mcp.git';

if (!endpoint.href || !token) throw new Error('MCP_URL and MCP_BEARER_TOKEN are required');

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function data(result, name) {
  ensure(!result.isError, `${name} returned an MCP error`);
  ensure(result.structuredContent?.ok === true, `${name} returned an unsuccessful structured result`);
  return result.structuredContent.data;
}

function clientFor(mode, name) {
  return new Client(
    { name, version: '1.0.0' },
    { versionNegotiation: { mode } }
  );
}

async function connect(client) {
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  }));
}

const evidence = {
  endpoint: endpoint.origin + endpoint.pathname,
  unauthorizedRejected: false,
  modernProtocol: false,
  legacyProtocol: false,
  toolSurfaceConsistent: false,
  workflow: false,
  cleanup: false,
  privateGitHubAppClone: 'not-run-without-owner-supplied-credentials'
};

let modern;
let legacy;
let workspaceId;

try {
  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'unauthorized-check', version: '1.0.0' } }
    })
  });
  evidence.unauthorizedRejected = unauthorized.status === 401;
  ensure(evidence.unauthorizedRejected, `unauthorized request returned ${unauthorized.status}`);

  modern = clientFor({ pin: '2026-07-28' }, 'cloud-harness-production-verifier');
  await connect(modern);
  const modernTools = await modern.listTools();
  ensure(modernTools.tools.some((tool) => tool.name === 'workspace_open'), 'modern tool list is incomplete');
  ensure(modernTools.tools.some((tool) => tool.name === 'tasks_cancel'), 'task cancellation tool is missing');
  evidence.modernProtocol = true;

  legacy = clientFor('legacy', 'cloud-harness-production-legacy-verifier');
  await connect(legacy);
  const legacyTools = await legacy.listTools();
  evidence.legacyProtocol = true;
  evidence.toolSurfaceConsistent = legacyTools.tools.length === modernTools.tools.length;
  ensure(evidence.toolSurfaceConsistent, 'modern and legacy tool surfaces differ');
  data(await legacy.callTool({ name: 'workspace_list', arguments: {} }), 'legacy workspace_list');
  await legacy.close();
  legacy = undefined;

  const suffix = randomUUID();
  const opened = data(await modern.callTool({
    name: 'workspace_open',
    arguments: { repositoryUrl, idempotencyKey: `production-${suffix}`, networkMode: 'none' }
  }), 'workspace_open');
  workspaceId = opened.workspaceId;
  const replayed = data(await modern.callTool({
    name: 'workspace_open',
    arguments: { repositoryUrl, idempotencyKey: `production-${suffix}`, networkMode: 'none' }
  }), 'workspace_open replay');
  ensure(replayed.workspaceId === workspaceId, 'workspace idempotency replay changed the handle');

  data(await modern.callTool({
    name: 'files_write',
    arguments: { workspaceId, path: 'production-verification.txt', content: 'verified over public HTTPS\n' }
  }), 'files_write');
  const read = data(await modern.callTool({
    name: 'files_read',
    arguments: { workspaceId, path: 'production-verification.txt', offset: 0, limit: 65_536 }
  }), 'files_read');
  ensure(read.content === 'verified over public HTTPS\n', 'persisted file content differs');
  const grep = data(await modern.callTool({
    name: 'grep_search',
    arguments: { workspaceId, pattern: 'verified over public HTTPS', path: '.', maxResults: 10 }
  }), 'grep_search');
  ensure(JSON.stringify(grep).includes('production-verification.txt'), 'grep did not find the persisted edit');
  const execution = data(await modern.callTool({
    name: 'exec_run',
    arguments: { workspaceId, command: 'id -u && test ! -w /etc && printf live-exec-ok', cwd: '.', timeoutMs: 10_000, maxOutputBytes: 65_536 }
  }), 'exec_run');
  ensure(JSON.stringify(execution).includes('10001'), 'executor did not run as the expected non-root user');
  ensure(JSON.stringify(execution).includes('live-exec-ok'), 'executor did not complete the command');
  const gitStatus = data(await modern.callTool({ name: 'git_status', arguments: { workspaceId } }), 'git_status');
  ensure(JSON.stringify(gitStatus).includes('production-verification.txt'), 'Git did not observe the persisted edit');

  const task = data(await modern.callTool({
    name: 'tasks_run',
    arguments: { workspaceId, command: 'sleep 2; printf leaked > cancelled-production-task.txt', cwd: '.', idempotencyKey: `task-${suffix}`, timeoutMs: 10_000 }
  }), 'tasks_run');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const cancelled = data(await modern.callTool({ name: 'tasks_cancel', arguments: { workspaceId, taskId: task.id } }), 'tasks_cancel');
  ensure(cancelled.status === 'cancelled', 'task did not report cancellation');
  await new Promise((resolve) => setTimeout(resolve, 2_250));
  const files = data(await modern.callTool({ name: 'files_list', arguments: { workspaceId, path: '.', limit: 100 } }), 'files_list');
  ensure(!JSON.stringify(files).includes('cancelled-production-task.txt'), 'cancelled task continued running');
  evidence.workflow = true;

  data(await modern.callTool({ name: 'workspace_close', arguments: { workspaceId } }), 'workspace_close');
  workspaceId = undefined;
  evidence.cleanup = true;
} finally {
  if (workspaceId && modern) {
    await modern.callTool({ name: 'workspace_close', arguments: { workspaceId } }).catch(() => undefined);
  }
  if (legacy) await legacy.close().catch(() => undefined);
  if (modern) await modern.close().catch(() => undefined);
}

console.log(JSON.stringify(evidence, null, 2));
