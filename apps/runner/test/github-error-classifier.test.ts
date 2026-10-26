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

  it('classifies a check run refused to a token that is not a GitHub App as a permission gap, without retry', () => {
    const error = classifyGitHubFailure(
      'gh: You must authenticate via a GitHub App. (HTTP 403)',
      '',
      'check_run_create'
    );
    expect(error.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(error.retryable).toBe(false);
  });

  it('classifies missing GitHub App permissions as GITHUB_PERMISSION_MISSING', () => {
    const error1 = classifyGitHubFailure(
      'GraphQL: Resource not accessible by integration (createPullRequest)',
      '',
      'pr_create'
    );
    expect(error1.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(error1.retryable).toBe(false);
    // The GitHub response alone names no remedy, so the classified message must.
    expect(error1.message).toContain('Resource not accessible by integration');
    expect(error1.message).toContain('GH_TOKEN');

    const error2 = classifyGitHubFailure(
      'HTTP 403: Must have push access to repository',
      '',
      'pr_create'
    );
    expect(error2.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(error2.retryable).toBe(false);
    expect(error2.message).toContain('GH_TOKEN');

    const rateLimited = classifyGitHubFailure(
      'gh: API rate limit exceeded for installation ID 888. (HTTP 403)',
      '',
      'pr_create'
    );
    expect(rateLimited.code).toBe('GITHUB_RATE_LIMITED');
    expect(rateLimited.message).not.toContain('GH_TOKEN');

    // A long helper message must not push the remedy past the message bound.
    const long = classifyGitHubFailure(`${'GraphQL: HTTP 403 '.repeat(300)}Resource not accessible by integration`, '', 'issue_create');
    expect(long.code).toBe('GITHUB_PERMISSION_MISSING');
    expect(long.message.length).toBeLessThanOrEqual(2_000);
    expect(long.message).toContain('GH_TOKEN');
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

  it.each([
    ['pr_merge', 'GraphQL: Pull request has merge conflicts (mergePullRequest)', 'GITHUB_MERGE_CONFLICT'],
    ['pr_merge', 'X Pull request #7 is not mergeable: the merge commit cannot be cleanly created.', 'GITHUB_MERGE_CONFLICT'],
    ['pr_merge', 'X Pull request #7 is not mergeable: the base branch policy prohibits the merge. (HTTP 405)', 'GITHUB_MERGE_BLOCKED'],
    ['pr_merge', '2 of 2 required status checks are expected.', 'GITHUB_MERGE_BLOCKED'],
    ['pr_merge', 'At least 1 approving review is required by reviewers with write access.', 'GITHUB_MERGE_BLOCKED'],
    ['pr_merge', 'Head branch was modified. Review and try the merge again. (HTTP 409)', 'GITHUB_MERGE_BLOCKED'],
    ['pr_auto_merge_enable', 'GraphQL: Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)', 'GITHUB_AUTO_MERGE_UNAVAILABLE'],
    ['pr_auto_merge_enable', 'GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)', 'GITHUB_AUTO_MERGE_UNAVAILABLE'],
    ['pr_auto_merge_disable', 'GraphQL: Pull request auto merge is not enabled (disablePullRequestAutoMerge)', 'GITHUB_AUTO_MERGE_UNAVAILABLE'],
    ['pr_review', 'gh: Can not approve your own pull request (HTTP 422)', 'GITHUB_REVIEW_NOT_ALLOWED'],
    ['pr_review', 'gh: Unprocessable Entity: Can not request changes on your own pull request (HTTP 422)', 'GITHUB_REVIEW_NOT_ALLOWED'],
    ['pr_review_comment', 'gh: Unprocessable Entity: pull_request_review_thread.line must be part of the diff (HTTP 422)', 'GITHUB_REVIEW_COMMENT_INVALID'],
    ['pr_review_comment', 'gh: Validation Failed: commit_id is not part of the pull request (HTTP 422)', 'GITHUB_REVIEW_COMMENT_INVALID'],
    ['pr_reviewers_request', 'gh: Reviews may only be requested from collaborators. (HTTP 422)', 'GITHUB_REVIEWER_UNASSIGNABLE'],
    ['pr_reviewers_request', 'gh: Review cannot be requested from pull request author. (HTTP 422)', 'GITHUB_REVIEWER_UNASSIGNABLE']
  ] as const)('classifies %s failure "%s" as %s', (action, stderr, code) => {
    const error = classifyGitHubFailure(stderr, '', action);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
  });

  it('types an App merge of a workflow-file PR as a missing permission', () => {
    const error = classifyGitHubFailure('GraphQL: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission (mergePullRequest)', '', 'pr_merge');
    expect(error.code).toBe('GITHUB_PERMISSION_MISSING');
  });

  it('keeps a missing App permission on a merge distinct from a merge block', () => {
    const error = classifyGitHubFailure('gh: Resource not accessible by integration (HTTP 403)', '', 'pr_merge');
    expect(error.code).toBe('GITHUB_PERMISSION_MISSING');
  });

  it('scopes review and merge rules to their own actions', () => {
    expect(classifyGitHubFailure('gh: Can not approve your own pull request (HTTP 422)', '', 'pr_create').code).not.toBe('GITHUB_REVIEW_NOT_ALLOWED');
    expect(classifyGitHubFailure('X Pull request #7 is not mergeable', '', 'pr_update').code).not.toBe('GITHUB_MERGE_BLOCKED');
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
