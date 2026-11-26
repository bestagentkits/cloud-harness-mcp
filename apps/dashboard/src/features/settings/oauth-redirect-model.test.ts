import { describe, expect, it } from 'vitest';
import { parseUriLines, presetState, readRedirectUris, removedUris, togglePreset } from './oauth-redirect-model';

const gemini = { id: 'gemini', label: 'Gemini custom apps', uris: ['https://oauth-redirect.googleusercontent.com/r/*'] };
const claude = { id: 'claude', label: 'Claude', uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'] };

describe('redirect URI editor model', () => {
  it('reads only known fields and treats a missing list as unknown, not empty', () => {
    expect(readRedirectUris(undefined)).toBeUndefined();
    expect(readRedirectUris({ canWrite: true, uris: null, presets: [gemini, { id: 1 }], extra: 'x' })).toEqual({
      canWrite: true, dynamicRegistrationEnabled: null, allowAnyOnLocalhost: null, allowAnyOnLoopback: null, uris: null, presets: [gemini]
    });
  });

  it('parses one URI per line, dropping blanks and repeats', () => {
    expect(parseUriLines(' https://a.example/cb \n\nhttps://b.example/cb\nhttps://a.example/cb\n')).toEqual(['https://a.example/cb', 'https://b.example/cb']);
  });

  it('turns a preset on by appending missing URIs and off by removing all of them', () => {
    const partial = ['https://x.example/cb', 'https://claude.ai/api/mcp/auth_callback'];
    expect(presetState(claude, partial)).toBe('partial');
    expect(togglePreset(partial, claude, true)).toEqual([...partial, 'https://claude.com/api/mcp/auth_callback']);
    expect(togglePreset(partial, claude, false)).toEqual(['https://x.example/cb']);
    expect(presetState(gemini, togglePreset([], gemini, true))).toBe('on');
  });

  it('reports what a save would remove from the provider allowlist', () => {
    expect(removedUris(['https://a.example/cb', 'https://b.example/cb'], ['https://b.example/cb', 'https://c.example/cb'])).toEqual(['https://a.example/cb']);
  });
});
