import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CopyButton } from '@/components/ui/copy-button';
import { Callout } from '../shared/callout';
import { Section } from '../shared/section';
import { mcpApi } from './mcp-model';

/** The gateway query; a failure hides the card without hiding the servers, like the classic page. */
export function useMcpGateway() {
  return useQuery({ queryKey: ['bff', '/mcp-gateway', {}], queryFn: () => mcpApi.gateway(), retry: false });
}

function Endpoint({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="font-mono text-xs break-all">{value}</code>
      <CopyButton value={value} label={label} />
    </span>
  );
}

export function McpGatewayCard() {
  const gateway = useMcpGateway();
  if (!gateway.data) return null;
  const { publicUrl, endpoint, apiKeyPublicUrl, authMode } = gateway.data;
  const url = publicUrl ?? endpoint ?? '/mcp-gateway';
  const ownerBearer = (authMode ?? 'owner-bearer') === 'owner-bearer';
  return (
    <Section title="Your Cloud Harness MCP Gateway" testId="mcp-gateway-card" className="rounded-lg border bg-card p-4">
      <Endpoint value={url} label="Copy URL" />
      <div className="grid gap-2 text-sm">
        <p>Connect this single MCP endpoint to your AI client. Tools from your configured MCP servers are discovered and executed through Cloud Harness.</p>
        <p>Your client sees five tools no matter how many servers you add. An agent finds the right tool without loading every schema:</p>
        <ol className="grid gap-1 list-decimal ps-5">
          <li><code className="font-mono">search</code> finds a <code className="font-mono">server.tool</code> from a plain description of the need, across every enabled server it may use.</li>
          <li><code className="font-mono">inspect</code> returns that one tool&apos;s input schema and permission.</li>
          <li><code className="font-mono">execute</code> runs it, re-checking permission on every call.</li>
          <li><code className="font-mono">permissions</code> and <code className="font-mono">status</code> report what is allowed and which servers are connected.</li>
        </ol>
        <p>{ownerBearer ? 'Authenticates with your Cloud Harness owner bearer token.' : 'Authenticates with your Cloud Harness Access session.'}</p>
        {apiKeyPublicUrl ? (
          <>
            <p>Clients that send a static header use the managed API-key lane instead: point them at this endpoint with a key from <Link to="/api-keys" className="underline underline-offset-2">API keys</Link> as the bearer token.</p>
            <Endpoint value={apiKeyPublicUrl} label="Copy API-key URL" />
          </>
        ) : !ownerBearer ? <p>The managed API-key lane is not enabled on this deployment.</p> : null}
      </div>
      <Callout title="Hard limitations.">
        <ul className="grid gap-1 list-disc ps-5">
          <li>HTTP redirects are refused. A vendor base URL that redirects must be configured as its final URL.</li>
          <li><code className="font-mono">stdio</code> downstream servers are unsupported; use <code className="font-mono">streamable-http</code> or <code className="font-mono">sse</code>.</li>
        </ul>
      </Callout>
    </Section>
  );
}
