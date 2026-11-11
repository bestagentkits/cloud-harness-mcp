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

const failure = (code: string, message: string, retryable = false): RunnerResponse =>
  ({ ok: false, error: { code, message, retryable } }) as unknown as RunnerResponse;

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

  it('shows why a binding was refused, so the operator knows whom to sign in as', () => {
    const refusal = 'Your GitHub account cannot access installation 456. Sign in to GitHub as the account owner or an organization owner, then start again.';
    const { body } = capture('github_setup_complete', failure('FORBIDDEN', refusal));
    expect(body.message).toBe(refusal);
  });

  it('points an unconfigured user authorization at the client credentials and Callback URL', () => {
    for (const operation of ['github_authorize_begin', 'github_setup_complete'] as const) {
      const { body } = capture(operation, failure('UNAVAILABLE', 'GitHub App user authorization is not configured: raw detail'));
      expect(body.message).toContain('GITHUB_APP_CLIENT_ID');
      expect(body.message).toContain('Callback URL');
      expect(body.message).not.toContain('raw detail');
    }
  });

  it('tells the user to retry a transient failure only where the state is still unspent', () => {
    const begin = capture('github_authorize_begin', failure('UNAVAILABLE', 'GitHub user authorization failed: raw provider detail', true));
    expect(begin.status).toBe(503);
    expect(begin.body.message).toContain('Retry');
    expect(begin.body.message).not.toContain('Start the connection again');

    // The OAuth return already consumed its state, so retrying the same return cannot work.
    for (const result of [
      failure('UNAVAILABLE', 'GitHub user authorization failed: raw provider detail', true),
      failure('TIMEOUT', 'raw provider detail', true)
    ]) {
      const { body } = capture('github_setup_complete', result);
      expect(body.message).toContain('Start the connection again');
      expect(body.message).not.toContain('Retry');
      expect(body.message).not.toContain('GITHUB_APP_CLIENT_ID');
      expect(body.message).not.toContain('Callback URL');
      expect(body.message).not.toContain('raw provider detail');
    }
  });

  it('reports a refused GitHub state as a 403 the dashboard reads as an expired connection', () => {
    for (const operation of ['github_authorize_begin', 'github_setup_complete'] as const) {
      expect(capture(operation, failure('FORBIDDEN', 'invalid or expired')).status).toBe(403);
    }
    expect(capture('workspace_status', failure('FORBIDDEN', 'x')).status).toBe(404);
  });

  it('leaves other operations on the shared workspace wording', () => {
    const { status, body } = capture('workspace_status', failure('UNAVAILABLE', 'runner is restarting'));
    expect(status).toBe(503);
    expect(body.message).toBe(WORKSPACE_UNAVAILABLE);
  });
});

describe('GitHub user authorization failures', () => {
  it('maps GITHUB_USER_AUTHORIZATION_REQUIRED to a 403 that names where to reconnect, from any operation', () => {
    for (const operation of ['workspace_status', 'github_status', 'github_reconcile', 'github_user_disconnect'] as const) {
      const { status, body } = capture(operation, failure('GITHUB_USER_AUTHORIZATION_REQUIRED', 'runner detail naming ghu_secret'));
      expect(status).toBe(403);
      expect(body.message).toBe('Your GitHub user authorization is required. Reconnect it in Integrations → GitHub → GitHub user.');
      expect(JSON.stringify(body)).not.toContain('ghu_secret');
    }
  });

  it('points an unconfigured user authorization at the keyring that stores the token, and keeps disconnect wording static', () => {
    const begin = capture('github_authorize_begin', failure('UNAVAILABLE', 'GitHub user authorization is not configured: raw detail'));
    expect(begin.body.message).toContain('SECRET_KEYRING');
    expect(begin.body.message).toContain('GITHUB_APP_CLIENT_ID');
    const disconnect = capture('github_user_disconnect', failure('UNAVAILABLE', 'raw detail'));
    expect(disconnect.status).toBe(503);
    expect(disconnect.body.message).toContain('SECRET_KEYRING');
    expect(disconnect.body.message).not.toContain('raw detail');
  });
});
