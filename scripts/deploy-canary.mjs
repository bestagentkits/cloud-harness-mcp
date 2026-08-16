import { randomUUID } from 'node:crypto';

const endpoint = 'http://127.0.0.1:3000/mcp';
const token = process.env.MCP_BEARER_TOKEN;
if (!token) throw new Error('MCP_BEARER_TOKEN is required');

let requestId = 0;
let workspaceId;
const protocolVersion = '2026-07-28';
const requestMeta = {
  'io.modelcontextprotocol/protocolVersion': protocolVersion,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'cloud-harness-deploy-canary', version: '1.0.0' }
};

async function rpc(method, params = {}) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': protocolVersion
  };
  if (method === 'tools/call') headers['mcp-name'] = params.name;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: { ...params, _meta: requestMeta } })
  });
  if (!response.ok) throw new Error(`canary HTTP status ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`canary RPC error ${payload.error.code}`);
  return payload.result;
}

function toolData(result, name) {
  if (result.isError || result.structuredContent?.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(result).slice(0, 1_000)}`);
  }
  return result.structuredContent.data;
}

try {
  const discovered = await rpc('server/discover');
  if (!discovered.supportedVersions?.includes(protocolVersion)) throw new Error('canary modern protocol unavailable');
  const tools = await rpc('tools/list');
  if (!tools.tools?.some((tool) => tool.name === 'workspace_open')) throw new Error('canary tool surface incomplete');
  const suffix = randomUUID();
  const opened = toolData(await rpc('tools/call', {
    name: 'workspace_open',
    arguments: {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: `deploy-canary-${suffix}`,
      networkMode: 'none'
    }
  }), 'workspace_open');
  workspaceId = opened.workspaceId;
  toolData(await rpc('tools/call', {
    name: 'files_write',
    arguments: { workspaceId, path: 'deploy-canary.txt', content: 'canary-ok\n' }
  }), 'files_write');
  const execution = toolData(await rpc('tools/call', {
    name: 'exec_run',
    arguments: { workspaceId, command: 'id -u && test ! -w /etc', cwd: '.', timeoutMs: 10_000, maxOutputBytes: 65_536 }
  }), 'exec_run');
  if (!JSON.stringify(execution).includes('10001')) throw new Error('canary executor user mismatch');
  toolData(await rpc('tools/call', { name: 'workspace_close', arguments: { workspaceId } }), 'workspace_close');
  workspaceId = undefined;
} finally {
  if (workspaceId) {
    await rpc('tools/call', { name: 'workspace_close', arguments: { workspaceId } }).catch(() => undefined);
  }
}

console.log('deploy-canary=pass');
