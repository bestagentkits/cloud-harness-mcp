import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('reports a failed script as 422 with its bounded result and without the runner text', () => {
    const { status, body } = capture('skills_run', {
      ok: false, message: 'Skill script exited with 3', truncated: true,
      data: { output: 'boom', exitCode: 3, executionMode: 'helper-container', signal: null },
      error: { code: 'EXECUTION_FAILED', message: 'Skill script exited with 3', retryable: false }
    } as unknown as RunnerResponse);
    expect(status).toBe(422);
    expect(body).toEqual({
      error: 'execution_failed',
      message: 'The skill script exited with an error.',
      data: { output: 'boom', exitCode: 3, executionMode: 'helper-container' },
      truncated: true
    });
  });

  it('answers 422 without data when a failed script reports no result', () => {
    const { status, body } = capture('skills_run', failure({ code: 'EXECUTION_FAILED', message: 'Skill script exited with 3' }));
    expect(status).toBe(422);
    expect(body).not.toHaveProperty('data');
  });

  it('keeps any other execution failure a server error', () => {
    const { status, body } = capture('hooks_run', {
      ok: false, message: 'Hook exited with 1', truncated: false, data: { output: 'x', exitCode: 1 },
      error: { code: 'EXECUTION_FAILED', message: 'Hook exited with 1', retryable: false }
    } as unknown as RunnerResponse);
    expect(status).toBe(500);
    expect(body).not.toHaveProperty('data');
  });

  it('keeps the bundle digest a run must name and the execution mode it reports', () => {
    const listed = mapDashboardData('skills_list', { skills: [{ name: 'demo', source: 'workspace', root: '/workspace/.agents/skills', contentSha256: 'c'.repeat(64) }] }) as { skills: Record<string, unknown>[] };
    expect(listed.skills[0]).toEqual({ name: 'demo', source: 'workspace', contentSha256: 'c'.repeat(64) });
    expect(mapDashboardData('skills_run', { output: 'ok', exitCode: 0, executionMode: 'helper-container', signal: null })).toEqual({ output: 'ok', exitCode: 0, executionMode: 'helper-container' });
    expect(mapDashboardData('skills_run', { exitCode: 1, signal: 'SIGTERM' })).toEqual({ exitCode: 1, signal: 'SIGTERM' });
    expect(mapDashboardData('skills_run', { exitCode: 1, signal: 'raw <text>' })).toEqual({ exitCode: 1 });
    expect(mapDashboardData('hooks_run', { exitCode: 1, signal: 'SIGTERM' })).toEqual({ exitCode: 1 });
  });
});

describe('classic dashboard client errors', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('keeps the grant request and a failed run result, and nothing else', async () => {
    const { api } = await import('../dashboard/dashboard-api.js');
    vi.stubGlobal('fetch', vi.fn(async () => reply(428, { error: 'privilege_approval_required', message: 'm', grantRequest: { grantId: 'pvg_1', expiresAt: 'e', cwd: '.' } })));
    await expect(api('/x')).rejects.toMatchObject({ status: 428, code: 'privilege_approval_required', grantRequest: { grantId: 'pvg_1', expiresAt: 'e' } });
    vi.stubGlobal('fetch', vi.fn(async () => reply(422, { error: 'execution_failed', message: 'm', data: { output: 'boom', exitCode: 3 } })));
    await expect(api('/x')).rejects.toMatchObject({ status: 422, code: 'execution_failed', data: { output: 'boom', exitCode: 3 } });
    vi.stubGlobal('fetch', vi.fn(async () => reply(500, { error: 'internal_error', message: 'm', data: { output: 'raw' } })));
    const error = await api('/x').catch((caught: unknown) => caught);
    expect(error).not.toHaveProperty('data');
  });
});
