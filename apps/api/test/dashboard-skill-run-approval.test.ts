import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { RunnerResponse } from '@cloud-harness/contracts';
import { mapDashboardData, sendRunnerResponse } from '../src/dashboard-response.js';

function capture(operation: Parameters<typeof sendRunnerResponse>[1], result: RunnerResponse): { status: number; body: Record<string, unknown> } {
  let status = 200;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) { status = code; return this; },
    json(payload: Record<string, unknown>) { body = payload; return this; }
  } as unknown as Response;
  sendRunnerResponse(response, operation, result);
  return { status, body };
}

const failure = (error: Record<string, unknown>): RunnerResponse => ({ ok: false, message: 'failed', truncated: false, error } as unknown as RunnerResponse);

describe('skill-run approval projection', () => {
  it('answers 428 with only the grant id and expiry', () => {
    const { status, body } = capture('skills_run', failure({
      code: 'PRIVILEGE_APPROVAL_REQUIRED', message: 'Approval grant required to run skill script demo/run.sh', retryable: true,
      grantRequest: { grantId: 'pvg_1', workspaceId: 'ws_1', commandSha256: 'd'.repeat(64), cwd: '.', expiresAt: '2026-10-21T09:00:00.000Z' }
    }));
    expect(status).toBe(428);
    expect(body).toEqual({
      error: 'privilege_approval_required',
      message: 'This action needs your approval before it runs.',
      grantRequest: { grantId: 'pvg_1', expiresAt: '2026-10-21T09:00:00.000Z' }
    });
  });

  it('omits an approval request that names no grant', () => {
    const { status, body } = capture('skills_run', failure({ code: 'PRIVILEGE_APPROVAL_REQUIRED', message: 'x', retryable: true }));
    expect(status).toBe(428);
    expect(body).not.toHaveProperty('grantRequest');
  });

  it('names a used or expired grant instead of only a missing workspace', () => {
    const { status, body } = capture('skills_run', failure({ code: 'FORBIDDEN', message: 'Invalid, expired, or already-consumed approval grant token' }));
    expect(status).toBe(404);
    expect(body.message).toContain('approval expired or was already used');
    expect(body).not.toHaveProperty('grantRequest');
  });

  it('names a missing script or an approval that can no longer be decided', () => {
    expect(capture('skills_run', failure({ code: 'NOT_FOUND', message: 'skill script nope.sh not found in snapshot' })).body.message).toContain('skill or script not found');
    expect(capture('skills_run', failure({ code: 'NO_EXECUTABLE_ASSETS', message: 'x' })).body.message).toBe('This skill revision has no scripts to run.');
    const approve = capture('privilege_grant_approve', failure({ code: 'NOT_FOUND', message: 'privilege grant not found, expired, or already approved/consumed' }));
    expect(approve.status).toBe(404);
    expect(approve.body.message).toContain('expired or was already decided');
  });

  it('reports a failed script without the runner text', () => {
    const { status, body } = capture('skills_run', failure({ code: 'EXECUTION_FAILED', message: 'Skill script exited with 3' }));
    expect(status).toBe(500);
    expect(body.message).toBe('The skill script exited with an error.');
  });

  it('keeps the bundle digest a run must name and the execution mode it reports', () => {
    const listed = mapDashboardData('skills_list', { skills: [{ name: 'demo', source: 'workspace', root: '/workspace/.agents/skills', contentSha256: 'c'.repeat(64) }] }) as { skills: Record<string, unknown>[] };
    expect(listed.skills[0]).toEqual({ name: 'demo', source: 'workspace', contentSha256: 'c'.repeat(64) });
    expect(mapDashboardData('skills_run', { output: 'ok', exitCode: 0, executionMode: 'helper-container', signal: null })).toEqual({ output: 'ok', exitCode: 0, executionMode: 'helper-container' });
  });
});
