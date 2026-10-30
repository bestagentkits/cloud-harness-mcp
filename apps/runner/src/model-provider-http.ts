import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { getModelProvider, listModelProviders, type ModelProviderKind } from '@cloud-harness/contracts';

// Outbound HTTPS from the runner to model providers, for catalog discovery and
// connection verification. Only registry hosts (or the operator's custom
// upstream) and the public metadata hosts below are reachable, the resolved
// address is checked and pinned for the connection, redirects are never
// followed, and every request is bounded in time and size. Mirrors the model
// gateway's upstream policy (apps/model-gateway/src/config.ts), which is
// deployed separately.

export interface ProviderHttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
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
    (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2)))) ||
    (first === 100 && second >= 64 && second <= 127) || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) || first >= 224;
}

/** Expands an IPv6 literal (compressed or with an embedded IPv4 tail) into eight 16-bit words. */
function ipv6Words(address: string): number[] | undefined {
  let text = address;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const embedded = text.slice(lastColon + 1);
  if (isIP(embedded) === 4) {
    const octets = embedded.split('.').map(Number);
    tail.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
    text = `${text.slice(0, lastColon + 1)}0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((word) => Number.parseInt(word, 16));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  if (tail.length > 0) (rest.length > 0 ? rest : head).pop();
  const explicit = [...head, ...rest, ...tail];
  const words = halves.length === 2
    ? [...head, ...new Array<number>(8 - explicit.length).fill(0), ...rest, ...tail]
    : explicit;
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
}

// Mirrors the model gateway's isUnsafeAddress so the runner refuses exactly the
// upstream addresses the gateway would refuse.
export function isUnsafeProviderAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? address.toLowerCase();
  if (isIP(normalized) === 4) return privateIpv4(normalized);
  if (isIP(normalized) === 6) {
    const words = ipv6Words(normalized);
    if (words === undefined) return true;
    const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0] = words;
    const zeroPrefix = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0;
    // Every prefix that embeds or tunnels an IPv4 address is refused outright:
    // IPv4-compatible (::/96, which also covers :: and ::1), IPv4-mapped
    // (::ffff:0:0/96), SIIT (::ffff:0:0:0/96), NAT64 (64:ff9b::/96,
    // 64:ff9b:1::/48), 6to4 (2002::/16), and Teredo (2001::/32).
    if (zeroPrefix && ((w4 === 0 && (w5 === 0 || w5 === 0xffff)) || (w4 === 0xffff && w5 === 0))) return true;
    if (w0 === 0x64 && w1 === 0xff9b && (w2 === 1 || (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0))) return true;
    if (w0 === 0x2002 || (w0 === 0x2001 && w1 === 0)) return true;
    return (w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xff00) === 0xff00 ||
      (w0 === 0x2001 && (w1 === 0xdb8 || w1 === 2)) || w0 === 0x100;
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

// Each registry provider may reach only its own hosts, so a credential for one
// provider is never sent to another provider's API.
const registryHosts: ReadonlyMap<ModelProviderKind, ReadonlySet<string>> = new Map(listModelProviders().map((provider) => [
  provider.id,
  new Set([
    ...Object.values(provider.endpoints),
    ...(provider.modelsEndpoint ? [provider.modelsEndpoint.url] : [])
  ].map((url) => new URL(url).hostname))
]));

/**
 * The hosts a request for `provider` may reach: the registry's own hosts, or
 * for a custom provider the host of the operator's HTTPS upstream.
 */
export function assertProviderRequestUrl(provider: ModelProviderKind, raw: string, customUpstreamUrl?: string): URL {
  const url = credentialFreeHttpsUrl(raw);
  const definition = getModelProvider(provider);
  const allowed = definition.requiresCustomUpstream
    ? customUpstreamUrl !== undefined && new URL(customUpstreamUrl).hostname === url.hostname
    : registryHosts.get(provider)?.has(url.hostname) === true;
  if (!allowed) throw new ProviderHttpError('forbidden_host', 'provider request host is not allowed');
  assertPublicHostname(url.hostname);
  return url;
}

function credentialFreeHttpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) {
    throw new ProviderHttpError('forbidden_host', 'provider requests must use credential-free HTTPS on port 443');
  }
  return url;
}

// Public metadata the catalog reads without any credential. models.dev publishes
// the per-model prices OpenCode's own client uses, which no OpenCode endpoint
// exposes. No provider credential is ever sent to these hosts.
const publicMetadataHosts: ReadonlySet<string> = new Set(['models.dev']);

/** A credential-free HTTPS URL on a public metadata host. */
export function assertPublicMetadataUrl(raw: string): URL {
  const url = credentialFreeHttpsUrl(raw);
  if (!publicMetadataHosts.has(url.hostname)) throw new ProviderHttpError('forbidden_host', 'metadata request host is not allowed');
  assertPublicHostname(url.hostname);
  return url;
}

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/**
 * Splits a streamed body into lines. A StringDecoder keeps a multibyte UTF-8
 * character that straddles two chunks intact. `push` returns false once
 * `onLine` asks to stop.
 */
export function createLineSplitter(onLine: (line: string) => boolean | void): { push(chunk: Buffer): boolean; end(): void } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, '');
        pending = pending.slice(newline + 1);
        if (onLine(line) === false) return false;
        newline = pending.indexOf('\n');
      }
      return true;
    },
    end() {
      pending += decoder.end();
      if (pending.length > 0) onLine(pending.replace(/\r$/u, ''));
      pending = '';
    }
  };
}

function timeoutError(timeoutMs: number): ProviderHttpError {
  return new ProviderHttpError('timeout', `provider did not answer within ${timeoutMs} ms`);
}

export function createProviderHttpClient(options: { lookup?: Lookup } = {}): ProviderHttpClient {
  const resolveAll: Lookup = options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  return {
    async request(request) {
      // The deadline covers name resolution as well as the exchange itself.
      const startedAt = Date.now();
      const url = new URL(request.url);
      let address = url.hostname;
      let family = isIP(address);
      if (family === 0) {
        let lookupTimer: NodeJS.Timeout | undefined;
        const addresses = await Promise.race([
          resolveAll(url.hostname).catch(() => {
            throw new ProviderHttpError('network', 'provider hostname did not resolve');
          }),
          new Promise<never>((_resolve, reject) => {
            lookupTimer = setTimeout(() => reject(timeoutError(request.timeoutMs)), request.timeoutMs);
          })
        ]).finally(() => clearTimeout(lookupTimer));
        const selected = addresses.find((candidate) => !isUnsafeProviderAddress(candidate.address));
        if (!selected || (selected.family !== 4 && selected.family !== 6)) {
          throw new ProviderHttpError('forbidden_host', 'provider hostname resolved only to private or reserved addresses');
        }
        address = selected.address;
        family = selected.family;
      } else if (isUnsafeProviderAddress(address)) {
        throw new ProviderHttpError('forbidden_host', 'provider address is private or reserved');
      }
      const remainingMs = request.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw timeoutError(request.timeoutMs);
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
          const lines = request.onLine ? createLineSplitter(request.onLine) : undefined;
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
            if (lines && !lines.push(kept)) { stop(); return; }
            if (kept.byteLength < chunk.byteLength) stop();
          });
          incoming.on('end', () => {
            if (settled) return;
            lines?.end();
            finish(undefined, { status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
          });
          incoming.on('error', () => finish(new ProviderHttpError('network', 'provider response failed')));
        });
        const deadline = setTimeout(() => {
          outgoing.destroy();
          finish(timeoutError(request.timeoutMs));
        }, remainingMs);
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
