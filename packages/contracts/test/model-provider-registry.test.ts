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
    expect(resolveProviderUpstreamUrl('opencode-go', 'chat-completions')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(resolveProviderUpstreamUrl('opencode-go', 'responses')).toBe('https://opencode.ai/inference/go/openai/v1/responses');
  });

  it('defines OpenCode Go as a bearer provider on opencode.ai that requires its session header', () => {
    const provider = getModelProvider('opencode-go');
    expect(provider.authModes).toEqual(['bearer']);
    expect(provider.requiresCustomUpstream).toBe(false);
    expect(provider.catalogStrategy).toBe('provider-models');
    expect(provider.openRouterVendor).toBeNull();
    expect(provider.modelsEndpoint).toEqual({ url: 'https://opencode.ai/inference/go/v1/models', auth: 'bearer' });
    for (const url of [...Object.values(provider.endpoints), provider.modelsEndpoint!.url, provider.docsUrl!, provider.apiKeyUrl!]) {
      expect(new URL(url).protocol).toBe('https:');
      expect(new URL(url).hostname).toBe('opencode.ai');
    }
    expect(provider.sessionHeader).toBe('x-opencode-session');
  });

  it('names a session header only for providers that require one', () => {
    for (const provider of listModelProviders()) {
      if (provider.id === 'opencode-go') continue;
      expect(provider.sessionHeader, provider.id).toBeNull();
    }
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

  it('refuses custom upstream URLs that carry credentials, a query, a fragment, or an unfixed path', () => {
    const resolve = (url: string) => () => resolveProviderUpstreamUrl('custom', 'chat-completions', url);
    for (const url of [
      'https://user:pass@llm.example.com/v1/chat/completions',
      'https://llm.example.com/v1/chat/completions?api-key=x',
      'https://llm.example.com/v1/chat/completions?',
      'https://llm.example.com/v1/chat/completions#frag'
    ]) expect(resolve(url)).toThrow('credentials, a query string, or a fragment');
    for (const url of [
      'https://llm.example.com/v1/%2e%2e/chat/completions',
      'https://llm.example.com/v1\\chat/completions',
      'https://llm.example.com/',
      'https://llm.example.com/v1/'
    ]) expect(resolve(url)).toThrow('one fixed request path');
    expect(resolve('not a url')).toThrow('absolute HTTPS URL');
    expect(resolve('https://llm.example.com/v1/chat/completions\n')).toThrow('whitespace or control characters');
    expect(resolveProviderUpstreamUrl('custom', 'chat-completions', 'https://llm.example.com:443/v1/chat/completions'))
      .toBe('https://llm.example.com:443/v1/chat/completions');
  });
});
