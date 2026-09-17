import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { HarnessError } from '@cloud-harness/contracts';

/**
 * Client for the first-party AgentKit registry (`GET /api/agentkit/kits/{kitId}/resolve`).
 *
 * The registry returns a signed manifest plus a short-lived pre-signed artifact
 * URL. Two independent checks bind the bytes the harness mounts to the vendor's
 * signed identity:
 *
 * 1. the manifest signature (Ed25519 over a canonical JSON payload, reproduced
 *    field-for-field in `canonicalAgentKitSignaturePayload`), and
 * 2. the package digest published in that signed manifest.
 *
 * A caller that cannot reproduce the canonical payload cannot verify the
 * signature, so the canonicalization below mirrors the registry's signer
 * (`lib/agentkit-registry/manifest-signing.ts`) exactly, including Go's
 * `encoding/json` HTML escaping.
 */

const AGENTKIT_KIT_RUNTIME = 'cloud-harness';
const AGENTKIT_REGISTRY_SCHEMA_VERSION = 'remote-registry.v1';
const AGENTKIT_ADAPTER_SCHEMA_VERSION = 'agentkit-adapter.v1';

/** Matches `validateStagingDir`'s default byte ceiling so a package can never exceed the staging budget. */
export const AGENTKIT_PACKAGE_MAX_BYTES = 67_108_864;

const sha256Hash = z.string().regex(/^[a-f0-9]{64}$/);
const semver = z.string().regex(/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const dependencySchema = z.object({
  kitId: z.string().min(1).max(120),
  version: semver,
  sha256: sha256Hash.optional()
}).strip();

const githubAssetSchema = z.object({
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(256),
  sha256: sha256Hash,
  size: z.number().int().positive()
}).strip();

export const AgentKitRegistryManifestSchema = z.object({
  schemaVersion: z.literal(AGENTKIT_REGISTRY_SCHEMA_VERSION),
  kitId: z.string().min(1).max(120),
  tier: z.literal('paid').optional(),
  runtime: z.string().min(1).max(64),
  version: semver,
  channel: z.enum(['dev', 'beta', 'stable']),
  adapterSchemaVersion: z.literal(AGENTKIT_ADAPTER_SCHEMA_VERSION),
  requiredCliVersion: z.string().max(80),
  sourceCommit: z.string().min(7).max(40),
  createdAt: z.string().min(1),
  dependencies: z.array(dependencySchema).max(32).optional(),
  resolvedFrom: z.array(dependencySchema).max(32).optional(),
  githubAssets: z.array(githubAssetSchema).max(16).optional(),
  artifact: z.object({
    url: z.string().min(1),
    sha256: sha256Hash,
    size: z.number().int().positive().max(AGENTKIT_PACKAGE_MAX_BYTES),
    signature: z.string().min(1).max(1_024),
    signatureAlgorithm: z.literal('ed25519'),
    keyId: z.string().min(1).max(120),
    expiresAt: z.string().min(1)
  }).strip()
}).strip();

export type AgentKitRegistryManifest = z.infer<typeof AgentKitRegistryManifestSchema>;

/** Registry error envelopes are `{ status: 'inactive', errorCode }` with a non-2xx HTTP status. */
const registryErrorSchema = z.object({ errorCode: z.string().max(80).optional() }).strip();

/**
 * Go's `encoding/json` escapes `<`, `>`, `&` and the U+2028/U+2029 line
 * separators by default. `JSON.stringify` does not, and the signed artifact URL
 * contains `&`, so the payload only verifies when escaped identically.
 */
const GO_JSON_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
};
const GO_JSON_ESCAPE_RE = /[<>&\u2028\u2029]/g;

function escapeForGoJson(json: string): string {
  return json.replace(GO_JSON_ESCAPE_RE, (char) => GO_JSON_ESCAPES[char] as string);
}

/** Mirrors the registry's `formatGoTime`: ISO-8601 with trailing fractional zeros trimmed. */
export function formatGoTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new HarnessError('EXECUTION_FAILED', 'AgentKit manifest carries an unparseable timestamp', 502, false);
  }
  const iso = date.toISOString();
  if (iso.endsWith('.000Z')) return iso.replace('.000Z', 'Z');
  return iso.replace(/(\.\d*?[1-9])0+Z$/, '$1Z');
}

function canonicalDependency(dependency: z.infer<typeof dependencySchema>) {
  return {
    kitId: dependency.kitId,
    version: dependency.version,
    ...(dependency.sha256 ? { sha256: dependency.sha256 } : {})
  };
}

/**
 * Field order and presence rules mirror the registry signer. Optional fields are
 * omitted exactly when the signer omitted them, so a manifest is only accepted
 * when the signature reproduces byte-for-byte.
 */
export function canonicalAgentKitSignaturePayload(manifest: AgentKitRegistryManifest): string {
  return escapeForGoJson(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    kitId: manifest.kitId,
    ...(manifest.tier ? { tier: manifest.tier } : {}),
    runtime: manifest.runtime,
    version: manifest.version,
    channel: manifest.channel,
    adapterSchemaVersion: manifest.adapterSchemaVersion,
    requiredCliVersion: manifest.requiredCliVersion,
    sourceCommit: manifest.sourceCommit,
    createdAt: formatGoTime(manifest.createdAt),
    artifactUrl: manifest.artifact.url,
    artifactSha256: manifest.artifact.sha256,
    artifactSize: manifest.artifact.size,
    artifactExpiresAt: formatGoTime(manifest.artifact.expiresAt),
    ...(manifest.dependencies?.length
      ? { dependencies: manifest.dependencies.map(canonicalDependency) }
      : {}),
    ...(manifest.resolvedFrom?.length
      ? { resolvedFrom: manifest.resolvedFrom.map(canonicalDependency) }
      : {}),
    ...(manifest.githubAssets?.length
      ? {
        githubAssets: manifest.githubAssets.map((asset) => ({
          kind: asset.kind,
          name: asset.name,
          sha256: asset.sha256,
          size: asset.size
        }))
      }
      : {})
  }));
}

/** Accepts the registry's base64 PKCS#8 DER form or an armored PEM public key. */
export function parseAgentKitPublicKey(raw: string): KeyObject {
  const trimmed = raw.trim().replaceAll('\\n', '\n');
  try {
    if (trimmed.includes('BEGIN')) {
      return createPublicKey(trimmed);
    }
    return createPublicKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'spki'
    });
  } catch {
    throw new HarnessError(
      'INVALID_INPUT',
      'AGENTKIT_REGISTRY_PUBLIC_KEY is not a usable Ed25519 public key (expected PEM or base64 SPKI DER)',
      400,
      false
    );
  }
}

export function verifyAgentKitManifest(
  manifest: AgentKitRegistryManifest,
  options: { keyId: string; publicKey: KeyObject }
): void {
  if (manifest.artifact.keyId !== options.keyId) {
    throw new HarnessError(
      'UNAVAILABLE',
      `AgentKit manifest was signed by key ${manifest.artifact.keyId}; pinned key is ${options.keyId}`,
      503,
      false
    );
  }
  const payload = canonicalAgentKitSignaturePayload(manifest);
  const signed = verifySignature(
    null,
    Buffer.from(payload, 'utf8'),
    options.publicKey,
    Buffer.from(manifest.artifact.signature, 'base64')
  );
  if (!signed) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit manifest signature did not verify', 503, false);
  }
}

export type AgentKitResolveRequest = {
  registryUrl: string;
  kitId: string;
  channel: 'dev' | 'beta' | 'stable';
  version?: string | undefined;
  credential: string;
  credentialSecretName: string;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
};

function registryErrorToHarnessError(
  status: number,
  errorCode: string,
  request: { kitId: string; credentialSecretName: string }
): HarnessError {
  switch (errorCode) {
    case 'not_authenticated':
    case 'not_licensed':
    case 'license_inactive':
      return new HarnessError(
        'INVALID_INPUT',
        `AgentKit registry rejected the credential in secret ${request.credentialSecretName} for kit ${request.kitId} (${errorCode})`,
        400,
        false
      );
    case 'registry_disabled':
      return new HarnessError('UNAVAILABLE', `AgentKit registry resolve is disabled (${errorCode})`, 503, true);
    case 'unsupported_runtime':
      return new HarnessError('INVALID_INPUT', `AgentKit registry does not serve runtime ${AGENTKIT_KIT_RUNTIME} (${errorCode})`, 400, false);
    case 'version_not_available':
      return new HarnessError('NOT_FOUND', `AgentKit registry has no published release for kit ${request.kitId} (${errorCode})`, 404, false);
    default:
      return new HarnessError(
        'UNAVAILABLE',
        `AgentKit registry resolve failed with HTTP ${status}${errorCode ? ` (${errorCode})` : ''}`,
        status >= 500 ? 503 : 400,
        status >= 500
      );
  }
}

export async function resolveAgentKitManifest(request: AgentKitResolveRequest): Promise<AgentKitRegistryManifest> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const url = new URL(`${request.registryUrl.replace(/\/+$/, '')}/api/agentkit/kits/${encodeURIComponent(request.kitId)}/resolve`);
  url.searchParams.set('runtime', AGENTKIT_KIT_RUNTIME);
  url.searchParams.set('channel', request.channel);
  if (request.version) url.searchParams.set('version', request.version);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${request.credential}`,
        'agentkit-manifest-capabilities': 'tier-v1'
      },
      ...(request.signal ? { signal: request.signal } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown transport failure';
    throw new HarnessError('UNAVAILABLE', `AgentKit registry is unreachable: ${message}`, 503, true);
  }

  const body = await response.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = null;
  }
  if (!response.ok) {
    const parsed = registryErrorSchema.safeParse(parsedBody);
    const errorCode = parsed.success ? parsed.data.errorCode ?? '' : '';
    throw registryErrorToHarnessError(response.status, errorCode, request);
  }

  const parsed = AgentKitRegistryManifestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit registry returned an unusable manifest', 503, false);
  }
  const manifest = parsed.data;
  if (manifest.kitId !== request.kitId) {
    throw new HarnessError('UNAVAILABLE', `AgentKit registry returned kit ${manifest.kitId} for ${request.kitId}`, 503, false);
  }
  if (manifest.runtime !== AGENTKIT_KIT_RUNTIME) {
    throw new HarnessError('UNAVAILABLE', `AgentKit registry returned runtime ${manifest.runtime} for ${AGENTKIT_KIT_RUNTIME}`, 503, false);
  }
  if (manifest.channel !== request.channel) {
    throw new HarnessError('UNAVAILABLE', `AgentKit registry returned channel ${manifest.channel} for ${request.channel}`, 503, false);
  }
  if (manifest.tier !== 'paid') {
    throw new HarnessError('UNAVAILABLE', 'AgentKit registry did not identify the kit as a licensed (paid) release', 503, false);
  }
  const expiresAt = new Date(manifest.artifact.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit registry returned an already-expired artifact URL', 503, true);
  }
  let artifactUrl: URL;
  try {
    artifactUrl = new URL(manifest.artifact.url);
  } catch {
    throw new HarnessError('UNAVAILABLE', 'AgentKit registry returned an unparseable artifact URL', 503, false);
  }
  if (artifactUrl.protocol !== 'https:') {
    throw new HarnessError('UNAVAILABLE', 'AgentKit artifact URL must use HTTPS', 503, false);
  }
  return manifest;
}

/**
 * Streams the package, enforcing the size ceiling before the bytes are held and
 * verifying the digest from the signed manifest.
 */
export async function downloadAgentKitPackage(
  manifest: AgentKitRegistryManifest,
  options: { signal?: AbortSignal | undefined; fetchImpl?: typeof fetch | undefined } = {}
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(manifest.artifact.url, {
      method: 'GET',
      redirect: 'error',
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown transport failure';
    throw new HarnessError('UNAVAILABLE', `AgentKit package download failed: ${message}`, 503, true);
  }
  if (!response.ok) {
    throw new HarnessError('UNAVAILABLE', `AgentKit package download failed with HTTP ${response.status}`, 503, true);
  }
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > AGENTKIT_PACKAGE_MAX_BYTES) {
    throw new HarnessError('INVALID_INPUT', 'AgentKit package exceeds the toolkit staging byte ceiling', 400, false);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    total = buffer.byteLength;
    if (total > AGENTKIT_PACKAGE_MAX_BYTES) {
      throw new HarnessError('INVALID_INPUT', 'AgentKit package exceeds the toolkit staging byte ceiling', 400, false);
    }
    return assertPackageDigest(buffer, manifest);
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > AGENTKIT_PACKAGE_MAX_BYTES) {
        throw new HarnessError('INVALID_INPUT', 'AgentKit package exceeds the toolkit staging byte ceiling', 400, false);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks, total);
  if (declared !== null && Number.isFinite(declared) && declared !== total) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package length did not match its declared size', 503, true);
  }
  return assertPackageDigest(buffer, manifest);
}

function assertPackageDigest(buffer: Buffer, manifest: AgentKitRegistryManifest): Buffer {
  if (buffer.byteLength !== manifest.artifact.size) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package size did not match the signed manifest', 503, true);
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== manifest.artifact.sha256) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package digest did not match the signed manifest', 503, true);
  }
  return buffer;
}
