import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { RunnerResponse } from '@cloud-harness/contracts';
import { sendRunnerResponse } from '../src/dashboard-response.js';

const GITHUB_UNAVAILABLE =
  'GitHub authorization is unavailable. Check the GitHub App credentials in the runner configuration, then retry.';
const WORKSPACE_UNAVAILABLE = 'The workspace service is temporarily unavailable.';

function capture(operation: Parameters<typeof sendRunnerResponse>[1], result: RunnerResponse): { status: number; body: { message?: string } } {
  let status = 0;
  let body: { message?: string } = {};
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: { message?: string }) {
      body = payload;
      return this;
    }
  } as unknown as Response;
  sendRunnerResponse(response, operation, result);
  return { status, body };
}

const failure = (code: string, message: string): RunnerResponse =>
  ({ ok: false, error: { code, message } }) as unknown as RunnerResponse;

describe('GitHub operations report their own failures', () => {
  it('reconcile reports a GitHub authorization problem, not a workspace outage', () => {
    const { status, body } = capture('github_reconcile', failure('UNAVAILABLE', 'GitHub App setup is not configured'));
    expect(status).toBe(503);
    expect(body.message).toBe(GITHUB_UNAVAILABLE);
  });

  it('keeps the runner detail out of the browser payload', () => {
    const { body } = capture(
      'github_reconcile',
      failure('UNAVAILABLE', "GitHub App authentication failed: Cannot read properties of undefined (reading 'appId')")
    );
    expect(body.message).toBe(GITHUB_UNAVAILABLE);
    expect(JSON.stringify(body)).not.toContain('appId');
  });

  it('reports a missing installation as such', () => {
    const { status, body } = capture('github_reconcile', failure('NOT_FOUND', 'GitHub installation not found'));
    expect(status).toBe(404);
    expect(body.message).toBe('GitHub installation not found.');
  });

  it('reports an uncompletable connection attempt as such', () => {
    const { body } = capture('github_setup_complete', failure('INVALID_INPUT', 'state expired'));
    expect(body.message).toBe('The GitHub App connection could not be completed. Start the connection again.');
  });

  it('leaves other operations on the shared workspace wording', () => {
    const { status, body } = capture('workspace_status', failure('UNAVAILABLE', 'runner is restarting'));
    expect(status).toBe(503);
    expect(body.message).toBe(WORKSPACE_UNAVAILABLE);
  });
});
