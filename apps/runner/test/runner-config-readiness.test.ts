import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRunnerConfigWithReadiness } from '../src/config.js';

afterEach(() => vi.unstubAllEnvs());

function requiredEnvironment() {
  vi.stubEnv('RUNNER_TOKEN', 'r'.repeat(32));
}

describe('runner secret configuration readiness', () => {
  it('keeps the runner configuration available when the keyring JSON is malformed', () => {
    requiredEnvironment();
    vi.stubEnv('SECRET_KEYRING', '{');
    expect(loadRunnerConfigWithReadiness()).toMatchObject({
      config: { secretKeyring: undefined },
      secretReadinessError: 'secret keyring configuration is invalid'
    });
  });

  it('keeps the runner configuration available when keyring material is schema-invalid', () => {
    requiredEnvironment();
    vi.stubEnv('SECRET_KEYRING', JSON.stringify({ activeVersion: 0, keys: [] }));
    expect(loadRunnerConfigWithReadiness()).toMatchObject({
      config: { secretKeyring: undefined },
      secretReadinessError: 'secret keyring configuration is invalid'
    });
  });

  it('does not report a configuration error when no keyring is configured', () => {
    requiredEnvironment();
    const loaded = loadRunnerConfigWithReadiness();
    expect(loaded.config.secretKeyring).toBeUndefined();
    expect(loaded.secretReadinessError).toBeUndefined();
  });
});

describe('Cloudflare Access Managed OAuth control-plane configuration', () => {
  const identifiers = () => {
    vi.stubEnv('CLOUDFLARE_ACCESS_API_TOKEN', 'cf-token-' + 'q'.repeat(32));
    vi.stubEnv('CLOUDFLARE_ACCESS_ACCOUNT_ID', '0123456789abcdef0123456789abcdef');
    vi.stubEnv('CLOUDFLARE_ACCESS_APP_ID', '11111111-2222-4333-8444-555555555555');
  };

  it('stays disabled when nothing is configured', () => {
    requiredEnvironment();
    expect(loadRunnerConfigWithReadiness().config.cloudflareAccessOAuth).toBeUndefined();
  });

  it('loads a complete read-write integration in cloudflare-access mode', () => {
    requiredEnvironment();
    vi.stubEnv('AUTH_MODE', 'cloudflare-access');
    identifiers();
    expect(loadRunnerConfigWithReadiness().config.cloudflareAccessOAuth).toMatchObject({
      accountId: '0123456789abcdef0123456789abcdef', appId: '11111111-2222-4333-8444-555555555555', access: 'read-write'
    });
  });

  it('accepts a read-only integration and an operator provider maximum', () => {
    requiredEnvironment();
    vi.stubEnv('AUTH_MODE', 'cloudflare-access');
    identifiers();
    vi.stubEnv('CLOUDFLARE_ACCESS_OAUTH_ACCESS', 'read-only');
    vi.stubEnv('CLOUDFLARE_ACCESS_OAUTH_MAX_GRANT_SECONDS', '1209600');
    expect(loadRunnerConfigWithReadiness().config.cloudflareAccessOAuth).toMatchObject({ access: 'read-only', maxGrantSeconds: 1_209_600 });
  });

  it('fails startup on a partial or misplaced integration instead of silently disabling it', () => {
    requiredEnvironment();
    vi.stubEnv('AUTH_MODE', 'cloudflare-access');
    vi.stubEnv('CLOUDFLARE_ACCESS_ACCOUNT_ID', '0123456789abcdef0123456789abcdef');
    expect(() => loadRunnerConfigWithReadiness()).toThrow();
    vi.unstubAllEnvs();
    requiredEnvironment();
    identifiers();
    expect(() => loadRunnerConfigWithReadiness()).toThrow(/only valid in cloudflare-access mode/);
  });
});

describe('oidc mode and remote Docker host configuration', () => {
  it('loads oidc mode with a legacy principal mapping but refuses Cloudflare-only Managed OAuth', () => {
    requiredEnvironment();
    vi.stubEnv('AUTH_MODE', 'oidc');
    vi.stubEnv('ACCESS_LEGACY_OWNER_ID', 'owner');
    vi.stubEnv('ACCESS_LEGACY_ISSUER', 'https://tose.example.test');
    vi.stubEnv('ACCESS_LEGACY_SUBJECT', 'tose-user-42');
    expect(loadRunnerConfigWithReadiness().config).toMatchObject({
      authMode: 'oidc',
      legacyPrincipalMapping: { legacyOwnerId: 'owner', issuer: 'https://tose.example.test', subject: 'tose-user-42' }
    });
    vi.stubEnv('CLOUDFLARE_ACCESS_API_TOKEN', 'cf-token-' + 'q'.repeat(32));
    vi.stubEnv('CLOUDFLARE_ACCESS_ACCOUNT_ID', '0123456789abcdef0123456789abcdef');
    vi.stubEnv('CLOUDFLARE_ACCESS_APP_ID', '11111111-2222-4333-8444-555555555555');
    expect(() => loadRunnerConfigWithReadiness()).toThrow(/only valid in cloudflare-access mode/);
  });

  it('keeps Docker on demand off and gateway discovery automatic by default', () => {
    requiredEnvironment();
    const { config } = loadRunnerConfigWithReadiness();
    expect(config.dockerOnDemand).toBe(false);
    expect(config.agentGatewayContainer).toBeUndefined();
  });

  it('reads DOCKER_ON_DEMAND and a pinned model gateway container name', () => {
    requiredEnvironment();
    vi.stubEnv('DOCKER_ON_DEMAND', 'true');
    vi.stubEnv('AGENT_GATEWAY_CONTAINER', 'cloudharness-model-gateway');
    expect(loadRunnerConfigWithReadiness().config).toMatchObject({ dockerOnDemand: true, agentGatewayContainer: 'cloudharness-model-gateway' });
  });

  it('refuses a gateway container value that is not a Docker container name', () => {
    requiredEnvironment();
    vi.stubEnv('AGENT_GATEWAY_CONTAINER', '--format={{json .}}');
    expect(() => loadRunnerConfigWithReadiness()).toThrow(/Docker container name/);
  });
});
