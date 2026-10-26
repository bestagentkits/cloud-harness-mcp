// `/profile` and `/preferences` are served by the real test API (e2e/test-server.mjs signs
// an Access assertion for this identity); the stub below is only for loading and error states.

export const SIGNED_IN = { email: 'owner@example.test', subject: 'e2e-owner', issuer: 'https://e2e.cloudflareaccess.invalid' } as const;

export const PROFILE_BODY = {
  data: {
    identity: { issuer: SIGNED_IN.issuer, subject: SIGNED_IN.subject, email: SIGNED_IN.email },
    scopes: [],
    preferences: { displayName: null },
    sessionExpiresAt: null
  }
};
