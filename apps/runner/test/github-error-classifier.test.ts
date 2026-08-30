import { describe, expect, it } from 'vitest';
import { classifyGitHubFailure } from '../src/github-error-classifier.js';

describe('GitHub Error Classifier', () => {
  it('classifies rate limit errors and sets retryable: true', () => {
    const error1 = classifyGitHubFailure(
      'gh: API rate limit exceeded for installation ID 12345678. (HTTP 403)',
      '',
      'pr_list'
    );
    expect(error1.code).toBe('GITHUB_RATE_LIMITED');
    expect(error1.retryable).toBe(true);
    expect(error1.retryAfterMs).toBe(60_000);

    const error2 = classifyGitHubFailure(
      'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
      '',
      'pr_create'
    );
    expect(error2.code).toBe('GITHUB_RATE_LIMITED');
    expect(error2.retryable).toBe(true);

    const error3 = classifyGitHubFailure(
      'GraphQL: was submitted too quickly (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error3.code).toBe('GITHUB_RATE_LIMITED');
    expect(error3.retryable).toBe(true);
  });

  it('correctly prioritizes rate limit over 403 / permission error', () => {
    // Ordering trap test: A string with both 'rate limit' and 'HTTP 403' MUST be classified as rate limit
    const error = classifyGitHubFailure(
      'HTTP 403: API rate limit exceeded for user',
      '',
      'issue_create'
    );
    expect(error.code).toBe('GITHUB_RATE_LIMITED');
    expect(error.retryable).toBe(true);
  });

  it('classifies authentication failures as retryable AUTHENTICATION_FAILED', () => {
    const error = classifyGitHubFailure(
      'HTTP 401: Bad credentials',
      '',
      'pr_list'
    );
    expect(error.code).toBe('AUTHENTICATION_FAILED');
    expect(error.retryable).toBe(true);
  });

  it('classifies missing GitHub App permissions as GITHUB_PERMISSION_MISSING', () => {
    const error1 = classifyGitHubFailure(
      'GraphQL: Resource not accessible by integration (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error1.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(error1.retryable).toBe(false);

    const error2 = classifyGitHubFailure(
      'HTTP 403: Must have push access to repository',
      '',
      'pr_create'
    );
    expect(error2.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(error2.retryable).toBe(false);
  });

  it('classifies invalid PR base branch as INVALID_PULL_REQUEST_BASE for PR actions', () => {
    const error1 = classifyGitHubFailure(
      'GraphQL: No commits between main and feat/test (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error1.code).toBe('INVALID_PULL_REQUEST_BASE');
    expect(error1.retryable).toBe(false);

    const error2 = classifyGitHubFailure(
      'GraphQL: Base ref must be a branch (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error2.code).toBe('INVALID_PULL_REQUEST_BASE');
    expect(error2.retryable).toBe(false);
  });

  it('classifies invalid PR head ref as INVALID_INPUT', () => {
    const error = classifyGitHubFailure(
      'GraphQL: Head ref must be a branch (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.retryable).toBe(false);
  });

  it('classifies conflict / already exists as CONFLICT', () => {
    const error = classifyGitHubFailure(
      'GraphQL: A pull request already exists for owner:feat-branch. (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.retryable).toBe(false);
  });

  it('classifies not found errors as NOT_FOUND', () => {
    const error1 = classifyGitHubFailure(
      'HTTP 404: Not Found',
      '',
      'pr_view'
    );
    expect(error1.code).toBe('NOT_FOUND');
    expect(error1.retryable).toBe(false);

    const error2 = classifyGitHubFailure(
      'Could not resolve to a PullRequest with the number of 9999',
      '',
      'pr_view'
    );
    expect(error2.code).toBe('NOT_FOUND');
    expect(error2.retryable).toBe(false);
  });

  it('classifies docker / 5xx infrastructure errors as UNAVAILABLE with retryable: true', () => {
    const error = classifyGitHubFailure(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      '',
      'pr_create'
    );
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('parses structured JSON error output and extracts step', () => {
    const jsonStderr = JSON.stringify({
      error: 'failed to add labels',
      step: 'add_labels',
      issueNumber: 42
    });
    const error = classifyGitHubFailure(
      jsonStderr,
      '',
      'issue_publish'
    );
    expect(error.code).toBe('GITHUB_ACTION_FAILED');
    expect(error.step).toBe('add_labels');
    expect(error.retryable).toBe(false);
  });

  it('falls back to GITHUB_ACTION_FAILED for unclassified errors', () => {
    const error = classifyGitHubFailure(
      'unknown unexpected CLI failure occurred',
      '',
      'pr_create'
    );
    expect(error.code).toBe('GITHUB_ACTION_FAILED');
    expect(error.retryable).toBe(false);
  });
});
