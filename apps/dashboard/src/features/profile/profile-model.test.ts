import { describe, expect, it } from 'vitest';
import { displayNameSchema, readProfile } from './profile-model';

describe('profile', () => {
  it('accepts names the BFF accepts and an empty value that clears the preference', () => {
    for (const name of ['Ops Lead', "O'Brien", 'Nguyễn Văn A', 'ops_lead-2.0', '']) {
      expect(displayNameSchema.safeParse({ displayName: name }).success, name).toBe(true);
    }
    expect(displayNameSchema.parse({ displayName: '  Ops Lead  ' })).toEqual({ displayName: 'Ops Lead' });
  });

  it('rejects markup, leading punctuation and long names', () => {
    for (const name of ['"><script>alert(1)</script>', '-lead', 'a'.repeat(65), 'semi;colon']) {
      expect(displayNameSchema.safeParse({ displayName: name }).success, name).toBe(false);
    }
  });

  it('reads only known profile fields', () => {
    expect(readProfile({
      identity: { name: 'Op Erator', email: 'op@example.com', subject: 'operator', issuer: 'https://team.cloudflareaccess.com' },
      preferences: { displayName: 'Ops Lead' }, scopes: ['mcp', 7], sessionExpiresAt: null, ownerId: 'hidden'
    })).toEqual({
      identity: { name: 'Op Erator', email: 'op@example.com', subject: 'operator', issuer: 'https://team.cloudflareaccess.com' },
      displayName: 'Ops Lead', scopes: ['mcp'], sessionExpiresAt: undefined
    });
    expect(readProfile(undefined).displayName).toBe('');
  });
});
