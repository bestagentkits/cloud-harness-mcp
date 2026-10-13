import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillXAdapter, normalizeSkillXPayload } from '../src/adapters/skillx-adapter.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function stagingDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-skillx-'));
  temporaryDirectories.push(directory);
  return directory;
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

describe('normalizeSkillXPayload', () => {
  it('accepts the instruction field names the vendor pages imply', () => {
    for (const field of ['instructions', 'content', 'body', 'markdown']) {
      const normalized = normalizeSkillXPayload('resolve-checks', { [field]: 'Do the thing.' });
      expect(normalized.instructions).toBe('Do the thing.');
      expect(normalized.name).toBe('resolve-checks');
      expect(normalized.sourceRevision).toBe('skillx:resolve-checks');
    }
  });

  it('records the version in the resolved revision when the payload carries one', () => {
    expect(normalizeSkillXPayload('x', { instructions: 'a', version: '2.1' }).sourceRevision).toBe('skillx:x@2.1');
  });

  it('sanitizes the skill name into a safe directory name', () => {
    expect(normalizeSkillXPayload('slug', { instructions: 'a', name: 'Deploy to Cloudflare!' }).name).toBe('Deploy-to-Cloudflare-');
  });

  it('rejects a payload with no instructions, a non-object payload, and null bytes', () => {
    expect(() => normalizeSkillXPayload('slug', { description: 'only a description' })).toThrow(/carries no instructions/i);
    expect(() => normalizeSkillXPayload('slug', 'text')).toThrow(/must be a JSON object/i);
    expect(() => normalizeSkillXPayload('slug', { instructions: 'bad\u0000byte' })).toThrow(/null byte/i);
  });
});

describe('SkillXAdapter', () => {
  it('writes an instructions-only skill tree with no executable assets', async () => {
    const dir = stagingDir();
    const adapter = new SkillXAdapter({ fetcher: async () => jsonResponse({ slug: 'resolve-checks', instructions: '# Resolve checks\n\nFix CI.' }) });
    const result = await adapter.acquireAndNormalize('owner', dir, { reference: 'resolve-checks' });

    expect(result.manifest.hasExecutableAssets).toBe(false);
    expect(result.manifest.resolvedRevision).toBe('skillx:resolve-checks');
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.fileCount).toBeGreaterThan(0);

    // The tree holds exactly the skill instructions plus the manifest, so an executable-asset scan
    // over it can only conclude that nothing in this revision is executable.
    const skillFiles = readdirSync(join(dir, 'skills', 'resolve-checks'));
    expect(skillFiles).toEqual(['SKILL.md']);
    expect(readFileSync(join(dir, 'skills', 'resolve-checks', 'SKILL.md'), 'utf8')).toContain('Fix CI.');
  });

  it('maps vendor errors to retryable and terminal harness codes', async () => {
    const notFound = new SkillXAdapter({ fetcher: async () => jsonResponse({}, 404) });
    await expect(notFound.acquireAndNormalize('owner', stagingDir(), { reference: 'missing' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const limited = new SkillXAdapter({ fetcher: async () => jsonResponse({}, 429) });
    await expect(limited.acquireAndNormalize('owner', stagingDir(), { reference: 'busy' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });

    const broken = new SkillXAdapter({ fetcher: async () => new Response('not json', { status: 200 }) });
    await expect(broken.acquireAndNormalize('owner', stagingDir(), { reference: 'nonsense' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a malformed reference before making any request', async () => {
    let called = false;
    const adapter = new SkillXAdapter({ fetcher: async () => { called = true; return jsonResponse({ instructions: 'x' }); } });
    await expect(adapter.acquireAndNormalize('owner', stagingDir(), { reference: 'owner/repo' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(called).toBe(false);
  });

  it('reports a timeout as a retryable TIMEOUT instead of a generic failure', async () => {
    const adapter = new SkillXAdapter({
      fetcher: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    });
    const controller = new AbortController();
    const promise = adapter.acquireAndNormalize('owner', stagingDir(), { reference: 'slow', signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
