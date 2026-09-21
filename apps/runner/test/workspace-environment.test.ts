import { describe, expect, it } from 'vitest';
import { validatedWorkspaceEnvironment } from '../src/workspace-environment.js';

describe('workspace environment boundary', () => {
  it('accepts user-owned values and rejects control/provider credential names', () => {
    expect(validatedWorkspaceEnvironment({ NODE_ENV: 'test', FEATURE_FLAG: 'on' })).toEqual({ NODE_ENV: 'test', FEATURE_FLAG: 'on' });
    for (const name of ['RUNNER_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'CLOUDFLARE_API_TOKEN', 'CF_ACCESS_TOKEN', 'SECRET_KEYRING_FILE', 'BUILTIN_SKILLS_ROOT']) {
      expect(() => validatedWorkspaceEnvironment({ [name]: 'secret' }), name).toThrow(/reserved/);
    }
  });

  it('accepts GitHub credential names so the executor gh CLI can authenticate', () => {
    expect(validatedWorkspaceEnvironment({ GITHUB_TOKEN: 'ghp_example', GH_TOKEN: 'ghp_example' })).toEqual({
      GITHUB_TOKEN: 'ghp_example',
      GH_TOKEN: 'ghp_example'
    });
  });
});
