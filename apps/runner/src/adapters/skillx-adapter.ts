import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '@cloud-harness/contracts';
import { computeFullTreeDigest, validateStagingDir, type ToolkitAdapterResult } from './mattpocock-adapter.js';

/**
 * SkillX import is documented as an assumption rather than a verified contract: the public API shape
 * below was NOT confirmed against the vendor. `normalizeSkillXPayload` tolerates the field names the
 * published pages imply (`instructions`, `content`, `body`) and rejects a payload that carries none
 * of them, so a wrong guess fails loudly instead of writing an empty skill.
 */
export type NormalizedSkillXSkill = { name: string; instructions: string; sourceRevision: string };

const MAX_PAYLOAD_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 30_000;

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

export function normalizeSkillXPayload(slug: string, payload: unknown): NormalizedSkillXSkill {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new HarnessError('INVALID_INPUT', 'SkillX payload must be a JSON object', 400, false);
  }
  const record = payload as Record<string, unknown>;
  const instructions = firstString(record, ['instructions', 'content', 'body', 'markdown']);
  if (!instructions) {
    throw new HarnessError('INVALID_INPUT', `SkillX payload for ${slug} carries no instructions field`, 400, false);
  }
  if (instructions.includes('\0')) {
    throw new HarnessError('INVALID_INPUT', `SkillX instructions for ${slug} contain a null byte`, 400, false);
  }
  const name = firstString(record, ['slug', 'name', 'title']) ?? slug;
  const version = firstString(record, ['version', 'updatedAt', 'updated_at', 'revision']);
  return {
    name: name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || slug,
    instructions,
    sourceRevision: version ? `skillx:${slug}@${version}` : `skillx:${slug}`
  };
}

/** SkillX skills are instructions only, so the produced tree holds no executable asset. */
export type SkillXAdapterResult = ToolkitAdapterResult & {
  manifest: ToolkitAdapterResult['manifest'] & { hasExecutableAssets: false };
};

export class SkillXAdapter {
  static readonly PROVIDER = 'skillx' as const;
  static readonly ADAPTER_VERSION = 1;

  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { baseUrl?: string | undefined; fetcher?: typeof fetch | undefined } = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://skillx.sh').replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  async acquireAndNormalize(
    _ownerId: string,
    stagingDir: string,
    options: { reference: string; signal?: AbortSignal | undefined }
  ): Promise<SkillXAdapterResult> {
    const slug = options.reference.trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(slug)) {
      throw new HarnessError('INVALID_INPUT', `SkillX reference must be a slug, got ${options.reference}`, 400, false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/skills/${encodeURIComponent(slug)}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new HarnessError('TIMEOUT', `SkillX request for ${slug} timed out after ${FETCH_TIMEOUT_MS}ms`, 504, true);
      }
      if (options.signal?.aborted) {
        throw new HarnessError('CANCELLED', `SkillX request for ${slug} was cancelled`, 499, false);
      }
      throw new HarnessError('UNAVAILABLE', `SkillX request for ${slug} failed: ${error instanceof Error ? error.message : String(error)}`, 503, true);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }

    if (response.status === 404) {
      throw new HarnessError('NOT_FOUND', `SkillX has no skill named ${slug}`, 404, false);
    }
    if (response.status === 429) {
      throw new HarnessError('UNAVAILABLE', `SkillX rate limited the request for ${slug}`, 429, true);
    }
    if (!response.ok) {
      throw new HarnessError('UNAVAILABLE', `SkillX returned status ${response.status} for ${slug}`, 503, true);
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new HarnessError('LIMIT_EXCEEDED', `SkillX payload for ${slug} exceeds ${MAX_PAYLOAD_BYTES} bytes`, 400, false);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HarnessError('INVALID_INPUT', `SkillX returned non-JSON content for ${slug}`, 400, false);
    }
    const normalized = normalizeSkillXPayload(slug, payload);

    const skillDir = join(stagingDir, 'skills', normalized.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `${normalized.instructions.trimEnd()}\n`, 'utf8');

    const manifest = {
      id: `skillx:${slug}`,
      resolvedRevision: normalized.sourceRevision,
      adapterVersion: SkillXAdapter.ADAPTER_VERSION,
      skills: [{
        name: normalized.name,
        contentSha256: createHash('sha256').update(normalized.instructions).digest('hex')
      }],
      hasExecutableAssets: false as const
    };
    await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    validateStagingDir(stagingDir);
    const digest = computeFullTreeDigest(stagingDir);
    return {
      bundleSha256: digest.bundleSha256,
      byteCount: digest.byteCount,
      fileCount: digest.fileCount,
      manifest
    };
  }
}
