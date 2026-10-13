import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore, ArtifactStoreError, initializeArtifactSchema } from '../src/artifact-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup(overrides: Partial<ConstructorParameters<typeof ArtifactStore>[1]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-artifacts-'));
  temporaryDirectories.push(directory);
  const database = new DatabaseSync(join(directory, 'state.db'));
  const root = join(directory, 'artifacts');
  const store = new ArtifactStore(database, {
    root,
    maxArtifactBytes: 16,
    maxPrincipalBytes: 24,
    defaultRetentionMs: 60_000,
    maxRetentionMs: 86_400_000,
    ...overrides
  });
  return { database, directory, root, store };
}

describe('ArtifactStore', () => {
  it('initializes on a shared database and persists digest, size, provenance, and metadata across restart', () => {
    const { database, root, store } = setup();
    initializeArtifactSchema(database);
    const content = Buffer.from('snapshot');
    const created = store.create('principal-a', {
      logicalName: 'build-summary.json', content, projectId: 'project-a', environmentId: 'staging',
      workspaceId: `ws_${'a'.repeat(24)}`, now: 1_000, retentionMs: 10_000
    });
    expect(created).toMatchObject({
      logicalName: 'build-summary.json', sizeBytes: content.byteLength, projectId: 'project-a',
      environmentId: 'staging', workspaceId: `ws_${'a'.repeat(24)}`, createdAt: 1_000,
      expiresAt: 11_000, retentionMs: 10_000, generation: 1
    });
    expect(created.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    const row = database.prepare('SELECT relative_path FROM artifacts WHERE id = ?').get(created.artifactId) as { relative_path: string };
    const storedPath = join(root, row.relative_path);
    renameSync(storedPath, join(root, 'objects', `.deleting-${created.artifactId}-1-aaaaaaaaaaaaaaaa`));
    database.close();

    const reopenedDatabase = new DatabaseSync(join(root, '..', 'state.db'));
    const reopened = new ArtifactStore(reopenedDatabase, {
      root, maxArtifactBytes: 16, maxPrincipalBytes: 24, defaultRetentionMs: 60_000, maxRetentionMs: 86_400_000
    });
    expect(reopened.metadata('principal-a', created.artifactId, 2_000)).toEqual(created);
    expect(readFileSync(storedPath)).toEqual(content);
    reopenedDatabase.close();
  });

  it('enforces per-artifact and aggregate principal quota independently', () => {
    const { database, store } = setup();
    expect(() => store.create('principal-a', { logicalName: 'too-large', content: Buffer.alloc(17) }))
      .toThrowError(ArtifactStoreError);
    store.create('principal-a', { logicalName: 'first', content: Buffer.alloc(16) });
    store.create('principal-b', { logicalName: 'other-principal', content: Buffer.alloc(16) });
    expect(() => store.create('principal-a', { logicalName: 'over-quota', content: Buffer.alloc(9) }))
      .toThrow('artifact quota exceeded');
    database.close();
  });

  it('reaps expired artifacts without touching retained snapshots', () => {
    const { database, root, store } = setup();
    const expired = store.create('principal-a', { logicalName: 'expired', content: Buffer.from('old'), now: 1_000, retentionMs: 1_000 });
    const retained = store.create('principal-a', { logicalName: 'retained', content: Buffer.from('new'), now: 1_000, retentionMs: 10_000 });
    expect(store.reapExpired(2_001, 10)).toBe(1);
    expect(() => store.metadata('principal-a', expired.artifactId, 2_001)).toThrow('artifact not found');
    expect(store.metadata('principal-a', retained.artifactId, 2_001).artifactId).toBe(retained.artifactId);
    expect(JSON.stringify([...new Set(store.list('principal-a', { now: 2_001, limit: 10 }).artifacts)])).not.toContain(root);
    database.close();
  });

  it('uses generation CAS and makes foreign and unknown deletes indistinguishable', () => {
    const { database, store } = setup();
    const artifact = store.create('principal-a', { logicalName: 'summary', content: Buffer.from('data') });
    expect(() => store.delete('principal-a', artifact.artifactId, 2)).toThrow('artifact generation changed');
    const capture = (principalId: string, artifactId: string) => {
      try { store.delete(principalId, artifactId, 1); } catch (error) {
        const value = error as ArtifactStoreError;
        return { code: value.code, message: value.message };
      }
      throw new Error('expected delete to fail');
    };
    expect(capture('principal-b', artifact.artifactId)).toEqual(capture('principal-b', `art_${'z'.repeat(32)}`));
    const captureMetadata = (artifactId: string) => {
      try { store.metadata('principal-b', artifactId); } catch (error) {
        const value = error as ArtifactStoreError;
        return { code: value.code, message: value.message };
      }
      throw new Error('expected metadata lookup to fail');
    };
    expect(captureMetadata(artifact.artifactId)).toEqual(captureMetadata(`art_${'z'.repeat(32)}`));
    expect(store.delete('principal-a', artifact.artifactId, 1)).toMatchObject({ artifactId: artifact.artifactId, generation: 1 });
    database.close();
  });

  it('paginates stable redacted metadata without exposing principals, paths, or content', () => {
    const { database, root, store } = setup({ maxPrincipalBytes: 100 });
    const first = store.create('principal-a', { logicalName: 'first', content: Buffer.from('secret-one'), now: 1_000 });
    store.create('principal-a', { logicalName: 'second', content: Buffer.from('secret-two'), now: 2_000 });
    store.create('principal-a', { logicalName: 'third', content: Buffer.from('secret-three'), now: 3_000 });
    store.create('principal-b', { logicalName: 'foreign', content: Buffer.from('foreign'), now: 4_000 });
    const page = store.list('principal-a', { now: 4_001, limit: 2 });
    expect(page.artifacts.map((artifact) => artifact.logicalName)).toEqual(['third', 'second']);
    expect(page.cursor).toBeDefined();
    expect(store.list('principal-a', { now: 4_001, limit: 2, cursor: page.cursor }).artifacts.map((artifact) => artifact.artifactId)).toEqual([first.artifactId]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('principal-a');
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('secret-');
    database.close();
  });

  it('rejects unsafe logical names and refuses cleanup when a stored path escapes the verified root', () => {
    const { database, directory, store } = setup();
    expect(() => store.create('principal-a', { logicalName: '../../escape', content: Buffer.from('data') })).toThrow('invalid artifact logical name');
    const artifact = store.create('principal-a', { logicalName: 'safe', content: Buffer.from('data') });
    const outside = join(directory, 'outside.snapshot');
    writeFileSync(outside, 'keep');
    database.prepare('UPDATE artifacts SET relative_path = ? WHERE id = ?').run('../outside.snapshot', artifact.artifactId);
    expect(() => store.delete('principal-a', artifact.artifactId, 1)).toThrow('unsafe artifact storage path');
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    database.close();
  });

  it('rejects a symbolic-link artifact root', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-harness-artifacts-'));
    temporaryDirectories.push(directory);
    const actualRoot = join(directory, 'actual');
    const linkedRoot = join(directory, 'linked');
    mkdirSync(actualRoot);
    symlinkSync(actualRoot, linkedRoot, 'dir');
    const database = new DatabaseSync(join(directory, 'state.db'));
    expect(() => new ArtifactStore(database, {
      root: linkedRoot, maxArtifactBytes: 16, maxPrincipalBytes: 24,
      defaultRetentionMs: 60_000, maxRetentionMs: 86_400_000
    })).toThrow('artifact root must not be a symbolic link');
    database.close();
  });

  it('Issue #109: reads bounded chunks with base64 encoding and validates cross-principal isolation', () => {
    const { database, store } = setup({ maxArtifactBytes: 1024, maxPrincipalBytes: 4096 });
    const rawData = Buffer.from('hello world binary payload test 12345');
    const created = store.create('principal-a', { logicalName: 'payload.bin', content: rawData, now: 1_000, retentionMs: 5_000 });

    // Chunk 1: first 10 bytes
    const chunk1 = store.read('principal-a', { artifactId: created.artifactId, offset: 0, limit: 10, now: 1_500 });
    expect(chunk1.artifactId).toBe(created.artifactId);
    expect(chunk1.logicalName).toBe('payload.bin');
    expect(chunk1.offset).toBe(0);
    expect(chunk1.bytesReturned).toBe(10);
    expect(chunk1.totalBytes).toBe(rawData.length);
    expect(chunk1.eof).toBe(false);
    expect(Buffer.from(chunk1.content, 'base64')).toEqual(rawData.subarray(0, 10));

    // Chunk 2: next bytes to end
    const chunk2 = store.read('principal-a', { artifactId: created.artifactId, offset: 10, limit: 100, now: 1_500 });
    expect(chunk2.offset).toBe(10);
    expect(chunk2.bytesReturned).toBe(rawData.length - 10);
    expect(chunk2.eof).toBe(true);
    expect(Buffer.from(chunk2.content, 'base64')).toEqual(rawData.subarray(10));

    // Full reassembly matches original
    const reassembled = Buffer.concat([Buffer.from(chunk1.content, 'base64'), Buffer.from(chunk2.content, 'base64')]);
    expect(reassembled).toEqual(rawData);
    expect(chunk1.sha256).toBe(createHash('sha256').update(rawData).digest('hex'));

    // Offset past EOF
    const chunkPastEof = store.read('principal-a', { artifactId: created.artifactId, offset: 100, limit: 10, now: 1_500 });
    expect(chunkPastEof.bytesReturned).toBe(0);
    expect(chunkPastEof.eof).toBe(true);
    expect(chunkPastEof.content).toBe('');

    // Expired artifact read throws NOT_FOUND
    expect(() => store.read('principal-a', { artifactId: created.artifactId, now: 7_000 })).toThrow('artifact not found');

    // Cross-principal read throws NOT_FOUND indistinguishable from nonexistent
    expect(() => store.read('principal-b', { artifactId: created.artifactId })).toThrow('artifact not found');
    expect(() => store.read('principal-b', { artifactId: `art_${'z'.repeat(32)}` })).toThrow('artifact not found');

    // readPayload returns verified buffer
    const payload = store.readPayload('principal-a', created.artifactId, 1_500);
    expect(payload.metadata.artifactId).toBe(created.artifactId);
    expect(payload.content).toEqual(rawData);

    database.close();
  });
});
