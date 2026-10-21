import { apiClient } from '@/lib/api-client';
import type { BffEnvelope } from '@/lib/bff-query';
import { type ArchiveResult, archiveContentType } from './skill-model';

/**
 * Uploads a skills archive to `POST /skill-archives`. The route takes the raw zip (its own
 * media types and 8 MiB limit, not the JSON parser), so the bytes travel as `rawBody`; the
 * shared client still owns the session bootstrap and the `x-csrf-token` header. The server
 * fixes `expectedGeneration: 0`, so the request carries nothing else.
 */
export async function uploadSkillArchive(file: File): Promise<ArchiveResult[]> {
  const response = await apiClient.request<BffEnvelope<{ results?: ArchiveResult[] }>>('/skill-archives', {
    method: 'POST',
    rawBody: { data: file, contentType: archiveContentType(file.type) }
  });
  return Array.isArray(response?.data?.results) ? response.data.results : [];
}
