import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { apiClient, ConflictError } from '@/lib/api-client';
import { useBffMutation } from '@/lib/bff-mutation';
import { type BffEnvelope, bffQuery } from '@/lib/bff-query';
import { pageReadQuery } from '@/lib/page-read';
import type { LifecycleUpdate } from './lifecycle-model';
import type { NetworkProfile } from './network-model';
import type { OAuthUpdate } from './oauth-model';

/**
 * The Settings page reads exactly what the classic page reads, once each: `/settings` (the
 * registry read the route loader warms), `/settings/oauth`, `/typesafe/status` and
 * `/integration-credentials`. Nothing polls. A write's answer is the runner's read-back, so
 * it replaces the cached read instead of costing another GET.
 */
export const settingsRead = () => pageReadQuery('settings', {});
export const oauthRead = () => bffQuery<unknown>('/settings/oauth');
export const typesafeStatusRead = () => bffQuery<unknown>('/typesafe/status');
export const integrationCredentialsRead = () => bffQuery<unknown>('/integration-credentials');

/** `POST /settings`: exactly one of the two schema fields per save, as the classic page sends. */
export type SettingsUpdate = { defaultNetworkProfile: NetworkProfile | null } | { workspaceLifecycle: LifecycleUpdate };

function useReadBackWrite<TBody>(path: string, key: QueryKey, errorTitle: string) {
  const queryClient = useQueryClient();
  return useBffMutation<TBody, BffEnvelope<unknown>>({
    mutationFn: (body) => apiClient.request<BffEnvelope<unknown>>(path, { method: 'POST', body }),
    onSuccess: (result) => { queryClient.setQueryData(key, result); },
    errorTitle
  });
}

export function useSettingsWrite(errorTitle: string) {
  return useReadBackWrite<SettingsUpdate>('/settings', settingsRead().queryKey, errorTitle);
}

export function useOAuthWrite() {
  return useReadBackWrite<OAuthUpdate>('/settings/oauth', oauthRead().queryKey, 'The OAuth settings were not saved');
}

/** A stale revision (409): the panel reloads the current values instead of retrying the write. */
export function useConflictReload(key: QueryKey) {
  const queryClient = useQueryClient();
  return async (error: unknown): Promise<boolean> => {
    if (!(error instanceof ConflictError)) return false;
    await queryClient.invalidateQueries({ queryKey: key });
    return true;
  };
}
