import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { DurableStartRecord } from './protocol.js';

export const GATEWAY_PROVIDER_ID = 'cloud-harness-gateway';

/** The run's gateway credential. Read on every model request, so a replaced lease applies to the next one. */
export interface GatewayLease {
  current(): { readonly lease: string; readonly agentId: string; readonly profile: string };
}

export function parseGatewayBaseUrl(gatewayBaseUrl: string): string {
  const parsed = new URL(gatewayBaseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('model gateway URL must use HTTP or HTTPS');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('model gateway URL cannot contain credentials, query parameters, or fragments');
  }
  return parsed.toString().replace(/\/$/u, '');
}

/**
 * The model gateway as a pi-ai provider with exactly one model. The lease and the agent and profile
 * headers are resolved per request instead of being fixed at registration, so the gateway always
 * sees the credential of the run that is executing, including after a resumed session.
 */
export function createGatewayProvider(gatewayBaseUrl: string, start: DurableStartRecord, lease: GatewayLease): Provider {
  const baseUrl = parseGatewayBaseUrl(gatewayBaseUrl);
  const model: Model<'openai-completions' | 'openai-responses'> = {
    id: start.model.id,
    name: start.model.name,
    api: start.model.api,
    provider: GATEWAY_PROVIDER_ID,
    baseUrl,
    reasoning: start.model.reasoning,
    input: ['text'],
    cost: start.model.cost,
    contextWindow: start.model.contextWindow,
    maxTokens: start.model.maxTokens
  };
  return createProvider<'openai-completions' | 'openai-responses'>({
    id: GATEWAY_PROVIDER_ID,
    name: 'Cloud Harness model gateway',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Cloud Harness gateway lease',
        resolve: async () => {
          const current = lease.current();
          return {
            auth: {
              apiKey: current.lease,
              headers: { 'X-Agent-ID': current.agentId, 'X-Model-Profile': current.profile }
            },
            source: 'cloud-harness-lease'
          };
        }
      }
    },
    models: [model],
    api: { 'openai-completions': openAICompletionsApi(), 'openai-responses': openAIResponsesApi() }
  });
}
