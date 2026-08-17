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
