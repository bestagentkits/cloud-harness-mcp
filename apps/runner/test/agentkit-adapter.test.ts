import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as signPayload, type KeyObject } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTKIT_PACKAGE_MAX_BYTES,
  canonicalAgentKitSignaturePayload,
  downloadAgentKitPackage,
  formatGoTime,
  parseAgentKitPublicKey,
  resolveAgentKitManifest,
  verifyAgentKitManifest,
  type AgentKitRegistryManifest
} from '../src/agentkit-registry.js';
import {
  AgentKitRegistryAdapter,
  AGENTKIT_EXTRACTED_MAX_BYTES,
  AGENTKIT_EXTRACTED_MAX_FILES,
  AGENTKIT_EXTRACTED_MAX_FILE_BYTES,
  assertExtractedKitTree,
  assertPackageSizeBounds,
  assertSafePackageNames,
  parsePackageSizeListing
} from '../src/adapters/agentkit-adapter.js';

const runDockerMock = vi.fn();
vi.mock('../src/docker-engine.js', () => ({
  runDocker: (...args: unknown[]) => runDockerMock(...args)
}));

const KIT_ID = 'engineer';
const CHANNEL = 'beta';
const VERSION = '2.17.0-beta.10';
const SOURCE_COMMIT = 'a'.repeat(40);
const ARTIFACT_URL =
  'https://acct.r2.cloudflarestorage.com/agentkits-staging/kits/engineer/cloud-harness/2.17.0-beta.10/kit.tar.gz?X-Amz-Signature=abc&X-Amz-Credential=def%2Fghi';
const CREATED_AT = '2026-09-17T00:00:00Z';
/** Fixed expiry for the frozen-payload fixtures; live fixtures use a fresh window. */
const FIXED_EXPIRES_AT = '2026-09-17T00:10:00Z';

/**
 * Canonical payload written out by hand from the registry signer's contract
 * (field order, omitted optionals, Go `encoding/json` HTML escaping of `&`).
 * Kept independent of the implementation so a field-order or escaping
 * regression fails here instead of round-tripping silently.
 */
function frozenPayload(input: {
  sha256: string;
  size: number;
  tier?: 'paid';
  withCollections?: boolean;
  expiresAt?: string;
}): string {
  const expiresAt = input.expiresAt ?? FIXED_EXPIRES_AT;
  const tier = input.tier === 'paid' ? '"tier":"paid",' : '';
  if (!input.withCollections) {
    return `{"schemaVersion":"remote-registry.v1","kitId":"engineer",${tier}"runtime":"cloud-harness","version":"${VERSION}","channel":"${CHANNEL}","adapterSchemaVersion":"agentkit-adapter.v1","requiredCliVersion":"2.17.0","sourceCommit":"${SOURCE_COMMIT}","createdAt":"${CREATED_AT}","artifactUrl":"https://acct.r2.cloudflarestorage.com/agentkits-staging/kits/engineer/cloud-harness/2.17.0-beta.10/kit.tar.gz?X-Amz-Signature=abc\\u0026X-Amz-Credential=def%2Fghi","artifactSha256":"${input.sha256}","artifactSize":${input.size},"artifactExpiresAt":"${expiresAt}"}`;
  }
  return `{"schemaVersion":"remote-registry.v1","kitId":"engineer",${tier}"runtime":"cloud-harness","version":"${VERSION}","channel":"${CHANNEL}","adapterSchemaVersion":"agentkit-adapter.v1","requiredCliVersion":"2.17.0","sourceCommit":"${SOURCE_COMMIT}","createdAt":"${CREATED_AT}","artifactUrl":"https://acct.r2.cloudflarestorage.com/agentkits-staging/kits/engineer/cloud-harness/2.17.0-beta.10/kit.tar.gz?X-Amz-Signature=abc\\u0026X-Amz-Credential=def%2Fghi","artifactSha256":"${input.sha256}","artifactSize":${input.size},"artifactExpiresAt":"${expiresAt}","dependencies":[{"kitId":"core","version":"2.17.0","sha256":"${'b'.repeat(64)}"}],"resolvedFrom":[{"kitId":"core","version":"2.17.0"}],"githubAssets":[{"kind":"archive","name":"agentkit-kit-engineer-cloud-harness-${VERSION}.tar.gz","sha256":"${input.sha256}","size":${input.size}}]}`;
}

/**
 * Registry timestamps are RFC3339 with trailing fractional zeros trimmed (Go `time.Time`), and the
 * runner canonicalizes the signed payload exactly the same way. A live fixture must therefore sign
 * that form: a raw `toISOString()` such as `:23.450Z` canonicalizes to `:23.45Z`, so verification
 * failed whenever the live milliseconds ended in zero.
 */
function goTimestamp(date: Date): string {
  const iso = date.toISOString();
  if (iso.endsWith('.000Z')) return iso.replace('.000Z', 'Z');
  return iso.replace(/(\.\d*?[1-9])0+Z$/, '$1Z');
}

function signedManifest(input: {
  packageBytes: Buffer;
  privateKey: KeyObject;
  keyId: string;
  withCollections?: boolean;
  tier?: 'paid';
  expiresAt?: string;
}): AgentKitRegistryManifest {
  const expiresAt = input.expiresAt ?? goTimestamp(new Date(Date.now() + 600_000));
  const sha256 = createHash('sha256').update(input.packageBytes).digest('hex');
  const payload = frozenPayload({
    sha256,
    size: input.packageBytes.byteLength,
    expiresAt,
    ...(input.tier ? { tier: input.tier } : {}),
    ...(input.withCollections ? { withCollections: true } : {})
  });
  const signature = signPayload(null, Buffer.from(payload, 'utf8'), input.privateKey).toString('base64');
  return {
    schemaVersion: 'remote-registry.v1',
    kitId: KIT_ID,
    ...(input.tier ? { tier: input.tier } : {}),
    runtime: 'cloud-harness',
    version: VERSION,
    channel: CHANNEL,
    adapterSchemaVersion: 'agentkit-adapter.v1',
    requiredCliVersion: '2.17.0',
    sourceCommit: SOURCE_COMMIT,
    createdAt: CREATED_AT,
    ...(input.withCollections
      ? {
        dependencies: [{ kitId: 'core', version: '2.17.0', sha256: 'b'.repeat(64) }],
        resolvedFrom: [{ kitId: 'core', version: '2.17.0' }],
        githubAssets: [{
          kind: 'archive',
          name: `agentkit-kit-engineer-cloud-harness-${VERSION}.tar.gz`,
          sha256,
          size: input.packageBytes.byteLength
        }]
      }
      : {}),
    artifact: {
      url: ARTIFACT_URL,
      sha256,
      size: input.packageBytes.byteLength,
      signature,
      signatureAlgorithm: 'ed25519',
      keyId: input.keyId,
      expiresAt
    }
  };
}

const keyId = 'agentkit-registry-2026';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const packageFixture = Buffer.from('kit-package-bytes');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AgentKit version pinning', () => {
  const resolve = (version: string | undefined) => resolveAgentKitManifest({
    registryUrl: 'https://agentkit.best',
    kitId: KIT_ID,
    channel: CHANNEL,
    ...(version ? { version } : {}),
    credential: 'ak_dev_test_credential',
    credentialSecretName: 'AGENTKIT_REGISTRY_TOKEN',
    fetchImpl: (async () => jsonResponse(signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' }))) as unknown as typeof fetch
  });

  it('rejects a signed manifest whose version differs from an explicit pin', async () => {
    await expect(resolve('9.9.9')).rejects.toThrow(/pinned request 9\.9\.9/);
  });

  it('accepts a v-prefixed pin that matches the manifest version', async () => {
    await expect(resolve(`v${VERSION}`)).resolves.toMatchObject({ version: VERSION });
  });
});

describe('AgentKit pre-extraction archive size bounds', () => {
  it('parses the sizing helper output', () => {
    expect(parsePackageSizeListing('3 1024 512\n')).toEqual({ files: 3, totalBytes: 1024, maxFileBytes: 512 });
    expect(() => parsePackageSizeListing('not-a-listing')).toThrow(/did not report usable uncompressed sizes/);
  });

  it('rejects an archive that declares more members, bytes, or one file than the ceiling', () => {
    expect(() => assertPackageSizeBounds(AGENTKIT_EXTRACTED_MAX_FILES + 1, 1, 1)).toThrow(/archive members/);
    expect(() => assertPackageSizeBounds(1, AGENTKIT_EXTRACTED_MAX_BYTES + 1, 1)).toThrow(/uncompressed bytes/);
    expect(() => assertPackageSizeBounds(1, 1, AGENTKIT_EXTRACTED_MAX_FILE_BYTES + 1)).toThrow(/per-file ceiling/);
    expect(() => assertPackageSizeBounds(1, 1, 1)).not.toThrow();
  });
});

describe('AgentKit manifest signature verification', () => {
  it('reproduces the frozen canonical payload byte for byte', () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid', expiresAt: FIXED_EXPIRES_AT });
    expect(canonicalAgentKitSignaturePayload(manifest)).toBe(frozenPayload({
      sha256: manifest.artifact.sha256,
      size: packageFixture.byteLength,
      tier: 'paid'
    }));
  });

  it('covers dependency, resolvedFrom and githubAssets collections', () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid', withCollections: true, expiresAt: FIXED_EXPIRES_AT });
    expect(canonicalAgentKitSignaturePayload(manifest)).toBe(frozenPayload({
      sha256: manifest.artifact.sha256,
      size: packageFixture.byteLength,
      tier: 'paid',
      withCollections: true
    }));
  });

  it('accepts a payload signed by the pinned key', () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    expect(() => verifyAgentKitManifest(manifest, {
      keyId,
      publicKey: parseAgentKitPublicKey(publicKeyB64)
    })).not.toThrow();
  });

  it('verifies a live-clock expiry whose milliseconds end in zero', () => {
    // Regression: the fixture signed a raw `toISOString()`, so `:19:23.450Z` was signed while
    // verification canonicalized it to `:19:23.45Z`. That flake redded the required `quality`
    // check on roughly one run in ten, and it is reproduced deterministically here.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:09:23.450Z'));
    try {
      const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
      expect(() => verifyAgentKitManifest(manifest, {
        keyId,
        publicKey: parseAgentKitPublicKey(publicKeyB64)
      })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a tampered artifact digest, a foreign key id, and a foreign key', () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const pinned = parseAgentKitPublicKey(publicKeyB64);

    const tampered = { ...manifest, artifact: { ...manifest.artifact, sha256: 'c'.repeat(64) } };
    expect(() => verifyAgentKitManifest(tampered, { keyId, publicKey: pinned })).toThrow('signature did not verify');

    const foreignKey = { ...manifest, artifact: { ...manifest.artifact, keyId: 'other-key' } };
    expect(() => verifyAgentKitManifest(foreignKey, { keyId, publicKey: pinned })).toThrow('pinned key is');

    const otherKeys = generateKeyPairSync('ed25519');
    expect(() => verifyAgentKitManifest(manifest, {
      keyId,
      publicKey: parseAgentKitPublicKey(otherKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))
    })).toThrow('signature did not verify');
  });

  it('normalizes Go timestamps the way the signer does', () => {
    expect(formatGoTime('2026-09-17T00:00:00.000Z')).toBe('2026-09-17T00:00:00Z');
    expect(formatGoTime('2026-09-17T00:00:00.120Z')).toBe('2026-09-17T00:00:00.12Z');
  });
});

describe('AgentKit registry resolve', () => {
  const base = {
    registryUrl: 'https://agentkit.best',
    kitId: KIT_ID,
    channel: CHANNEL as const,
    credential: 'ak_dev_test',
    credentialSecretName: 'AGENTKIT_REGISTRY_TOKEN'
  };

  it('requests the cloud-harness runtime for the requested channel and returns the manifest', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/agentkit/kits/engineer/resolve');
      expect(parsed.searchParams.get('runtime')).toBe('cloud-harness');
      expect(parsed.searchParams.get('channel')).toBe('beta');
      expect(parsed.searchParams.get('version')).toBeNull();
      return jsonResponse(manifest);
    });
    const resolved = await resolveAgentKitManifest({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(resolved.artifact.sha256).toBe(manifest.artifact.sha256);
  });

  it('passes an explicit version pin through to the registry', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url)).searchParams.get('version')).toBe(VERSION);
      return jsonResponse(manifest);
    });
    await resolveAgentKitManifest({ ...base, version: VERSION, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps registry error envelopes onto actionable harness errors', async () => {
    const unlicensed = vi.fn(async () => jsonResponse({ status: 'inactive', errorCode: 'not_licensed' }, 403));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: unlicensed as unknown as typeof fetch }))
      .rejects.toThrow('AGENTKIT_REGISTRY_TOKEN');

    const missing = vi.fn(async () => jsonResponse({ status: 'inactive', errorCode: 'version_not_available' }, 404));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: missing as unknown as typeof fetch }))
      .rejects.toThrow('no published release');

    const broken = vi.fn(async () => jsonResponse({ status: 'inactive', errorCode: 'registry_disabled' }, 400));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: broken as unknown as typeof fetch }))
      .rejects.toThrow('resolve is disabled');
  });

  it('rejects a manifest that does not match the request or the pinned runtime', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const wrongChannel = vi.fn(async () => jsonResponse({ ...manifest, channel: 'stable' }));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: wrongChannel as unknown as typeof fetch }))
      .rejects.toThrow('returned channel');

    const wrongRuntime = vi.fn(async () => jsonResponse({ ...manifest, runtime: 'codex' }));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: wrongRuntime as unknown as typeof fetch }))
      .rejects.toThrow('returned runtime');

    const freeTier = vi.fn(async () => jsonResponse({ ...manifest, tier: undefined }));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: freeTier as unknown as typeof fetch }))
      .rejects.toThrow('licensed (paid) release');
  });

  it('rejects an expired artifact URL and a non-HTTPS artifact URL', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const expired = vi.fn(async () => jsonResponse({
      ...manifest,
      artifact: { ...manifest.artifact, expiresAt: '2020-01-01T00:00:00Z' }
    }));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: expired as unknown as typeof fetch }))
      .rejects.toThrow('already-expired');

    const insecure = vi.fn(async () => jsonResponse({
      ...manifest,
      artifact: { ...manifest.artifact, url: 'http://acct.r2.cloudflarestorage.com/kit.tar.gz' }
    }));
    await expect(resolveAgentKitManifest({ ...base, fetchImpl: insecure as unknown as typeof fetch }))
      .rejects.toThrow('must use HTTPS');
  });
});

describe('AgentKit package download', () => {
  it('accepts bytes that match the signed digest and size', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const fetchImpl = vi.fn(async () => new Response(packageFixture));
    const bytes = await downloadAgentKitPackage(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(bytes.equals(packageFixture)).toBe(true);
  });

  it('rejects bytes whose digest or size does not match the signed manifest', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    const tampered = vi.fn(async () => new Response(Buffer.from('kit-package-bytez')));
    await expect(downloadAgentKitPackage(manifest, { fetchImpl: tampered as unknown as typeof fetch }))
      .rejects.toThrow('did not match the signed manifest');
  });

  it('stops an oversized stream at the staging byte ceiling', async () => {
    const big = Buffer.alloc(AGENTKIT_PACKAGE_MAX_BYTES + 1, 1);
    const manifest = signedManifest({ packageBytes: big, privateKey, keyId, tier: 'paid' });
    const fetchImpl = vi.fn(async () => new Response(big));
    await expect(downloadAgentKitPackage(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow('byte ceiling');
  });
});

describe('AgentKit package member validation', () => {
  it('accepts package members under the kit root', () => {
    expect(assertSafePackageNames(['engineer/kit.yaml', 'engineer/skills/ak-deploy/SKILL.md'], KIT_ID))
      .toEqual(['engineer/kit.yaml', 'engineer/skills/ak-deploy/SKILL.md']);
  });

  it('accepts the directory entries GNU tar emits, including the bare kit root', () => {
    expect(assertSafePackageNames([
      'engineer/',
      'engineer/kit.yaml',
      'engineer/skills/',
      'engineer/skills/ak-deploy/',
      'engineer/skills/ak-deploy/SKILL.md'
    ], KIT_ID)).toHaveLength(5);
  });

  it('rejects escapes, absolutes, foreign roots, and repeated members', () => {
    expect(() => assertSafePackageNames([], KIT_ID)).toThrow('archive is empty');
    expect(() => assertSafePackageNames(['/etc/passwd'], KIT_ID)).toThrow('not relative');
    expect(() => assertSafePackageNames(['engineer/../../etc/passwd'], KIT_ID)).toThrow('escapes its root');
    expect(() => assertSafePackageNames(['engineer\\kit.yaml'], KIT_ID)).toThrow('not relative');
    expect(() => assertSafePackageNames(['core/kit.yaml'], KIT_ID)).toThrow('outside the engineer root');
    expect(() => assertSafePackageNames(['engineer/SKILL.md', 'engineer/skill.md'], KIT_ID)).toThrow('repeats a member name');
  });

  it('requires exactly one kit root in the extracted tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'ch-agentkit-tree-'));
    try {
      mkdirSync(join(root, KIT_ID, 'skills', 'ak-deploy'), { recursive: true });
      writeFileSync(join(root, KIT_ID, 'skills', 'ak-deploy', 'SKILL.md'), '# ak-deploy');
      expect(() => assertExtractedKitTree(root, KIT_ID)).not.toThrow();

      mkdirSync(join(root, 'core'), { recursive: true });
      expect(() => assertExtractedKitTree(root, KIT_ID)).toThrow('exactly one engineer root directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AgentKitRegistryAdapter materialization', () => {
  let stagingDir: string;
  let extractDir: string;

  beforeEach(() => {
    stagingDir = mkdtempSync(join(tmpdir(), 'ch-agentkit-staging-'));
    extractDir = '';
    runDockerMock.mockReset();
  });

  afterEach(() => {
    rmSync(stagingDir, { recursive: true, force: true });
  });

  function packageTree(root: string, skills: string[]): string[] {
    const members: string[] = [`${KIT_ID}/kit.yaml`];
    mkdirSync(join(root, KIT_ID), { recursive: true });
    writeFileSync(join(root, KIT_ID, 'kit.yaml'), 'name: engineer\n');
    for (const skill of skills) {
      mkdirSync(join(root, KIT_ID, 'skills', skill), { recursive: true });
      writeFileSync(join(root, KIT_ID, 'skills', skill, 'SKILL.md'), `# ${skill}`);
      members.push(`${KIT_ID}/skills/${skill}/SKILL.md`);
    }
    return members;
  }

  /** Emulates the tar helper container: the listing returns members, the extraction copies the tree. */
  function mockTarHelper(members: string[], treeRoot: string): void {
    runDockerMock.mockImplementation(async (args: string[]) => {
      const command = args[args.indexOf('-c') + 1];
      const extractVolume = args.find((arg) => arg.endsWith(':/extract:rw'));
      const hostExtract = extractVolume?.replace(':/extract:rw', '') ?? '';
      if (command.includes('-tvzf')) {
        // Sizing pass: report a small declared uncompressed shape for the fixture members.
        return { stdout: `${members.length} ${members.length * 64} 64\n`, stderr: '', exitCode: 0, truncated: false };
      }
      if (command.includes('-tzf')) {
        return { stdout: `${members.join('\n')}\n`, stderr: '', exitCode: 0, truncated: false };
      }
      extractDir = hostExtract;
      cpSync(join(treeRoot, KIT_ID), join(hostExtract, KIT_ID), { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    });
  }

  function adapter(): InstanceType<typeof AgentKitRegistryAdapter> {
    return new AgentKitRegistryAdapter({
      registryUrl: 'https://agentkit.best',
      keyId,
      publicKey: parseAgentKitPublicKey(publicKeyB64),
      executorImage: 'cloud-harness-executor:local',
      credentialSecretName: 'AGENTKIT_REGISTRY_TOKEN'
    });
  }

  it('projects packaged skills into staging and reports the signed package digest', async () => {
    const treeRoot = mkdtempSync(join(tmpdir(), 'ch-agentkit-tree-'));
    try {
      const members = packageTree(treeRoot, ['ak-deploy', 'ak-security']);
      mockTarHelper(members, treeRoot);
      const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
      const fetchImpl = vi.fn(async () => new Response(packageFixture));

      const result = await adapter().materialize(
        stagingDir,
        { kitId: KIT_ID, channel: CHANNEL },
        manifest,
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      );

      expect(result.manifest.skills.map((skill: { name: string }) => skill.name).sort()).toEqual(['ak-deploy', 'ak-security']);
      expect(result.manifest.packageSha256).toBe(manifest.artifact.sha256);
      expect(result.manifest.resolvedRevision).toBe(manifest.artifact.sha256);
      expect(result.manifest.archiveMembers).toBe(members.length);
      expect(result.fileCount).toBeGreaterThan(0);
      expect(result.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

      const stagedSkill = join(stagingDir, 'skills', 'ak-deploy', 'SKILL.md');
      expect(readFileSync(stagedSkill, 'utf8')).toBe('# ak-deploy');
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  it('honours the skill filter and drops the package scratch directory from the bundle', async () => {
    const treeRoot = mkdtempSync(join(tmpdir(), 'ch-agentkit-tree-'));
    try {
      const members = packageTree(treeRoot, ['ak-deploy', 'ak-security', 'ak-vibe']);
      mockTarHelper(members, treeRoot);
      const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
      const fetchImpl = vi.fn(async () => new Response(packageFixture));

      const result = await adapter().materialize(
        stagingDir,
        { kitId: KIT_ID, channel: CHANNEL, skills: { include: ['ak-deploy'] } },
        manifest,
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      );

      expect(result.manifest.skills.map((skill: { name: string }) => skill.name)).toEqual(['ak-deploy']);
      expect(existsSync(join(stagingDir, '__agentkit_package'))).toBe(false);
      expect(existsSync(join(stagingDir, 'skills', 'ak-security'))).toBe(false);
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  it('refuses a package whose members leave the kit root and never extracts it', async () => {
    const treeRoot = mkdtempSync(join(tmpdir(), 'ch-agentkit-tree-'));
    try {
      mockTarHelper([`${KIT_ID}/kit.yaml`, 'core/kit.yaml'], treeRoot);
      const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
      const fetchImpl = vi.fn(async () => new Response(packageFixture));

      await expect(adapter().materialize(
        stagingDir,
        { kitId: KIT_ID, channel: CHANNEL },
        manifest,
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )).rejects.toThrow('outside the engineer root');
      expect(runDockerMock).toHaveBeenCalledTimes(1);
      expect(extractDir).toBe('');
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the package carries no skills directory', async () => {
    const treeRoot = mkdtempSync(join(tmpdir(), 'ch-agentkit-tree-'));
    try {
      mkdirSync(join(treeRoot, KIT_ID), { recursive: true });
      writeFileSync(join(treeRoot, KIT_ID, 'kit.yaml'), 'name: engineer\n');
      mockTarHelper([`${KIT_ID}/kit.yaml`], treeRoot);
      const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
      const fetchImpl = vi.fn(async () => new Response(packageFixture));

      await expect(adapter().materialize(
        stagingDir,
        { kitId: KIT_ID, channel: CHANNEL },
        manifest,
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )).rejects.toThrow('no skills directory');
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  it('requires a registry credential before any registry call', async () => {
    const manifest = signedManifest({ packageBytes: packageFixture, privateKey, keyId, tier: 'paid' });
    await expect(adapter().acquireAndNormalize('owner-1', stagingDir, { kitId: KIT_ID, channel: CHANNEL }))
      .rejects.toThrow('AGENTKIT_REGISTRY_TOKEN');
    expect(runDockerMock).not.toHaveBeenCalled();
    expect(manifest.artifact.keyId).toBe(keyId);
  });
});
