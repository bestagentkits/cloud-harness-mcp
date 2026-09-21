import { createHash, type KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import {
  AGENTKIT_PACKAGE_MAX_BYTES,
  downloadAgentKitPackage,
  resolveAgentKitManifest,
  verifyAgentKitManifest,
  type AgentKitRegistryManifest
} from '../agentkit-registry.js';
import { runDocker } from '../docker-engine.js';
import {
  computeFullTreeDigest,
  validateStagingDir,
  type ToolkitAdapterResult
} from './mattpocock-adapter.js';

export type AgentKitAdapterSpec = {
  kitId: 'engineer' | 'marketing';
  channel: 'dev' | 'beta' | 'stable';
  version?: string | undefined;
  skills?: { include?: string[] | undefined; exclude?: string[] | undefined } | undefined;
};

const PACKAGE_DIR = '__agentkit_package';
const PACKAGE_FILE = 'kit.tar.gz';

/**
 * Bounds applied to the archive's *declared* uncompressed size before any byte is extracted. The
 * compressed artifact is already capped at `AGENTKIT_PACKAGE_MAX_BYTES`, but a highly compressible
 * archive can expand far past the staging ceiling, so the declared sizes are summed first and the
 * extraction only runs when they fit.
 */
export const AGENTKIT_EXTRACTED_MAX_BYTES = 536_870_912;
export const AGENTKIT_EXTRACTED_MAX_FILES = 20_000;
export const AGENTKIT_EXTRACTED_MAX_FILE_BYTES = 134_217_728;

/** Reads the `files totalBytes maxFileBytes` line the sizing helper prints from `tar -tvzf`. */
export function parsePackageSizeListing(stdout: string): { files: number; totalBytes: number; maxFileBytes: number } {
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(stdout.trim());
  if (!match) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package listing did not report usable uncompressed sizes', 503, false);
  }
  return { files: Number(match[1]), totalBytes: Number(match[2]), maxFileBytes: Number(match[3]) };
}

/** Rejects an archive whose declared uncompressed shape exceeds the staging budget, before extraction. */
export function assertPackageSizeBounds(files: number, totalBytes: number, maxFileBytes: number): void {
  if (!Number.isFinite(files) || !Number.isFinite(totalBytes) || !Number.isFinite(maxFileBytes)) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package listing did not report usable uncompressed sizes', 503, false);
  }
  if (files > AGENTKIT_EXTRACTED_MAX_FILES) {
    throw new HarnessError('UNAVAILABLE', `AgentKit package declares ${files} archive members, above the ${AGENTKIT_EXTRACTED_MAX_FILES} ceiling`, 503, false);
  }
  if (totalBytes > AGENTKIT_EXTRACTED_MAX_BYTES) {
    throw new HarnessError('UNAVAILABLE', `AgentKit package declares ${totalBytes} uncompressed bytes, above the ${AGENTKIT_EXTRACTED_MAX_BYTES} ceiling`, 503, false);
  }
  if (maxFileBytes > AGENTKIT_EXTRACTED_MAX_FILE_BYTES) {
    throw new HarnessError('UNAVAILABLE', `AgentKit package declares a ${maxFileBytes}-byte member, above the ${AGENTKIT_EXTRACTED_MAX_FILE_BYTES} per-file ceiling`, 503, false);
  }
}

/**
 * Validates the archive member list before extraction. A member name that is
 * absolute, contains a `..` segment, or uses backslashes could write outside the
 * extraction root, so the package is rejected before any byte is unpacked.
 */
export function assertSafePackageNames(names: string[], kitId: string): string[] {
  if (names.length === 0) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package archive is empty', 503, false);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\/+$/, '');
    if (name.length === 0) {
      throw new HarnessError('UNAVAILABLE', 'AgentKit package archive contains an empty member name', 503, false);
    }
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
      throw new HarnessError('UNAVAILABLE', `AgentKit package archive member is not relative: ${raw}`, 503, false);
    }
    const segments = name.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
      throw new HarnessError('UNAVAILABLE', `AgentKit package archive member escapes its root: ${raw}`, 503, false);
    }
    if (segments[0] !== kitId) {
      throw new HarnessError(
        'UNAVAILABLE',
        `AgentKit package archive member is outside the ${kitId} root: ${raw}`,
        503,
        false
      );
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) {
      throw new HarnessError('UNAVAILABLE', `AgentKit package archive repeats a member name: ${name}`, 503, false);
    }
    seen.add(folded);
    normalized.push(name);
  }
  return normalized;
}

/**
 * The packaged kit is the only top-level root, and the archive must not carry
 * pipes, sockets, or device nodes: those are neither part of the package format
 * nor safe to copy into a content-addressed cache.
 */
export function assertExtractedKitTree(root: string, kitId: string): void {
  const topLevel = readdirSync(root, { withFileTypes: true });
  if (topLevel.length !== 1 || !topLevel[0]?.isDirectory() || topLevel[0].name !== kitId) {
    throw new HarnessError(
      'UNAVAILABLE',
      `AgentKit package must contain exactly one ${kitId} root directory`,
      503,
      false
    );
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) continue;
      throw new HarnessError(
        'UNAVAILABLE',
        `AgentKit package contains an unsupported entry type: ${entry.name}`,
        503,
        false
      );
    }
  };
  walk(join(root, kitId));
}

/** A packaged skill is any directory under `<kit>/skills` that carries a `SKILL.md`. */
export function discoverPackagedSkills(skillRoot: string): Array<{ name: string; sourceDir: string }> {
  if (!existsSync(skillRoot) || !lstatSync(skillRoot).isDirectory()) {
    throw new HarnessError('UNAVAILABLE', 'AgentKit package has no skills directory', 503, false);
  }
  const discovered: Array<{ name: string; sourceDir: string }> = [];
  const scan = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      discovered.push({ name: basename(dir), sourceDir: dir });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) scan(join(dir, entry.name));
    }
  };
  scan(skillRoot);
  return discovered;
}

export class AgentKitRegistryAdapter {
  static readonly ADAPTER_VERSION = 1;

  private readonly registryUrl: string;
  private readonly keyId: string;
  private readonly publicKey: KeyObject;
  private readonly executorImage: string;
  readonly credentialSecretName: string;

  constructor(options: {
    registryUrl: string;
    keyId: string;
    publicKey: KeyObject;
    executorImage: string;
    credentialSecretName: string;
  }) {
    this.registryUrl = options.registryUrl;
    this.keyId = options.keyId;
    this.publicKey = options.publicKey;
    this.executorImage = options.executorImage;
    this.credentialSecretName = options.credentialSecretName;
  }

  /** Resolves and signature-verifies the published manifest without downloading the package. */
  async resolveKit(
    spec: AgentKitAdapterSpec,
    options: { credential: string; signal?: AbortSignal | undefined; fetchImpl?: typeof fetch | undefined }
  ): Promise<AgentKitRegistryManifest> {
    const manifest = await resolveAgentKitManifest({
      registryUrl: this.registryUrl,
      kitId: spec.kitId,
      channel: spec.channel,
      version: spec.version,
      credential: options.credential,
      credentialSecretName: this.credentialSecretName,
      signal: options.signal,
      fetchImpl: options.fetchImpl
    });
    verifyAgentKitManifest(manifest, { keyId: this.keyId, publicKey: this.publicKey });
    return manifest;
  }

  /** Downloads, digest-verifies, extracts, and projects an already-verified manifest into staging. */
  async materialize(
    stagingDir: string,
    spec: AgentKitAdapterSpec,
    manifest: AgentKitRegistryManifest,
    options?: { signal?: AbortSignal | undefined; fetchImpl?: typeof fetch | undefined } | undefined
  ): Promise<ToolkitAdapterResult> {
    const packageBytes = await downloadAgentKitPackage(manifest, {
      signal: options?.signal,
      fetchImpl: options?.fetchImpl
    });

    const packageDir = join(stagingDir, PACKAGE_DIR);
    const extractDir = join(packageDir, 'extract');
    await mkdir(extractDir, { recursive: true });
    await writeFile(join(packageDir, PACKAGE_FILE), packageBytes);

    const listing = await this.runPackageHelper(
      'listing',
      'tar -tzf "$1"',
      packageDir,
      extractDir,
      options?.signal
    );
    if (listing.truncated) {
      throw new HarnessError('UNAVAILABLE', 'AgentKit package listing exceeded the inspection budget', 503, false);
    }
    const safeNames = assertSafePackageNames(
      listing.stdout.split('\n').filter((line) => line.length > 0),
      spec.kitId
    );

    // Sum the declared uncompressed sizes before extraction, so a compressible archive cannot fill the
    // staging filesystem before `validateStagingDir` runs after the fact.
    const sizeListing = await this.runPackageHelper(
      'sizing',
      `tar -tvzf "$1" | awk '{n++; s+=$3; if ($3>m) m=$3} END { printf "%d %d %d\\n", n, s, m }'`,
      packageDir,
      extractDir,
      options?.signal
    );
    if (sizeListing.truncated) {
      throw new HarnessError('UNAVAILABLE', 'AgentKit package sizing exceeded the inspection budget', 503, false);
    }
    const sizes = parsePackageSizeListing(sizeListing.stdout);
    assertPackageSizeBounds(sizes.files, sizes.totalBytes, sizes.maxFileBytes);

    await this.runPackageHelper(
      'extraction',
      'tar -xzf "$1" --no-same-owner --no-same-permissions',
      packageDir,
      extractDir,
      options?.signal
    );
    assertExtractedKitTree(extractDir, spec.kitId);

    const skillsTargetDir = join(stagingDir, 'skills');
    await mkdir(skillsTargetDir, { recursive: true });
    const normalizedSkills: Array<{ name: string; contentSha256: string }> = [];
    for (const skill of discoverPackagedSkills(join(extractDir, spec.kitId, 'skills'))) {
      if (spec.skills?.include && !spec.skills.include.includes(skill.name)) continue;
      if (spec.skills?.exclude && spec.skills.exclude.includes(skill.name)) continue;
      const targetSkillDir = join(skillsTargetDir, skill.name);
      await cp(skill.sourceDir, targetSkillDir, { recursive: true, dereference: false });
      const skillMdContent = await readFile(join(targetSkillDir, 'SKILL.md'), 'utf8');
      normalizedSkills.push({
        name: skill.name,
        contentSha256: createHash('sha256').update(skillMdContent).digest('hex')
      });
    }
    if (normalizedSkills.length === 0) {
      throw new HarnessError(
        'UNAVAILABLE',
        `AgentKit package ${manifest.kitId}/${manifest.runtime}@${manifest.version} contains no usable skills`,
        503,
        false
      );
    }

    await rm(packageDir, { recursive: true, force: true });

    const manifestFile = {
      id: `agentkit:${manifest.kitId}`,
      kitId: manifest.kitId,
      runtime: manifest.runtime,
      channel: manifest.channel,
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      registryKeyId: manifest.artifact.keyId,
      packageSha256: manifest.artifact.sha256,
      archiveMembers: safeNames.length,
      resolvedRevision: manifest.artifact.sha256,
      adapterVersion: AgentKitRegistryAdapter.ADAPTER_VERSION,
      skills: normalizedSkills
    };
    await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifestFile, null, 2), 'utf8');

    validateStagingDir(stagingDir, 1_000, AGENTKIT_PACKAGE_MAX_BYTES);
    const digestInfo = computeFullTreeDigest(stagingDir);

    return {
      bundleSha256: digestInfo.bundleSha256,
      byteCount: digestInfo.byteCount,
      fileCount: digestInfo.fileCount,
      manifest: manifestFile
    };
  }

  async acquireAndNormalize(
    _ownerId: string,
    stagingDir: string,
    spec: AgentKitAdapterSpec,
    options?: {
      credential?: string | undefined;
      signal?: AbortSignal | undefined;
      fetchImpl?: typeof fetch | undefined;
    } | undefined
  ): Promise<ToolkitAdapterResult> {
    const credential = options?.credential;
    if (!credential) {
      throw new HarnessError(
        'INVALID_INPUT',
        `The agentkit toolkit needs an AgentKit registry credential; store the licence token as the ${this.credentialSecretName} secret for this principal`,
        400,
        false
      );
    }
    const manifest = await this.resolveKit(spec, {
      credential,
      signal: options?.signal,
      fetchImpl: options?.fetchImpl
    });
    return this.materialize(stagingDir, spec, manifest, {
      signal: options?.signal,
      fetchImpl: options?.fetchImpl
    });
  }

  private async runPackageHelper(
    stage: 'listing' | 'sizing' | 'extraction',
    command: string,
    packageDir: string,
    extractDir: string,
    signal: AbortSignal | undefined
  ) {
    const helperName = `chm-ak-${stage}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await runDocker([
      'run', '--rm', '--name', helperName,
      '--network', 'none', '--user', '10001:10001', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--volume', `${packageDir}:/package:ro`,
      '--volume', `${extractDir}:/extract:rw`,
      '--entrypoint', '/bin/bash', this.executorImage,
      '-c', command,
      'kit-archive', `/package/${PACKAGE_FILE}`
    ], { timeoutMs: 120_000, maxBytes: 4_194_304, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) {
      throw new HarnessError(
        'UNAVAILABLE',
        `AgentKit package ${stage} failed with exit code ${result.exitCode}: ${result.stderr}`,
        503,
        false
      );
    }
    return result;
  }
}
