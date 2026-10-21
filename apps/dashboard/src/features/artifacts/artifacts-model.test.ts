import { describe, expect, it } from 'vitest';
import { artifactDeletable, artifactDownloadHref, artifactsPage, snapshotBody, snapshotSchema } from './artifacts-model';

describe('artifacts model', () => {
  it('reads a page with its cursor and drops records without an id', () => {
    const page = artifactsPage({ data: { artifacts: [{ artifactId: 'art_1', sha256: 'x', generation: 2 }, { logicalName: 'orphan' }] }, cursor: 'c_2' });
    expect(page).toEqual({ artifacts: [{ artifactId: 'art_1', logicalName: 'art_1', sha256: 'x', generation: 2 }], nextCursor: 'c_2' });
    expect(artifactsPage({ data: {} }).nextCursor).toBeUndefined();
  });

  it('downloads through the encoded same-origin BFF path', () => {
    expect(artifactDownloadHref('art/1')).toBe('/dashboard/api/v1/artifacts/art%2F1/download');
  });

  it('deletes only a record with a positive generation', () => {
    expect(artifactDeletable({ artifactId: 'a', logicalName: 'a', sha256: '', generation: 1 })).toBe(true);
    expect(artifactDeletable({ artifactId: 'a', logicalName: 'a', sha256: '' })).toBe(false);
    expect(artifactDeletable({ artifactId: 'a', logicalName: 'a', sha256: '', generation: 0 })).toBe(false);
  });

  it('validates the snapshot form and sends a new record body', () => {
    const values = { workspaceId: `ws_${'a'.repeat(24)}`, path: ' dist/app.tgz ', logicalName: 'app.tgz', retentionSeconds: '' };
    expect(snapshotSchema.safeParse(values).success).toBe(true);
    expect(snapshotSchema.safeParse({ ...values, retentionSeconds: '30' }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...values, logicalName: '-x' }).success).toBe(false);
    expect(snapshotBody(values)).toEqual({ workspaceId: values.workspaceId, path: 'dist/app.tgz', logicalName: 'app.tgz', expectedGeneration: 0 });
    expect(snapshotBody({ ...values, retentionSeconds: '3600' })).toMatchObject({ retentionSeconds: 3600 });
  });
});
