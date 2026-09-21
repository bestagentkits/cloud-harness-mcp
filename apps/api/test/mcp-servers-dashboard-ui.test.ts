import { describe, expect, it } from 'vitest';
import { mcpStatusClass, mcpStatusLabel, renderMcpActions, renderMcpServerDetail, renderMcpServersIndex } from '../dashboard/dashboard-render.js';

const gateway = {
  endpoint: '/mcp-gateway',
  publicUrl: 'https://harness.example.com/mcp-gateway',
  authMode: 'cloudflare-access'
};

const connected = {
  id: 'mcps_abcdefghijklmnopqrstuvwx',
  name: 'linear',
  description: 'Linear issue tracking',
  transport: 'streamable-http',
  endpoint: 'https://mcp.linear.example.com/mcp',
  headers: [
    // A secret header must never carry a resolved value; `value` is present here so
    // the renderer is proven to drop it in favour of the write-only reference.
    { name: 'authorization', kind: 'secret', secretRef: 'LINEAR_API_KEY', value: 'sk-live-super-secret' },
    { name: 'x-workspace', kind: 'literal', value: 'acme' }
  ],
  enabled: true,
  status: 'connected',
  toolCount: 2,
  lastConnectedAt: 1_725_177_600_000,
  lastError: null,
  lastCheckedAt: 1_725_177_600_000,
  permissionDefault: 'allow',
  generation: 3,
  createdAt: 1_725_000_000_000,
  updatedAt: 1_725_177_600_000
};

const disabled = {
  ...connected,
  id: 'mcps_zyxwvutsrqponmlkjihgfedc',
  name: 'stale-vendor',
  enabled: false,
  status: 'disabled',
  toolCount: 0,
  lastConnectedAt: null
};

const tools = [
  {
    id: 'mcpt_abcdefghijklmnopqrstuvwx',
    serverId: connected.id,
    qualifiedName: 'linear.create_issue',
    upstreamName: 'create_issue',
    description: 'Create an issue in a team',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    annotations: null,
    availability: 'available',
    permission: 'allow',
    discoveredAt: 1_725_177_600_000
  },
  {
    id: 'mcpt_zyxwvutsrqponmlkjihgfedc',
    serverId: connected.id,
    qualifiedName: 'linear.delete_team',
    upstreamName: 'delete_team',
    description: 'Delete a team',
    inputSchema: { type: 'object' },
    annotations: null,
    availability: 'unavailable',
    permission: 'deny',
    discoveredAt: 1_725_177_600_000
  }
];

const traces = [
  {
    id: 'mcpg_abcdefghijklmnopqrstuvwx',
    serverId: connected.id,
    serverName: connected.name,
    tool: 'linear.create_issue',
    operation: 'execute',
    clientId: 'claude-desktop',
    durationMs: 128,
    status: 'success',
    errorCode: null,
    errorMessage: null,
    requestBytes: 210,
    responseBytes: 512,
    createdAt: 1_725_177_600_000
  }
];

const expectCspSafe = (html: string) => {
  expect(html).not.toContain('style=');
  expect(html).not.toContain('<style>');
};

describe('MCP servers dashboard renderers', () => {
  it('maps the runner connection states onto the console status vocabulary', () => {
    expect(mcpStatusLabel('connected')).toBe('Connected');
    expect(mcpStatusLabel('connecting')).toBe('Connecting');
    // A neutral in-progress state must not wear the warning palette.
    expect(mcpStatusClass('connecting')).toBe('info');
    expect(mcpStatusLabel('disconnected')).toBe('Disconnected');
    expect(mcpStatusLabel('error')).toBe('Error');
    expect(mcpStatusLabel('disabled')).toBe('Disabled');
    expect(mcpStatusLabel('unknown')).toBe('Not yet contacted');
    expect(mcpStatusLabel('something-else')).toBe('Not yet contacted');
  });

  it('renders the gateway card with the endpoint, lane, and the two hard limitations', () => {
    const html = renderMcpServersIndex({ servers: [connected, disabled], gateway });
    expect(html).toContain('Your Cloud Harness MCP Gateway');
    expect(html).toContain('https://harness.example.com/mcp-gateway');
    expect(html).toContain('data-copy="https://harness.example.com/mcp-gateway"');
    expect(html).toContain('Connect this single MCP endpoint to your AI client.');
    expect(html).toContain('Authenticates with your Cloud Harness Access session.');
    expect(html).toContain('The managed API-key lane is not yet available for this endpoint.');
    expect(html).toContain('HTTP redirects are refused');
    expect(html).toContain('stdio');
    expect(html).toContain('unsupported');
    expectCspSafe(html);
  });

  it('names the owner-bearer lane and falls back to the relative endpoint', () => {
    const html = renderMcpServersIndex({ servers: [], gateway: { endpoint: '/mcp-gateway', authMode: 'owner-bearer' } });
    expect(html).toContain('Authenticates with your Cloud Harness owner bearer token.');
    expect(html).toContain('/mcp-gateway');
    expectCspSafe(html);
  });

  it('renders the server table, status pills, tool counts, and per-row actions', () => {
    const html = renderMcpServersIndex({ servers: [connected, disabled], gateway });
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Transport</th>');
    expect(html).toContain('<th>Status</th>');
    expect(html).toContain('<th>Tools</th>');
    expect(html).toContain('<th>Last connected</th>');
    expect(html).toContain('<th>Enabled</th>');
    expect(html).toContain('<th>Actions</th>');
    expect(html).toContain('href="/dashboard/mcp-servers/mcps_abcdefghijklmnopqrstuvwx"');
    expect(html).toContain('>linear</a>');
    expect(html).toContain('class="status active">Connected</span>');
    expect(html).toContain('streamable-http');
    expect(html).toContain('<td class="mono">2</td>');
    expect(html).toContain('data-mcp-edit="mcps_abcdefghijklmnopqrstuvwx"');
    expect(html).toContain('data-mcp-toggle="mcps_abcdefghijklmnopqrstuvwx" data-next-enabled="false"');
    expect(html).toContain('>Disable</button>');
    expect(html).toContain('data-mcp-toggle="mcps_zyxwvutsrqponmlkjihgfedc" data-next-enabled="true"');
    expect(html).toContain('>Enable</button>');
    expect(html).toContain('data-mcp-test="mcps_abcdefghijklmnopqrstuvwx"');
    expect(html).toContain('data-mcp-refresh="mcps_abcdefghijklmnopqrstuvwx"');
    expect(html).toContain('data-mcp-delete="mcps_abcdefghijklmnopqrstuvwx"');
    // The add action lives in the page's action slot (renderMcpActions), not the list.
    expect(renderMcpActions()).toContain('data-mcp-add');
    expect(renderMcpActions()).toContain('aria-haspopup="dialog"');
    expect(html).toContain('class="mobile-list"');
    expectCspSafe(html);
  });

  it('renders the empty state for a principal with no servers', () => {
    const html = renderMcpServersIndex({ servers: [], gateway });
    expect(html).toContain('<tr><td colspan="7">No MCP servers configured.</td></tr>');
    expect(html).toContain('No MCP servers configured.');
    expect(html).toContain('Add a downstream MCP server');
    expectCspSafe(html);
  });

  it('renders the detail header and all four tabs', () => {
    const html = renderMcpServerDetail(connected, tools, traces, 'overview', undefined, gateway);
    expect(html).toContain('data-mcp-tab="overview"');
    expect(html).toContain('data-mcp-tab="tools"');
    expect(html).toContain('data-mcp-tab="permissions"');
    expect(html).toContain('data-mcp-tab="logs"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('>Overview</button>');
    expect(html).toContain('class="status active">Connected</span>');
    expect(html).toContain('mcps_abcdefghijklmnopqrstuvwx');
    expect(html).toContain('Linear issue tracking');
    expect(html).toContain('https://mcp.linear.example.com/mcp');
    expectCspSafe(html);
  });

  it('never renders a secret header value and states that the reference is write-only', () => {
    const html = renderMcpServerDetail(connected, tools, traces, 'overview', undefined, gateway);
    expect(html).toContain('LINEAR_API_KEY');
    expect(html).toContain('Write-only secret');
    // The literal header value is safe to show; the secret reference carries no value.
    expect(html).toContain('acme');
    expect(html).not.toContain('sk-live-super-secret');
    expectCspSafe(html);
  });

  it('renders the tools tab with schemas, permissions, and availability', () => {
    const html = renderMcpServerDetail(connected, tools, traces, 'tools', undefined, gateway);
    expect(html).toContain('id="mcp-tool-search"');
    expect(html).toContain('data-mcp-refresh');
    expect(html).toContain('create_issue');
    expect(html).toContain('linear.create_issue');
    expect(html).toContain('class="status active">Available</span>');
    expect(html).toContain('class="status failed">Unavailable</span>');
    expect(html).toContain('class="mcp-tool-detail"');
    expect(html).toContain('&quot;type&quot;: &quot;object&quot;');
    expectCspSafe(html);
  });

  it('renders the permissions form with the server default, per-tool overrides, and the generation fence', () => {
    const html = renderMcpServerDetail(connected, tools, traces, 'permissions', undefined, gateway);
    expect(html).toContain('id="mcp-permissions-form"');
    expect(html).toContain('name="permissionDefault"');
    expect(html).toContain('name="expectedGeneration" value="3"');
    expect(html).toContain('name="tool:create_issue"');
    expect(html).toContain('name="tool:delete_team"');
    expect(html).toContain('<option value="deny" selected>Deny</option>');
    expect(html).toContain('Save permissions');
    // The frozen BFF field name is `permissionDefault`; `default` is rejected by the runner schema.
    expect(html).not.toContain('name="default"');
    expectCspSafe(html);
  });

  it('renders the logs table with the sanitized detail expansion', () => {
    const html = renderMcpServerDetail(connected, tools, traces, 'logs', 'next-page', gateway);
    expect(html).toContain('linear.create_issue');
    expect(html).toContain('claude-desktop');
    expect(html).toContain('128 ms');
    expect(html).toContain('class="status active">success</span>');
    expect(html).toContain('mcpg_abcdefghijklmnopqrstuvwx');
    expect(html).toContain('data-cursor="next-page"');
    expect(html).toContain('Load more');
    expectCspSafe(html);
  });

  it('escapes server-supplied text instead of interpreting it as markup', () => {
    const hostile = {
      ...connected,
      name: '<img src=x onerror=alert(1)>',
      description: '<script>alert(2)</script>',
      lastError: '<img src=y onerror=alert(3)>'
    };
    const indexHtml = renderMcpServersIndex({ servers: [hostile], gateway });
    const detailHtml = renderMcpServerDetail(hostile, tools, traces, 'overview', undefined, gateway);
    for (const html of [indexHtml, detailHtml]) {
      expect(html).not.toContain('<img src=x onerror=');
      expect(html).not.toContain('<img src=y onerror=');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expectCspSafe(html);
    }
  });

  it('escapes hostile tool and trace fields', () => {
    const hostileTool = { ...tools[0], upstreamName: '<img src=x onerror=alert(4)>', description: '</td><td>' };
    const hostileTrace = { ...traces[0], tool: '<img src=x onerror=alert(5)>', clientId: '<img src=z onerror=alert(6)>' };
    const toolHtml = renderMcpServerDetail(connected, [hostileTool], [hostileTrace], 'tools', undefined, gateway);
    const logHtml = renderMcpServerDetail(connected, [hostileTool], [hostileTrace], 'logs', undefined, gateway);
    for (const html of [toolHtml, logHtml]) {
      expect(html).not.toContain('<img src=x onerror=');
      expect(html).not.toContain('<img src=z onerror=');
      expectCspSafe(html);
    }
    expect(toolHtml).toContain('&lt;img src=x onerror=alert(4)&gt;');
    expect(logHtml).toContain('&lt;img src=x onerror=alert(5)&gt;');
    expect(logHtml).toContain('&lt;img src=z onerror=alert(6)&gt;');
  });

  it('renders a not-found state for an unavailable server', () => {
    const html = renderMcpServerDetail(undefined, [], [], 'overview', undefined, gateway);
    expect(html).toContain('MCP server not found.');
    expectCspSafe(html);
  });
});
