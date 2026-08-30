import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import type { GatewayConfig, GatewayMode, GatewayProfile, ProfileLimits } from './types.js';

const PROFILE_KEYS: Record<string, true> = {
  id: true, provider: true, model: true, downstreamPath: true, upstreamUrl: true,
  credentialFile: true, credentialHeader: true, credentialScheme: true, pricing: true,
  limits: true, testOnly: true, allowPrivateUpstream: true, tlsCaFile: true
};
const PRICING_KEYS: Record<string, true> = {
  inputMicrosPerMillionTokens: true,
  outputMicrosPerMillionTokens: true
};
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

export function isUnsafeAddress(address: string): boolean {
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

export function assertProductionHostname(hostname: string): void {
  const lower = hostname.toLowerCase().replace(/\.$/u, '');
  const unsafeSuffixes = ['.localhost', '.local', '.internal', '.home', '.lan', '.corp', '.test', '.invalid', '.example', '.arpa'];
  if (lower === 'localhost' || unsafeSuffixes.some((suffix) => lower.endsWith(suffix)) ||
      lower === 'metadata.google.internal' || !lower.includes('.')) {
    throw new Error('production upstream hostname is private or non-public');
  }
  if (isIP(lower) !== 0 && isUnsafeAddress(lower)) throw new Error('production upstream address is private or reserved');
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
  const pricing = object(value.pricing, `profiles[${index}].pricing`);
  exactKeys(pricing, PRICING_KEYS, `profiles[${index}].pricing`);
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
    inputMicrosPerMillionTokens: integer(pricing.inputMicrosPerMillionTokens, 'inputMicrosPerMillionTokens', 0, 1_000_000_000),
    outputMicrosPerMillionTokens: integer(pricing.outputMicrosPerMillionTokens, 'outputMicrosPerMillionTokens', 0, 1_000_000_000),
    limits,
    testOnly,
    allowPrivateUpstream,
    ...(tlsCaFile === undefined ? {} : { tlsCaFile })
  };
}

export async function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
  const profileFile = string(env.MODEL_GATEWAY_PROFILES_FILE, 'MODEL_GATEWAY_PROFILES_FILE', 1024);
  await exactRegularFile(profileFile, 'MODEL_GATEWAY_PROFILES_FILE');
  const source = await readFile(profileFile, 'utf8');
  if (Buffer.byteLength(source) > 1_048_576) throw new Error('profile file exceeds 1 MiB');
  const root = object(JSON.parse(source) as unknown, 'profile file');
  exactKeys(root, CONFIG_KEYS, 'profile file');
  if (root.version !== 1) throw new Error('profile file version must be 1');
  const mode = env.MODEL_GATEWAY_MODE;
  if (mode !== 'production' && mode !== 'test') throw new Error('MODEL_GATEWAY_MODE must be production or test');
  if (root.mode !== mode) throw new Error('profile file mode must match MODEL_GATEWAY_MODE');
  if (!Array.isArray(root.profiles) || root.profiles.length < 1 || root.profiles.length > 64) throw new Error('profile file must contain 1 through 64 profiles');
  const profiles = new Map<string, GatewayProfile>();
  for (let index = 0; index < root.profiles.length; index += 1) {
    const profile = await parseProfile(root.profiles[index], mode, index);
    if (profiles.has(profile.id)) throw new Error(`duplicate profile ${profile.id}`);
    profiles.set(profile.id, profile);
  }
  const controlSocket = env.MODEL_GATEWAY_CONTROL_SOCKET ?? '/tmp/model-gateway-control.sock';
  if (!/^\/tmp\/[a-zA-Z0-9._-]+\.sock$/u.test(controlSocket)) {
    throw new Error('MODEL_GATEWAY_CONTROL_SOCKET must be an exact socket path under /tmp');
  }
  return {
    mode,
    host: env.MODEL_GATEWAY_HOST ?? '0.0.0.0',
    port: integer(Number(env.MODEL_GATEWAY_PORT ?? '3210'), 'MODEL_GATEWAY_PORT', 1, 65_535),
    controlSocket,
    profiles
  };
}
