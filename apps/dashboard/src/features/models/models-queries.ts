import { useQuery } from '@tanstack/react-query';
import { usePageData } from '../shared/feature-read';
import { modelsApi } from './models-api';
import type { ModelProvider, ProviderCredential } from './models-types';

/**
 * The page's reads. Credentials are the registered primary read (shared with the route
 * warm-up); profiles load alongside, both fatal on failure like the classic page. Gateway
 * status and the provider registry are optional: a failure shows "unavailable" or falls
 * back to the static provider list, never a page error.
 */
export function useModelsData() {
  const credentials = usePageData<{ credentials: ProviderCredential[] }>('models');
  const profiles = useQuery({ queryKey: ['bff', '/agent-model-profiles', {}], queryFn: () => modelsApi.profiles() });
  const status = useQuery({ queryKey: ['bff', '/agent-model-config-status', {}], queryFn: () => modelsApi.status(), retry: false });
  const providers = useQuery({ queryKey: ['bff', '/model-providers', {}], queryFn: () => modelsApi.providers(), retry: false, staleTime: 5 * 60_000 });
  return { credentials, profiles, status, providers };
}

/** The classic Dashboard's static provider list, used until (or if) the registry cannot load. */
export const FALLBACK_PROVIDERS: ModelProvider[] = [
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Anthropic (OpenAI-compatible)' },
  { id: 'openrouter', displayName: 'OpenRouter' },
  { id: 'google', displayName: 'Google Gemini (OpenAI-compatible)' },
  { id: 'deepseek', displayName: 'DeepSeek' },
  { id: 'opencode-go', displayName: 'OpenCode Go' },
  { id: 'custom', displayName: 'Custom (OpenAI-compatible)', requiresCustomUpstream: true }
];

export const AUTH_MODE_LABELS: Record<string, string> = { bearer: 'Authorization: Bearer <key>', 'x-api-key': 'X-API-Key: <key>' };

export function providerAuthModes(provider: ModelProvider | undefined): string[] {
  return provider?.authModes?.length ? provider.authModes : ['bearer', 'x-api-key'];
}

export function providerName(providers: readonly ModelProvider[], id: string | undefined): string {
  return providers.find((entry) => entry.id === id)?.displayName ?? id ?? 'Unknown provider';
}
