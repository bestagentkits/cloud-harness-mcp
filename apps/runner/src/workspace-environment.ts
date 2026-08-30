import { HarnessError, validateSecretName, validateSecretValue } from '@cloud-harness/contracts';

export function validatedWorkspaceEnvironment(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const nameCheck = validateSecretName(name);
    if (!nameCheck.ok) {
      throw new HarnessError('INVALID_INPUT', `environment variable ${name} is reserved or invalid: ${nameCheck.error}`, 400, false);
    }
    const valCheck = validateSecretValue(value);
    if (!valCheck.ok) {
      throw new HarnessError('INVALID_INPUT', `environment variable ${name} value is invalid: ${valCheck.error}`, 400, false);
    }
    result[nameCheck.name] = valCheck.value;
  }
  return result;
}
