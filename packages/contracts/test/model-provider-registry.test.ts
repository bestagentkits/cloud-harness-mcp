import { describe, expect, it } from 'vitest';
import {
  ModelProviderKindSchema,
  getModelProvider,
  listModelProviders,
  providerSupportsApiMode,
  resolveProviderUpstreamUrl
} from '../src/index.js';

describe('model provider registry', () => {
  it('defines every provider kind exactly once with a usable default auth mode', () => {
    const ids = listModelProviders().map((provider) => provider.id);
    expect([...ids].sort()).toEqual([...ModelProviderKindSchema.options].sort());
    for (const provider of listModelProviders()) {
      expect(provider.authModes).toContain(provider.defaultAuthMode);
    }
  });

  it('only routes to HTTPS endpoints and never mixes OpenRouter prefixes into direct vendors', () => {
    for (const provider of listModelProviders()) {
      for (const url of Object.values(provider.endpoints)) expect(new URL(url).protocol).toBe('https:');
      if (provider.modelsEndpoint) expect(new URL(provider.modelsEndpoint.url).protocol).toBe('https:');
      if (provider.id !== 'openrouter') {
        for (const url of Object.values(provider.endpoints)) expect(new URL(url).hostname).not.toBe('openrouter.ai');
      }
    }
  });

  it('resolves the documented OpenAI-compatible endpoint per provider and API mode', () => {
    expect(resolveProviderUpstreamUrl('google', 'chat-completions')).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(resolveProviderUpstreamUrl('openai', 'responses')).toBe('https://api.openai.com/v1/responses');
    expect(resolveProviderUpstreamUrl('openrouter', 'chat-completions')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(resolveProviderUpstreamUrl('anthropic', 'chat-completions')).toBe('https://api.anthropic.com/v1/chat/completions');
    expect(resolveProviderUpstreamUrl('deepseek', 'chat-completions')).toBe('https://api.deepseek.com/chat/completions');
  });

  it('rejects API modes and custom URLs a provider cannot serve', () => {
    expect(providerSupportsApiMode('anthropic', 'responses')).toBe(false);
    expect(providerSupportsApiMode('custom', 'responses')).toBe(true);
    expect(() => resolveProviderUpstreamUrl('anthropic', 'responses')).toThrow('does not support the responses API mode');
    expect(() => resolveProviderUpstreamUrl('custom', 'chat-completions')).toThrow('customUpstreamUrl is required');
    expect(() => resolveProviderUpstreamUrl('custom', 'chat-completions', 'http://llm.example.com/v1/chat/completions')).toThrow('HTTPS');
    expect(() => resolveProviderUpstreamUrl('custom', 'chat-completions', 'https://llm.example.com:8443/v1/chat/completions')).toThrow('HTTPS');
    expect(resolveProviderUpstreamUrl('custom', 'responses', 'https://llm.example.com/v1/responses')).toBe('https://llm.example.com/v1/responses');
    expect(getModelProvider('custom').requiresCustomUpstream).toBe(true);
  });
});
