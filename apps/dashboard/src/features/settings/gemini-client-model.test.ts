import { describe, expect, it } from 'vitest';
import { geminiRedirectUriProblem } from './gemini-client-model';

describe('Gemini client form model', () => {
  it('accepts a pasted Gemini callback, surrounding whitespace included', () => {
    expect(geminiRedirectUriProblem('  https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123 \n')).toBeUndefined();
  });

  it('refuses anything that is not a single Gemini per-account callback', () => {
    for (const value of ['', 'https://oauth-redirect.googleusercontent.com/r/*', 'https://example.com/r/abc', 'https://oauth-redirect.googleusercontent.com/r/abc?x=1']) {
      expect(geminiRedirectUriProblem(value), value).toMatch(/Paste the redirect URI from Gemini/);
    }
  });
});
