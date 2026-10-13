import type { RunnerPrincipalSelector, RunnerRequest } from '@cloud-harness/contracts';

export function runnerRequestPrincipal(request: RunnerRequest): RunnerPrincipalSelector {
  return request.version === 1
    ? { kind: 'owner', ownerId: request.ownerId }
    : request.principal;
}
