/**
 * Retained artifact snapshots (`artifact_list` in `apps/api/src/dashboard-response.ts`): one
 * page of `ARTIFACTS_PAGE_SIZE` with an opaque `cursor`, and the snapshot request the
 * classic page sends (`loadArtifacts` in `apps/api/dashboard/dashboard.js`).
 */
import { z } from 'zod';
import { arr, text } from '@/lib/format';

export type Artifact = {
  artifactId: string;
  logicalName: string;
  sha256: string;
  sizeBytes?: number;
  workspaceId?: string;
  expiresAt?: string;
  generation?: number;
};

export const ARTIFACTS_PAGE_SIZE = 50;

export function artifactsOf(data: unknown): Artifact[] {
  return arr((data as Record<string, unknown> | undefined)?.artifacts)
    .filter((artifact) => text(artifact.artifactId) !== '')
    .map((artifact) => {
      const workspaceId = text(artifact.workspaceId); const expiresAt = text(artifact.expiresAt);
      return {
        artifactId: text(artifact.artifactId),
        logicalName: text(artifact.logicalName) || text(artifact.artifactId),
        sha256: text(artifact.sha256),
        ...(typeof artifact.sizeBytes === 'number' ? { sizeBytes: artifact.sizeBytes } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(typeof artifact.generation === 'number' ? { generation: artifact.generation } : {})
      };
    });
}

export function artifactsPage(body: unknown): { artifacts: Artifact[]; nextCursor: string | undefined } {
  const envelope = body && typeof body === 'object' ? (body as { data?: unknown; cursor?: unknown }) : {};
  return { artifacts: artifactsOf(envelope.data), nextCursor: typeof envelope.cursor === 'string' && envelope.cursor ? envelope.cursor : undefined };
}

/** The same-origin BFF download; the browser saves it under the snapshot's logical name. */
export function artifactDownloadHref(artifactId: string): string {
  return `/dashboard/api/v1/artifacts/${encodeURIComponent(artifactId)}/download`;
}

/** A delete is fenced by the record's generation; a record without one cannot be deleted from here. */
export function artifactDeletable(artifact: Artifact): artifact is Artifact & { generation: number } {
  return Number.isInteger(artifact.generation) && (artifact.generation ?? 0) > 0;
}

/** The snapshot form, with the `artifacts_snapshot` contract's bounds. */
export const snapshotSchema = z.object({
  workspaceId: z.string().trim().regex(/^ws_[A-Za-z0-9_-]{20,80}$/, 'Give a workspace ID, for example ws_ followed by its identifier.'),
  path: z.string().trim().min(1, 'Give the file path inside the workspace.').max(1_024, 'Use at most 1024 characters.'),
  logicalName: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'Start with a letter or digit; use letters, digits, dot, dash or underscore, at most 128 characters.'),
  retentionSeconds: z.string().trim().refine((value) => value === '' || (/^\d+$/.test(value) && Number(value) >= 60 && Number(value) <= 2_592_000), 'Use 60 to 2592000 seconds, or leave it empty for the server default.')
});
export type SnapshotValues = z.infer<typeof snapshotSchema>;

/** The create body: generation 0 (a new record), and retention only when one was given. */
export function snapshotBody(values: SnapshotValues): Record<string, unknown> {
  return {
    workspaceId: values.workspaceId.trim(),
    path: values.path.trim(),
    logicalName: values.logicalName.trim(),
    ...(values.retentionSeconds.trim() ? { retentionSeconds: Number(values.retentionSeconds.trim()) } : {}),
    expectedGeneration: 0
  };
}
