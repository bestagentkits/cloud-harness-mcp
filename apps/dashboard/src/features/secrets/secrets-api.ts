import { apiClient } from '@/lib/api-client';
import type { BulkItem, SecretReference } from './secret-model';

/**
 * Where a set of secrets lives: the global scope (`/secrets`) or one project environment
 * (`/environments/:id/secrets`). Bodies match the classic Dashboard byte for byte: the
 * generation fence is `0` on create and the row's current generation otherwise, and a
 * path parameter is never repeated in the body.
 */
export type SecretScope = { kind: 'global' } | { kind: 'environment'; environmentId: string; name: string };

export function secretsPath(scope: SecretScope): string {
  return scope.kind === 'global' ? '/secrets' : `/environments/${encodeURIComponent(scope.environmentId)}/secrets`;
}

const itemPath = (scope: SecretScope, name: string) => `${secretsPath(scope)}/${encodeURIComponent(name)}`;
const optionalText = (value: string) => value.trim() || null;

export const secretsApi = {
  create: (scope: SecretScope, input: { name: string; value: string; description: string }) =>
    apiClient.request(secretsPath(scope), { method: 'POST', body: { name: input.name, value: input.value, description: optionalText(input.description), expectedGeneration: 0 } }),
  rotate: (scope: SecretScope, secret: SecretReference, input: { value: string; description: string }) =>
    apiClient.request(itemPath(scope, secret.name), {
      method: 'PUT',
      body: { value: input.value, ...(input.description.trim() ? { description: input.description.trim() } : {}), expectedGeneration: Number(secret.generation) }
    }),
  describe: (scope: SecretScope, secret: SecretReference, description: string) =>
    apiClient.request(itemPath(scope, secret.name), { method: 'PATCH', body: { description: optionalText(description), expectedGeneration: Number(secret.generation) } }),
  remove: (scope: SecretScope, secret: SecretReference) =>
    apiClient.request(itemPath(scope, secret.name), { method: 'DELETE', body: { expectedGeneration: Number(secret.generation) } }),
  bulk: (scope: SecretScope, items: BulkItem[]) =>
    apiClient.request(`${secretsPath(scope)}/bulk`, { method: 'POST', body: { items } })
};
