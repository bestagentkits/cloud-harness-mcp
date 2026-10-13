import { describe, expect, it } from 'vitest';
import { RunnerRequestSchema } from '@cloud-harness/contracts';
import { runnerRequestPrincipal } from '../src/runner-request-principal.js';

describe('runner request principal compatibility', () => {
  it('normalizes legacy version 1 owner requests', () => {
    const request = RunnerRequestSchema.parse({
      version: 1,
      ownerId: 'legacy-owner',
      operation: 'workspace_list',
      input: { limit: 10 }
    });
    expect(runnerRequestPrincipal(request)).toEqual({ kind: 'owner', ownerId: 'legacy-owner' });
  });

  it('preserves version 2 external principal selectors', () => {
    const request = RunnerRequestSchema.parse({
      version: 2,
      principal: {
        kind: 'external',
        issuer: 'https://access.example.com',
        subject: 'subject-123',
        email: 'person@example.com'
      },
      operation: 'workspace_list',
      input: { limit: 10 }
    });
    expect(runnerRequestPrincipal(request)).toEqual(request.principal);
  });
});
