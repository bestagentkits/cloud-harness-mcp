import { z } from 'zod';
import { type BffEnvelope, bffPath } from '@/lib/bff-query';

/**
 * Project and environment projections the BFF returns (`metadataKeys` / `environmentKeys` in
 * `apps/api/src/dashboard-response.ts`). Secret references are a separate read
 * (`/environments/:id/secrets`) owned by the secrets feature, never part of these shapes.
 */
export type Project = {
  id: string;
  name?: string;
  state?: string;
  generation?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type Environment = Project & { projectId?: string };

/** The project list read, shared (same query key) by the list, the detail page and the knowledge dialog. */
export const PROJECTS_PATH = '/projects';

export function projectPath(projectId: string): string {
  return bffPath('projects', projectId);
}

export function projectEnvironmentsPath(projectId: string): string {
  return bffPath('projects', projectId, 'environments');
}

export function environmentPath(environmentId: string): string {
  return bffPath('environments', environmentId);
}

function rows<T extends { id: string }>(body: unknown, key: string): T[] {
  const data = (body as BffEnvelope<Record<string, unknown>> | undefined)?.data;
  const list = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? list.filter((row): row is T => Boolean(row) && typeof (row as { id?: unknown }).id === 'string') : [];
}

/** Projects from a `/projects` envelope; a missing or malformed list is empty. */
export function projectsFrom(body: unknown): Project[] {
  return rows<Project>(body, 'projects');
}

/** Environments from a `/projects/:id/environments` envelope. */
export function environmentsFrom(body: unknown): Environment[] {
  return rows<Environment>(body, 'environments');
}

/** The display name, or the id when a projection omits it. */
export function displayName(record: { id: string; name?: string | undefined }): string {
  return typeof record.name === 'string' && record.name.trim() ? record.name : record.id;
}

/**
 * The control router's `createName` bound (`apps/api/src/dashboard-control-router.ts`):
 * a trimmed name of 1 to 100 characters. Mirrored here so the form refuses what the server would.
 */
export const NAME_MAX = 100;
export const nameSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(NAME_MAX, `Use at most ${NAME_MAX} characters.`)
});
export type NameValues = z.infer<typeof nameSchema>;

/** Create bodies are strict `{ name, expectedGeneration: 0 }`. */
export function createBody(name: string): { name: string; expectedGeneration: 0 } {
  return { name: name.trim(), expectedGeneration: 0 };
}

/**
 * Rename and delete carry the generation the operator saw. A projection without a positive
 * generation cannot be fenced, so the write is refused client-side instead of guessed.
 */
export function fencedGeneration(record: { generation?: number | undefined }): number {
  const generation = record.generation;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
    throw new Error('This record has no generation to fence the change; reload the page.');
  }
  return generation;
}
