import { HarnessError } from '@cloud-harness/contracts';

const forbiddenExact = new Set([
  'AUTHORIZATION', 'OWNER_ID', 'RUNNER_TOKEN', 'STATE_DB', 'JOBS_ROOT', 'DOCKER_HOST',
  'GITHUB_TOKEN', 'GH_TOKEN', 'SECRET_KEYRING', 'SECRET_KEYRING_FILE'
]);
const forbiddenPrefixes = ['CLOUDFLARE_', 'CF_', 'GITHUB_APP_', 'ACCESS_', 'RUNNER_', 'DOCKER_'];

export function validatedWorkspaceEnvironment(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name) || forbiddenExact.has(name) || forbiddenPrefixes.some((prefix) => name.startsWith(prefix))) {
      throw new HarnessError('INVALID_INPUT', `environment variable ${name} is reserved for the control plane`, 400, false);
    }
    if (Buffer.byteLength(value, 'utf8') > 65_536 || value.includes('\0')) {
      throw new HarnessError('INVALID_INPUT', `environment variable ${name} is invalid`, 400, false);
    }
    result[name] = value;
  }
  return result;
}
