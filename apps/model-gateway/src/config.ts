import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import type { GatewayConfig, GatewayMode, GatewayProfile, PriceTier, ProfileLimits, TokenPrices } from './types.js';

const PROFILE_KEYS: Record<string, true> = {
  id: true, provider: true, model: true, downstreamPath: true, upstreamUrl: true,
  credentialFile: true, credentialHeader: true, credentialScheme: true, pricing: true,
  limits: true, testOnly: true, allowPrivateUpstream: true, tlsCaFile: true
};
const PRICING_KEYS: Record<string, true> = {
  inputMicrosPerMillionTokens: true,
  outputMicrosPerMillionTokens: true,
  cacheReadMicrosPerMillionTokens: true,
  cacheWriteMicrosPerMillionTokens: true,
  tiers: true
};
const TIER_KEYS: Record<string, true> = {
  minPromptTokens: true,
  inputMicrosPerMillionTokens: true,
  outputMicrosPerMillionTokens: true,
  cacheReadMicrosPerMillionTokens: true,
  cacheWriteMicrosPerMillionTokens: true
};
const MAX_PRICE_TIERS = 4;
/**
 * Prices accept any non-negative safe integer, matching the runner's
 * AgentModelPricingSchema (packages/contracts/src/model-profile-schemas.ts), so
 * a snapshot the runner exports is never refused for a large price. Cost math
 * saturates instead (budget.ts).
 */
const MAX_PRICE_MICROS = Number.MAX_SAFE_INTEGER;
const PRICE_FIELDS = [
  'inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'cacheReadMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens'
] as const;
const LIMIT_KEYS: Record<string, true> = {
  maxRequestBytes: true, maxResponseBytes: true, maxHeaderBytes: true, maxHeaders: true,
  deadlineMs: true, maxInputTokens: true, maxOutputTokens: true, maxCostMicros: true,
  maxStreamLineBytes: true
};
const CONFIG_KEYS: Record<string, true> = { version: true, mode: true, profiles: true };
const ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>, label: string): void {
  for (const key of Object.keys(value)) if (allowed[key] !== true) throw new Error(`${label} contains unsupported field ${key}`);
}

function string(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be a bounded single-line string`);
  }
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  const third = parts[2] ?? -1;
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 168 || second === 0 || (second === 0 && third === 2))) ||
    (first === 100 && second >= 64 && second <= 127) || (first === 198 && (second === 18 || second === 19 || second === 51)) ||
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

export function isUnsafeAddress(address: string): boolean {
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
    // 64:ff9b:1::/48), 6to4 (2002::/16), and Teredo (2001::/32). A translator
    // or tunnel may deliver them to a private or metadata endpoint.
    if (zeroPrefix && ((w4 === 0 && (w5 === 0 || w5 === 0xffff)) || (w4 === 0xffff && w5 === 0))) return true;
    if (w0 === 0x64 && w1 === 0xff9b && (w2 === 1 || (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0))) return true;
    if (w0 === 0x2002 || (w0 === 0x2001 && w1 === 0)) return true;
    return (w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xff00) === 0xff00 ||
      (w0 === 0x2001 && (w1 === 0xdb8 || w1 === 2)) || w0 === 0x100;
  }
  return true;
}

export function assertProductionHostname(hostname: string): void {
  const lower = hostname.toLowerCase().replace(/\.$/u, '');
  const unsafeSuffixes = ['.localhost', '.local', '.internal', '.home', '.lan', '.corp', '.test', '.invalid', '.example', '.arpa'];
  if (lower === 'localhost' || unsafeSuffixes.some((suffix) => lower.endsWith(suffix)) ||
      lower === 'metadata.google.internal' || !lower.includes('.')) {
    throw new Error('production upstream hostname is private or non-public');
  }
  if (isIP(lower) !== 0 && isUnsafeAddress(lower)) throw new Error('production upstream address is private or reserved');
}

export type ProfilePricing = Pick<GatewayProfile,
  'inputMicrosPerMillionTokens' | 'outputMicrosPerMillionTokens' | 'cacheReadMicrosPerMillionTokens' | 'cacheWriteMicrosPerMillionTokens' | 'tiers'>;

function price(value: unknown, label: string): number {
  return integer(value, label, 0, MAX_PRICE_MICROS);
}

function optionalPrice(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : price(value, label);
}

/**
 * Validates profile pricing. Absent cache prices mean the input price, and
 * absent tiers mean flat pricing. Tier thresholds must ascend strictly and no
 * tier price may fall below the tier beneath it (the base prices for the first
 * tier); the reservation relies on that to never pick a cheaper tier than the
 * provider bills.
 *
 * `strictKeys` refuses unknown pricing and tier keys (static profile files); the
 * control snapshot ignores them, so a newer runner can add fields. Base prices default
 * to 0 only when `baseDefault` is set, matching the control snapshot.
 */
export function parsePricing(value: unknown, label: string, options: { strictKeys: boolean; baseDefault?: number }): ProfilePricing {
  const pricing = object(value, label);
  if (options.strictKeys) exactKeys(pricing, PRICING_KEYS, label);
  const basePrice = (field: 'inputMicrosPerMillionTokens' | 'outputMicrosPerMillionTokens'): number =>
    pricing[field] === undefined && options.baseDefault !== undefined ? options.baseDefault : price(pricing[field], `${label}.${field}`);
  const input = basePrice('inputMicrosPerMillionTokens');
  const output = basePrice('outputMicrosPerMillionTokens');
  const cacheRead = optionalPrice(pricing.cacheReadMicrosPerMillionTokens, `${label}.cacheReadMicrosPerMillionTokens`);
  const cacheWrite = optionalPrice(pricing.cacheWriteMicrosPerMillionTokens, `${label}.cacheWriteMicrosPerMillionTokens`);
  const result: ProfilePricing = {
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadMicrosPerMillionTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteMicrosPerMillionTokens: cacheWrite })
  };
  if (pricing.tiers === undefined || pricing.tiers === null) return result;
  if (!Array.isArray(pricing.tiers) || pricing.tiers.length > MAX_PRICE_TIERS) {
    throw new Error(`${label}.tiers must be an array of at most ${MAX_PRICE_TIERS} tiers`);
  }
  let below: TokenPrices & { minPromptTokens: number } = {
    minPromptTokens: 0,
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    cacheReadMicrosPerMillionTokens: cacheRead ?? input,
    cacheWriteMicrosPerMillionTokens: cacheWrite ?? input
  };
  const tiers: PriceTier[] = [];
  for (let index = 0; index < pricing.tiers.length; index += 1) {
    const tierLabel = `${label}.tiers[${index}]`;
    const raw = object(pricing.tiers[index], tierLabel);
    if (options.strictKeys) exactKeys(raw, TIER_KEYS, tierLabel);
    const tierInput = price(raw.inputMicrosPerMillionTokens, `${tierLabel}.inputMicrosPerMillionTokens`);
    const tier: PriceTier = {
      minPromptTokens: integer(raw.minPromptTokens, `${tierLabel}.minPromptTokens`, 1, 10_000_000),
      inputMicrosPerMillionTokens: tierInput,
      outputMicrosPerMillionTokens: price(raw.outputMicrosPerMillionTokens, `${tierLabel}.outputMicrosPerMillionTokens`),
      cacheReadMicrosPerMillionTokens: optionalPrice(raw.cacheReadMicrosPerMillionTokens, `${tierLabel}.cacheReadMicrosPerMillionTokens`) ?? tierInput,
      cacheWriteMicrosPerMillionTokens: optionalPrice(raw.cacheWriteMicrosPerMillionTokens, `${tierLabel}.cacheWriteMicrosPerMillionTokens`) ?? tierInput
    };
    if (tier.minPromptTokens <= below.minPromptTokens) throw new Error(`${tierLabel}.minPromptTokens must be strictly ascending`);
    for (const field of PRICE_FIELDS) {
      if (tier[field] < below[field]) throw new Error(`${tierLabel}.${field} must not be lower than the tier below`);
    }
    tiers.push(tier);
    below = tier;
  }
  return tiers.length === 0 ? result : { ...result, tiers };
}

async function exactRegularFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must name an exact regular file`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must not traverse symlinks`);
  return canonical;
}

export async function readExactSecret(path: string): Promise<string> {
  const canonical = await exactRegularFile(path, 'credentialFile');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('credentialFile changed before read');
    const value = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(value) > 65_536) throw new Error('credential file exceeds 64 KiB');
    const trimmed = value.trim();
    if (trimmed.length < 8 || /[\0\r\n]/u.test(trimmed)) throw new Error('credential file contains an invalid value');
    return trimmed;
  } finally {
    await handle.close();
  }
}

async function parseProfile(raw: unknown, mode: GatewayMode, index: number): Promise<GatewayProfile> {
  const value = object(raw, `profiles[${index}]`);
  exactKeys(value, PROFILE_KEYS, `profiles[${index}]`);
  const id = string(value.id, `profiles[${index}].id`, 80);
  if (!ID_PATTERN.test(id)) throw new Error(`profiles[${index}].id is invalid`);
  const upstreamSource = string(value.upstreamUrl, `profiles[${index}].upstreamUrl`, 2048);
  if (/%(?:2e|2f|5c)|\\/iu.test(upstreamSource)) throw new Error(`profiles[${index}].upstreamUrl contains an unsafe encoded path`);
  const upstream = new URL(upstreamSource);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.hash || upstream.search) {
    throw new Error(`profiles[${index}].upstreamUrl must be an HTTPS URL without credentials, query, or fragment`);
  }
  if (upstream.pathname === '/' || upstream.pathname.endsWith('/')) throw new Error(`profiles[${index}].upstreamUrl must include one fixed request path`);
  const testOnly = boolean(value.testOnly, `profiles[${index}].testOnly`);
  const allowPrivateUpstream = boolean(value.allowPrivateUpstream, `profiles[${index}].allowPrivateUpstream`);
  const tlsCaFile = value.tlsCaFile === undefined ? undefined : string(value.tlsCaFile, `profiles[${index}].tlsCaFile`, 1024);
  const credentialFile = string(value.credentialFile, `profiles[${index}].credentialFile`, 1024);
  if (mode === 'production') {
    if (testOnly || allowPrivateUpstream || tlsCaFile !== undefined) throw new Error(`production profile ${id} cannot enable test upstream controls`);
    if (upstream.port !== '' && upstream.port !== '443') throw new Error(`production profile ${id} must use the default HTTPS port`);
    assertProductionHostname(upstream.hostname);
    if (credentialFile !== '/run/model-gateway-secrets/provider-api-key') {
      throw new Error(`production profile ${id} must use the exact gateway credential file`);
    }
  } else {
    if (!testOnly || !allowPrivateUpstream || tlsCaFile !== '/run/model-gateway-test-tls/server-cert.pem') {
      throw new Error(`test profile ${id} must use the explicit test-only private upstream and CA path`);
    }
    if (credentialFile !== '/run/model-gateway-test-secrets/provider-api-key') {
      throw new Error(`test profile ${id} must use the exact test credential file`);
    }
  }
  const pricing = parsePricing(value.pricing, `profiles[${index}].pricing`, { strictKeys: true });
  const limitsValue = object(value.limits, `profiles[${index}].limits`);
  exactKeys(limitsValue, LIMIT_KEYS, `profiles[${index}].limits`);
  const limits: ProfileLimits = {
    maxRequestBytes: integer(limitsValue.maxRequestBytes, 'maxRequestBytes', 1_024, 16_777_216),
    maxResponseBytes: integer(limitsValue.maxResponseBytes, 'maxResponseBytes', 1_024, 67_108_864),
    maxHeaderBytes: integer(limitsValue.maxHeaderBytes, 'maxHeaderBytes', 1_024, 65_536),
    maxHeaders: integer(limitsValue.maxHeaders, 'maxHeaders', 1, 128),
    deadlineMs: integer(limitsValue.deadlineMs, 'deadlineMs', 1_000, 600_000),
    maxInputTokens: integer(limitsValue.maxInputTokens, 'maxInputTokens', 1, 10_000_000),
    maxOutputTokens: integer(limitsValue.maxOutputTokens, 'maxOutputTokens', 1, 2_000_000),
    maxCostMicros: integer(limitsValue.maxCostMicros, 'maxCostMicros', 0, 1_000_000_000_000),
    maxStreamLineBytes: integer(limitsValue.maxStreamLineBytes, 'maxStreamLineBytes', 128, 1_048_576)
  };
  await exactRegularFile(credentialFile, `profiles[${index}].credentialFile`);
  if (tlsCaFile !== undefined) await exactRegularFile(tlsCaFile, `profiles[${index}].tlsCaFile`);
  const downstreamPath = value.downstreamPath;
  if (downstreamPath !== '/v1/chat/completions' && downstreamPath !== '/v1/responses') throw new Error('downstreamPath is unsupported');
  const credentialHeader = value.credentialHeader;
  if (credentialHeader !== 'authorization' && credentialHeader !== 'x-api-key') throw new Error('credentialHeader is unsupported');
  const credentialScheme = value.credentialScheme;
  if (credentialScheme !== '' && credentialScheme !== 'Bearer') throw new Error('credentialScheme is unsupported');
  return {
    id,
    provider: string(value.provider, `profiles[${index}].provider`, 64),
    model: string(value.model, `profiles[${index}].model`, 256),
    downstreamPath,
    upstream,
    credentialFile,
    credentialHeader,
    credentialScheme,
    ...pricing,
    limits,
    testOnly,
    allowPrivateUpstream,
    ...(tlsCaFile === undefined ? {} : { tlsCaFile })
  };
}

// Headers the gateway sets itself, plus hop-by-hop, framing, encoding, proxy and cookie
// headers a session header must never be able to set or override.
const RESERVED_UPSTREAM_HEADERS: Record<string, true> = {
  accept: true, 'content-type': true, 'content-length': true, host: true,
  'user-agent': true, authorization: true, 'x-api-key': true,
  'transfer-encoding': true, te: true, connection: true, 'keep-alive': true, upgrade: true,
  trailer: true, expect: true, 'proxy-authorization': true, 'proxy-connection': true,
  cookie: true, 'accept-encoding': true, 'content-encoding': true
};

/**
 * Validates a provider session header name, which the gateway fills with the calling
 * agent id. It must be a plain lowercase header name and must not collide with a
 * header the gateway sets itself. `source` names the setting in the error message.
 */
export function assertSessionHeaderName(value: string, source: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(value)) {
    throw new Error(`${source} must be a lowercase header name`);
  }
  if (RESERVED_UPSTREAM_HEADERS[value] === true) {
    throw new Error(`${source} must not be ${value}`);
  }
  return value;
}

/** `MODEL_GATEWAY_SESSION_HEADER` is the instance-wide fallback session header. */
function parseSessionHeader(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return assertSessionHeaderName(value, 'MODEL_GATEWAY_SESSION_HEADER');
}

export async function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
  const mode = env.MODEL_GATEWAY_MODE;
  if (mode !== 'production' && mode !== 'test') throw new Error('MODEL_GATEWAY_MODE must be production or test');

  const profiles = new Map<string, GatewayProfile>();
  const isDynamic = env.MODEL_GATEWAY_DYNAMIC_MODE === 'true' || Boolean(env.MODEL_GATEWAY_PROFILES_JSON) || !env.MODEL_GATEWAY_PROFILES_FILE;

  if (env.MODEL_GATEWAY_PROFILES_JSON) {
    const rawList = JSON.parse(env.MODEL_GATEWAY_PROFILES_JSON);
    if (Array.isArray(rawList)) {
      for (let index = 0; index < rawList.length; index += 1) {
        const profile = await parseProfile(rawList[index], mode, index);
        profiles.set(profile.id, profile);
      }
    }
  } else if (env.MODEL_GATEWAY_PROFILES_FILE) {
    const profileFile = string(env.MODEL_GATEWAY_PROFILES_FILE, 'MODEL_GATEWAY_PROFILES_FILE', 1024);
    await exactRegularFile(profileFile, 'MODEL_GATEWAY_PROFILES_FILE');
    const source = await readFile(profileFile, 'utf8');
    if (Buffer.byteLength(source) > 1_048_576) throw new Error('profile file exceeds 1 MiB');
    const root = object(JSON.parse(source) as unknown, 'profile file');
    exactKeys(root, CONFIG_KEYS, 'profile file');
    if (root.version !== 1) throw new Error('profile file version must be 1');
    if (root.mode !== mode) throw new Error('profile file mode must match MODEL_GATEWAY_MODE');
    if (!Array.isArray(root.profiles) || root.profiles.length < 1 || root.profiles.length > 64) throw new Error('profile file must contain 1 through 64 profiles');
    for (let index = 0; index < root.profiles.length; index += 1) {
      const profile = await parseProfile(root.profiles[index], mode, index);
      if (profiles.has(profile.id)) throw new Error(`duplicate profile ${profile.id}`);
      profiles.set(profile.id, profile);
    }
  } else if (!isDynamic) {
    throw new Error('MODEL_GATEWAY_PROFILES_FILE must be configured unless dynamic mode is enabled');
  }

  const controlSocket = env.MODEL_GATEWAY_CONTROL_SOCKET ?? '/tmp/model-gateway-control.sock';
  const sessionHeader = parseSessionHeader(env.MODEL_GATEWAY_SESSION_HEADER);
  return {
    mode,
    host: env.MODEL_GATEWAY_HOST ?? '0.0.0.0',
    port: integer(Number(env.MODEL_GATEWAY_PORT ?? '3210'), 'MODEL_GATEWAY_PORT', 1, 65_535),
    controlSocket,
    profiles,
    tlsCaFile: mode === 'test' ? env.MODEL_GATEWAY_TEST_TLS_CA_FILE : undefined,
    ...(sessionHeader === undefined ? {} : { sessionHeader })
  };
}
