import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { getModelProvider, listModelProviders, type ModelProviderKind } from '@cloud-harness/contracts';

// Outbound HTTPS from the runner to model providers, for catalog discovery and
// connection verification. Only registry hosts (or the operator's custom
// upstream) are reachable, the resolved address is checked and pinned for the
// connection, redirects are never followed, and every request is bounded in
// time and size. Mirrors the model gateway's upstream policy
// (apps/model-gateway/src/config.ts), which is deployed separately.

export interface ProviderHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  // Called for each complete line of a streamed body; returning false stops reading.
  onLine?: (line: string) => boolean | void;
}

export interface ProviderHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  // True when the body was cut at maxResponseBytes or onLine asked to stop.
  truncated: boolean;
}

export class ProviderHttpError extends Error {
  constructor(public readonly kind: 'timeout' | 'network' | 'forbidden_host', message: string) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export interface ProviderHttpClient {
  request(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

function privateIpv4(address: string): boolean {
  const [first = -1, second = -1, third = -1] = address.split('.').map(Number);
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 168 || second === 0)) ||
    (first === 100 && second >= 64 && second <= 127) || (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && third === 113) || first >= 224;
}

export function isUnsafeProviderAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? address.toLowerCase();
  if (isIP(normalized) === 4) return privateIpv4(normalized);
  if (isIP(normalized) === 6) {
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      if (isIP(mapped) === 4) return privateIpv4(mapped);
      const words = mapped.split(':');
      if (words.length === 2) {
        const high = Number.parseInt(words[0] ?? '', 16);
        const low = Number.parseInt(words[1] ?? '', 16);
        if (Number.isInteger(high) && Number.isInteger(low)) {
          return privateIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
        }
      }
    }
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('ff') || normalized.startsWith('2001:db8:') || normalized.startsWith('2001:2:') ||
      normalized.startsWith('100:');
  }
  return true;
}

function assertPublicHostname(hostname: string): void {
  const lower = hostname.toLowerCase().replace(/\.$/u, '');
  const unsafeSuffixes = ['.localhost', '.local', '.internal', '.home', '.lan', '.corp', '.test', '.invalid', '.example', '.arpa'];
  if (lower === 'localhost' || unsafeSuffixes.some((suffix) => lower.endsWith(suffix)) || !lower.includes('.')) {
    throw new ProviderHttpError('forbidden_host', 'provider hostname is private or non-public');
  }
  if (isIP(lower) !== 0 && isUnsafeProviderAddress(lower)) {
    throw new ProviderHttpError('forbidden_host', 'provider address is private or reserved');
  }
}

const registryHosts = new Set(listModelProviders().flatMap((provider) => [
  ...Object.values(provider.endpoints),
  ...(provider.modelsEndpoint ? [provider.modelsEndpoint.url] : [])
]).map((url) => new URL(url).hostname));

/**
 * The hosts a request for `provider` may reach: the registry's own hosts, or
 * for a custom provider the host of the operator's HTTPS upstream.
 */
export function assertProviderRequestUrl(provider: ModelProviderKind, raw: string, customUpstreamUrl?: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) {
    throw new ProviderHttpError('forbidden_host', 'provider requests must use credential-free HTTPS on port 443');
  }
  const definition = getModelProvider(provider);
  const allowed = definition.requiresCustomUpstream
    ? customUpstreamUrl !== undefined && new URL(customUpstreamUrl).hostname === url.hostname
    : registryHosts.has(url.hostname);
  if (!allowed) throw new ProviderHttpError('forbidden_host', 'provider request host is not allowed');
  assertPublicHostname(url.hostname);
  return url;
}

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export function createProviderHttpClient(options: { lookup?: Lookup } = {}): ProviderHttpClient {
  const resolveAll: Lookup = options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  return {
    async request(request) {
      const url = new URL(request.url);
      let address = url.hostname;
      let family = isIP(address);
      if (family === 0) {
        const addresses = await resolveAll(url.hostname).catch(() => {
          throw new ProviderHttpError('network', 'provider hostname did not resolve');
        });
        const selected = addresses.find((candidate) => !isUnsafeProviderAddress(candidate.address));
        if (!selected || (selected.family !== 4 && selected.family !== 6)) {
          throw new ProviderHttpError('forbidden_host', 'provider hostname resolved only to private or reserved addresses');
        }
        address = selected.address;
        family = selected.family;
      } else if (isUnsafeProviderAddress(address)) {
        throw new ProviderHttpError('forbidden_host', 'provider address is private or reserved');
      }
      const pinnedAddress = address;
      const pinnedFamily = family;
      return await new Promise<ProviderHttpResponse>((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | undefined, response?: ProviderHttpResponse) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error) reject(error);
          else resolve(response!);
        };
        const outgoing = httpsRequest({
          protocol: 'https:',
          hostname: url.hostname,
          servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
          port: 443,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          agent: false,
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
          headers: {
            'user-agent': 'cloud-harness-runner',
            accept: 'application/json, text/event-stream',
            ...(request.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(request.body)) }),
            ...request.headers
          },
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ address: pinnedAddress, family: pinnedFamily }]);
            else callback(null, pinnedAddress, pinnedFamily);
          }
        }, (incoming) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value === 'string') headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(', ');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          let pending = '';
          const stop = () => {
            truncated = true;
            incoming.destroy();
            finish(undefined, { status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
          };
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return;
            const room = request.maxResponseBytes - size;
            const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
            chunks.push(kept);
            size += kept.byteLength;
            if (request.onLine) {
              pending += kept.toString('utf8');
              let newline = pending.indexOf('\n');
              while (newline >= 0) {
                const line = pending.slice(0, newline).replace(/\r$/u, '');
                pending = pending.slice(newline + 1);
                if (request.onLine(line) === false) { stop(); return; }
                newline = pending.indexOf('\n');
              }
            }
            if (kept.byteLength < chunk.byteLength) stop();
          });
          incoming.on('end', () => {
            if (request.onLine && pending.length > 0) request.onLine(pending);
            finish(undefined, { status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
          });
          incoming.on('error', () => finish(new ProviderHttpError('network', 'provider response failed')));
        });
        const deadline = setTimeout(() => {
          outgoing.destroy();
          finish(new ProviderHttpError('timeout', `provider did not answer within ${request.timeoutMs} ms`));
        }, request.timeoutMs);
        outgoing.on('error', (error) => finish(new ProviderHttpError('network', `provider request failed: ${error.name}`)));
        outgoing.end(request.body);
      });
    }
  };
}

/** Removes every occurrence of `secret` from provider-supplied text before it is stored or returned. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('[redacted]');
}
