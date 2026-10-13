import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { HarnessError } from '@cloud-harness/contracts';

/**
 * SSRF policy for downstream MCP endpoints.
 *
 * This is an intentional, tested mirror of the model gateway's classifier
 * (`apps/model-gateway/src/config.ts` owns the reference implementation for
 * internal upstreams); the API cannot import across apps, so the block set is
 * duplicated here and must stay in sync by review.
 *
 * Two guarantees matter:
 * - a URL is validated before it is persisted and again before every outbound
 *   request, and
 * - the connection is pinned to the addresses that validation returned, so a
 *   resolver that answers differently on the transport's own lookup cannot
 *   redirect a credentialed request (see `createPinnedLookup`).
 */

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type GatewayEndpointValidation =
  | { ok: true; url: URL; addresses: ResolvedAddress[] }
  | { ok: false; error: string };

export type GatewayEndpointOptions = {
  allowInsecureHttp: boolean;
  allowPrivateEndpoints: boolean;
  /** Test seam: replaces `node:dns/promises` lookup for hostname endpoints. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
};

const MAX_URL_LENGTH = 2_048;
const UNSAFE_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home',
  '.lan',
  '.corp',
  '.test',
  '.invalid',
  '.example',
  '.arpa'
];

function unsafeIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return true;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return true;
    const value = Number(part);
    if (value > 255) return true;
    octets.push(value);
  }
  const first = octets[0]!;
  const second = octets[1]!;
  const third = octets[2]!;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function parseIpv6Group(group: string): number[] | undefined {
  if (group.includes('.')) {
    const octets = parseIpv4(group);
    if (!octets) return undefined;
    return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
  }
  if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
  return [Number.parseInt(group, 16)];
}

/** Parses an IPv6 literal (including a compressed and/or IPv4-embedded form) into 8 words. */
function parseIpv6(input: string): number[] | undefined {
  let text = input.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !text.includes(':')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half === '') return [];
    const groups = half.split(':');
    const words: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      if (group === '') return undefined;
      const parsed = parseIpv6Group(group);
      if (!parsed) return undefined;
      if (group.includes('.') && index !== groups.length - 1) return undefined;
      words.push(...parsed);
    }
    return words;
  };
  const head = parseHalf(halves[0] ?? '');
  if (!head) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseHalf(halves[1] ?? '');
  if (!tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function unsafeIpv6(words: number[]): boolean {
  const mapped = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff;
  if (mapped) {
    const high = words[6]!;
    const low = words[7]!;
    return unsafeIpv4(`${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`);
  }
  if (words.every((word) => word === 0)) return true;
  if (words[7] === 1 && words.slice(0, 7).every((word) => word === 0)) return true;
  const first = words[0]!;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && words[1] === 0x0db8) return true;
  if (first === 0x2001 && words[1] === 0x0002 && words[2] === 0x0000) return true;
  if (first === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;
  return false;
}

function stripZone(address: string): string {
  const zone = address.indexOf('%');
  return zone === -1 ? address : address.slice(0, zone);
}

/**
 * Classifies an address literal. Returns `true` for every private, loopback,
 * link-local, CGNAT, documentation, multicast, reserved, or otherwise
 * non-public address, and fails closed (`true`) for anything that is not a
 * valid IP literal.
 */
export function isUnsafeAddress(address: string): boolean {
  const normalized = stripZone(address.trim());
  const version = isIP(normalized);
  if (version === 4) return unsafeIpv4(normalized);
  if (version === 6) {
    const words = parseIpv6(normalized);
    return words === undefined ? true : unsafeIpv6(words);
  }
  return true;
}

/** Link-local and metadata addresses stay refused even for an opted-in private endpoint. */
export function isAlwaysBlockedAddress(address: string): boolean {
  const normalized = stripZone(address.trim());
  const version = isIP(normalized);
  if (version === 4) {
    const octets = parseIpv4(normalized);
    if (!octets) return true;
    return octets[0] === 169 && octets[1] === 254;
  }
  if (version === 6) {
    const words = parseIpv6(normalized);
    if (!words) return true;
    return (words[0]! & 0xffc0) === 0xfe80;
  }
  return true;
}

function unsafeHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/u, '');
  if (lower.length === 0) return true;
  if (lower === 'localhost' || lower === 'metadata.google.internal') return true;
  if (UNSAFE_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  return !lower.includes('.');
}

function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((entries: LookupAddress[]) =>
    entries.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }))
  );
}

function endpointHostname(url: URL): string {
  const hostname = url.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

/**
 * Validates a downstream MCP endpoint and returns the exact addresses the caller
 * must pin. Validation never echoes the raw URL, so a credential, query, or
 * fragment can never leak through an error message.
 */
export async function validateGatewayEndpoint(
  rawUrl: string,
  options: GatewayEndpointOptions
): Promise<GatewayEndpointValidation> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, error: `endpoint URL must be a non-empty string of at most ${MAX_URL_LENGTH} characters` };
  }
  if (rawUrl.includes('\\') || /%2e|%2f|%5c/i.test(rawUrl)) {
    return { ok: false, error: 'endpoint URL must not contain backslashes or encoded path separators' };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'endpoint is not a valid absolute URL' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'endpoint URL must not embed credentials' };
  }
  if (url.search !== '') return { ok: false, error: 'endpoint URL must not contain a query string' };
  if (url.hash !== '') return { ok: false, error: 'endpoint URL must not contain a fragment' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'endpoint URL must use https' };
  }
  if (url.protocol === 'http:' && !options.allowInsecureHttp) {
    return { ok: false, error: 'cleartext http endpoints are refused unless the insecure http opt-in is enabled' };
  }

  const hostname = stripZone(endpointHostname(url));
  const literalVersion = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literalVersion !== 0) {
    addresses = [{ address: hostname, family: literalVersion === 6 ? 6 : 4 }];
  } else {
    if (unsafeHostname(hostname)) return { ok: false, error: 'endpoint hostname is not a public DNS name' };
    let resolved: ResolvedAddress[];
    try {
      resolved = await (options.resolve ? options.resolve(hostname) : defaultResolve(hostname));
    } catch {
      return { ok: false, error: 'endpoint hostname could not be resolved' };
    }
    if (!Array.isArray(resolved) || resolved.length === 0) {
      return { ok: false, error: 'endpoint hostname did not resolve to an address' };
    }
    addresses = resolved;
  }

  for (const entry of addresses) {
    if (!entry || typeof entry.address !== 'string' || (entry.family !== 4 && entry.family !== 6)) {
      return { ok: false, error: 'endpoint resolved to an invalid address' };
    }
  }
  if (!options.allowPrivateEndpoints) {
    if (addresses.some((entry) => isUnsafeAddress(entry.address))) {
      return { ok: false, error: 'endpoint resolves to a private, loopback, link-local, or metadata address' };
    }
  } else if (addresses.some((entry) => isAlwaysBlockedAddress(entry.address))) {
    return { ok: false, error: 'endpoint resolves to a link-local or metadata address, which is always refused' };
  }
  return { ok: true, url, addresses };
}

/** `validateGatewayEndpoint` for write-time and connect-time callers that must fail loudly. */
export async function assertGatewayEndpoint(
  rawUrl: string,
  options: GatewayEndpointOptions
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const result = await validateGatewayEndpoint(rawUrl, options);
  if (!result.ok) throw new HarnessError('INVALID_INPUT', result.error, 400, false);
  return { url: result.url, addresses: result.addresses };
}

export type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
) => void;

/**
 * Builds the undici `connect.lookup` that ignores DNS entirely and answers only
 * with the addresses `validateGatewayEndpoint` approved. Combined with the
 * guarded fetcher's re-validation this makes a rebinding resolver harmless: the
 * socket can only go to an address that already passed the policy.
 */
export function createPinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return (_hostname, options, callback) => {
    if (pinned.length === 0) {
      callback(Object.assign(new Error('no validated address to pin'), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options !== null && typeof options === 'object' && options.all === true) {
      callback(null, pinned);
      return;
    }
    const first = pinned[0]!;
    callback(null, first.address, first.family);
  };
}
