import { apiClient } from '@/lib/api-client';
import type {
  CatalogSearchResult, GatewayStatus, ModelProfile, ModelProvider, ProviderCredential, SpendPolicy, SpendSummary, VerifyResult
} from './models-types';

/**
 * Models & Budgets BFF calls, with the bodies the classic Dashboard sends. Provider keys
 * travel only as the `apiKey` of a create or rotate body and are never returned; the
 * caller clears its field before the request settles.
 */

const unwrap = <T>(body: unknown) => (body as { data: T }).data;
const enc = encodeURIComponent;

/**
 * The credential fence. The runner's list and rotate responses omit `generation` today, so
 * this falls back to 1 exactly as the classic Dashboard does; after a rotation the runner
 * refuses rotate and delete with 409 until the contract carries the field.
 */
export const credentialGeneration = (credential: ProviderCredential) => credential.generation ?? 1;

export type CredentialCreateInput = { label: string; provider: string; authMode: string; apiKey: string };

export const MODELS_READS = ['/provider-credentials', '/agent-model-profiles', '/agent-model-config-status'] as const;
export const SPEND_READ = '/model-spend';

export const modelsApi = {
  credentials: async () => unwrap<{ credentials: ProviderCredential[] }>(await apiClient.request('/provider-credentials')).credentials ?? [],
  profiles: async () => unwrap<{ profiles: ModelProfile[] }>(await apiClient.request('/agent-model-profiles')).profiles ?? [],
  status: async () => unwrap<{ status: GatewayStatus }>(await apiClient.request('/agent-model-config-status')).status ?? null,
  providers: async () => unwrap<{ providers: ModelProvider[] }>(await apiClient.request('/model-providers')).providers ?? [],

  createCredential: async (input: CredentialCreateInput) =>
    unwrap<ProviderCredential>(await apiClient.request('/provider-credentials', {
      method: 'POST', body: { label: input.label.trim(), provider: input.provider, authMode: input.authMode, apiKey: input.apiKey.trim() }
    })),
  rotateCredential: async (credential: ProviderCredential, apiKey: string) =>
    unwrap<ProviderCredential>(await apiClient.request(`/provider-credentials/${enc(credential.id)}/rotate`, {
      method: 'PUT', body: { apiKey: apiKey.trim(), expectedGeneration: credentialGeneration(credential) }
    })),
  deleteCredential: (credential: ProviderCredential) =>
    apiClient.request(`/provider-credentials/${enc(credential.id)}`, { method: 'DELETE', body: { expectedGeneration: credentialGeneration(credential) } }),

  createProfile: async (body: Record<string, unknown>) => unwrap<ModelProfile>(await apiClient.request('/agent-model-profiles', { method: 'POST', body })),
  updateProfile: async (profileId: string, body: Record<string, unknown>) =>
    unwrap<ModelProfile>(await apiClient.request(`/agent-model-profiles/${enc(profileId)}`, { method: 'PATCH', body })),
  setProfileActive: async (profile: ModelProfile, active: boolean) =>
    unwrap<ModelProfile>(await apiClient.request(`/agent-model-profiles/${enc(profile.id)}/${active ? 'activate' : 'disable'}`, {
      method: 'POST', body: { expectedGeneration: profile.generation }
    })),
  deleteProfile: (profile: ModelProfile) =>
    apiClient.request(`/agent-model-profiles/${enc(profile.id)}`, { method: 'DELETE', body: { expectedGeneration: profile.generation } }),

  /** A saved profile's check (`{profileId}`) or a draft route's check; neither carries a key. */
  verify: async (body: Record<string, unknown>) => unwrap<VerifyResult>(await apiClient.request('/model-connection/verify', { method: 'POST', body })),

  searchCatalog: async ({ provider, credentialId, q, limit = 25 }: { provider: string; credentialId?: string; q?: string; limit?: number }, signal?: AbortSignal) => {
    const query: Record<string, string | number> = { provider, limit };
    if (credentialId) query.credentialId = credentialId;
    if (q?.trim()) query.q = q.trim();
    return unwrap<CatalogSearchResult>(await apiClient.request('/model-catalog', { query, ...(signal ? { signal } : {}) }));
  },
  refreshCatalog: (provider: string, credentialId: string) =>
    apiClient.request('/model-catalog/refresh', { method: 'POST', body: { provider, credentialId } }),

  spend: async (signal?: AbortSignal) => {
    const data = unwrap<{ summary?: SpendSummary }>(await apiClient.request(SPEND_READ, signal ? { signal } : {}));
    if (!data?.summary || !Array.isArray(data.summary.windows)) throw new Error('The spend summary could not be read.');
    return data.summary;
  },
  setPolicy: async (body: Record<string, unknown>) => unwrap<SpendPolicy>(await apiClient.request('/model-spend/policies', { method: 'PUT', body })),
  deletePolicy: (policy: SpendPolicy) =>
    apiClient.request(`/model-spend/policies/${enc(policy.id)}`, { method: 'DELETE', body: { expectedGeneration: policy.generation } })
};
