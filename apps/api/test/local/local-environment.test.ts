import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLocalEnvironment, isReservedName, isSecretName } from '../../src/local/local-environment.js';

describe('local-environment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/testuser';
    process.env.USER = 'testuser';
    process.env.MCP_BEARER_TOKEN = 'secret-mcp-bearer';
    process.env.RUNNER_SERVICE_TOKEN = 'secret-runner-token';
    process.env.GITHUB_APP_PRIVATE_KEY = 'secret-private-key';
    process.env.SESSION_SECRET = 'secret-session';
    process.env.CUSTOM_TEST_VAR = 'custom-value';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('preserves allowlisted system variables', () => {
    const env = buildLocalEnvironment();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/testuser');
    expect(env.USER).toBe('testuser');
  });

  it('scrubs Cloud Harness and API/runner secrets', () => {
    const env = buildLocalEnvironment();
    expect(env.MCP_BEARER_TOKEN).toBeUndefined();
    expect(env.RUNNER_SERVICE_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
  });

  it('forwards explicitly requested environment names', () => {
    const env = buildLocalEnvironment(['CUSTOM_TEST_VAR']);
    expect(env.CUSTOM_TEST_VAR).toBe('custom-value');
  });

  it('refuses to forward secret names even if requested', () => {
    const env = buildLocalEnvironment(['MCP_BEARER_TOKEN', 'GITHUB_APP_PRIVATE_KEY']);
    expect(env.MCP_BEARER_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
  });

  it('refuses to forward reserved control prefixes', () => {
    process.env.HARNESS_OVERRIDE = 'evil';
    process.env.CH_INJECT = 'evil';

    const env = buildLocalEnvironment(['HARNESS_OVERRIDE', 'CH_INJECT']);
    expect(env.HARNESS_OVERRIDE).toBeUndefined();
    expect(env.CH_INJECT).toBeUndefined();
  });

  it('injects standard git control variables', () => {
    const env = buildLocalEnvironment();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.PAGER).toBe('cat');
  });

  it('correctly identifies secret patterns and reserved prefixes', () => {
    expect(isSecretName('MCP_BEARER_TOKEN')).toBe(true);
    expect(isSecretName('GITHUB_APP_ID')).toBe(true);
    expect(isSecretName('DATABASE_URL')).toBe(true);
    expect(isSecretName('PATH')).toBe(false);

    expect(isReservedName('HARNESS_WORKSPACE_ROOT')).toBe(true);
    expect(isReservedName('CH_COMMAND')).toBe(true);
    expect(isReservedName('NODE_ENV')).toBe(false);
  });
});
