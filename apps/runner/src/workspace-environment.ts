import { HarnessError, validateSecretName } from '@cloud-harness/contracts';

export function validatedWorkspaceEnvironment(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const nameCheck = validateSecretName(name);
    if (!nameCheck.ok) {
      throw new HarnessError('INVALID_INPUT', `environment variable ${name} is reserved or invalid: ${nameCheck.error}`, 400, false);
    }
    if (Buffer.byteLength(value, 'utf8') > 65_536 || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
      throw new HarnessError('INVALID_INPUT', `environment variable ${name} value is invalid`, 400, false);
    }
    result[nameCheck.name] = value;
  }
  return result;
}
