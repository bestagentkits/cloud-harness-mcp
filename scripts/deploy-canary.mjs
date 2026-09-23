import { randomUUID } from 'node:crypto';

const endpoint = 'http://127.0.0.1:3000/mcp';
const canaryEndpoint = process.env['MCP_CANARY_URL'] ?? endpoint;
const accessClientId = process.env['MCP_CANARY_ACCESS_CLIENT_ID'];
const accessClientSecret = process.env['MCP_CANARY_ACCESS_CLIENT_SECRET'];
const token = process.env.MCP_BEARER_TOKEN;
if (!token && !(accessClientId && accessClientSecret)) throw new Error('canary authentication is required');

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
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': protocolVersion
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (accessClientId && accessClientSecret) {
    headers['cf-access-client-id'] = accessClientId;
    headers['cf-access-client-secret'] = accessClientSecret;
  }
  if (method === 'tools/call') headers['mcp-name'] = params.name;
  const response = await fetch(canaryEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: { ...params, _meta: requestMeta } })
  });
  if (!response.ok) throw new Error(`canary HTTP status ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`canary RPC error ${payload.error.code}`);
  return payload.result;
}

// A freshly recreated Compose container can briefly lack a working route
// (connect timeout, refused, DNS) right after `compose up`. Only the first,
// side-effect-free discovery call retries, and only on transport errors, so
// an unhealthy release still fails the gate within a bounded window.
const TRANSIENT_CONNECT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'
]);

async function discoverWithRetry(attempts = 6, delayMs = 5_000) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rpc('server/discover');
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (attempt >= attempts || !TRANSIENT_CONNECT_CODES.has(code)) throw error;
      console.log(`deploy-canary-retry=${attempt}/${attempts - 1} reason=${code}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function toolData(result, name) {
  if (result.isError || result.structuredContent?.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(result).slice(0, 1_000)}`);
  }
  return result.structuredContent.data;
}

function isDependencyEgressUnavailable(error) {
  return JSON.stringify(error?.message ?? error ?? '').includes('DEPENDENCY_EGRESS_UNAVAILABLE');
}

/**
 * The opened workspace reports both the profile it actually resolved and the
 * effective instance default. Logging them is what makes the live posture
 * visible: a host whose runtime configuration still pins `network-none`
 * outranks the built-in default, so a bare "open succeeded" cannot tell the
 * two apart without host access.
 */
function posture(opened) {
  const workspace = opened?.capabilities?.workspace ?? {};
  return `profile:${workspace.networkProfile ?? 'unknown'} default:${workspace.defaultNetworkProfile ?? 'unknown'}`;
}

async function openCanaryWorkspace(suffix, networkProfile) {
  const call = await rpc('tools/call', {
    name: 'workspace_open',
    arguments: {
      repositoryUrl: 'https://github.com/bestagentkits/cloud-harness-mcp.git',
      idempotencyKey: `deploy-canary-${suffix}`,
      ...(networkProfile ? { networkProfile } : {})
    }
  });
  return toolData(call, 'workspace_open');
}

try {
  const discovered = await discoverWithRetry();
  if (!discovered.supportedVersions?.includes(protocolVersion)) throw new Error('canary modern protocol unavailable');
  const tools = await rpc('tools/list');
  if (!tools.tools?.some((tool) => tool.name === 'workspace_open')) throw new Error('canary tool surface incomplete');
  const suffix = randomUUID();
  // Exercise the shipped instance default first: omit networkProfile so the
  // open resolves through the persisted instance setting and the runner
  // configuration. Only an explicit DEPENDENCY_EGRESS_UNAVAILABLE falls back
  // to network-none so the deploy still gates on control-plane health when
  // the host firewall is not provisioned; any other failure keeps failing.
  let opened;
  let exercisedDefault = true;
  try {
    opened = await openCanaryWorkspace(suffix);
  } catch (error) {
    if (!isDependencyEgressUnavailable(error)) throw error;
    exercisedDefault = false;
    console.log('deploy-canary-fallback=unattested-dependency-egress (retrying with network-none)');
    opened = await openCanaryWorkspace(suffix, 'network-none');
  }
  console.log(`deploy-canary-network-profile=${exercisedDefault ? 'instance-default' : 'network-none-fallback'}`);
  console.log(`deploy-canary-posture=${posture(opened)}`);
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
