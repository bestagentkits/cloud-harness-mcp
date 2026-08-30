import type { ErrorCode } from '@cloud-harness/contracts';

export type ClassifiedGitHubError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  step?: string;
};

type ClassifierRule = {
  code: ErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  actions?: readonly string[];
  patterns: readonly RegExp[];
};

const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  // 1. Rate limits MUST be checked before generic 403 / permission errors
  {
    code: 'GITHUB_RATE_LIMITED',
    retryable: true,
    retryAfterMs: 60_000,
    patterns: [
      /rate limit/i,
      /secondary rate limit/i,
      /was submitted too quickly/i,
      /abuse detection/i,
      /HTTP 429/i,
      /API rate limit exceeded/i,
      /you have exceeded a secondary rate limit/i
    ]
  },
  // 2. Authentication failures (token expired / bad credentials -> retryable via fresh token mint)
  {
    code: 'AUTHENTICATION_FAILED',
    retryable: true,
    patterns: [
      /HTTP 401/i,
      /Bad credentials/i,
      /token (is )?expired/i
    ]
  },
  // 3. Permission errors
  {
    code: 'GITHUB_PERMISSION_MISSING',
    retryable: false,
    patterns: [
      /Resource not accessible by integration/i,
      /Must have push access/i,
      /Must have admin rights/i,
      /HTTP 403/i,
      /SAML enforcement/i,
      /does not have (the )?permission/i,
      /permission to .+ denied/i,
      /not permitted/i
    ]
  },
  // 4. Invalid PR base branch (applicable to PR creation and update)
  {
    code: 'INVALID_PULL_REQUEST_BASE',
    retryable: false,
    actions: ['pr_create', 'pr_update'],
    patterns: [
      /No commits between .+ and/i,
      /Base ref must be a branch/i,
      /Base sha can't be blank/i,
      /could not find any commits between/i,
      /invalid base/i
    ]
  },
  // 5. Invalid input (e.g. invalid HEAD branch or missing required fields)
  {
    code: 'INVALID_INPUT',
    retryable: false,
    patterns: [
      /Head ref must be a branch/i,
      /Head sha can't be blank/i,
      /Title and head branch required/i,
      /Title required/i,
      /Pull request number required/i,
      /Issue number required/i
    ]
  },
  // 6. Conflicts / already exists
  {
    code: 'CONFLICT',
    retryable: false,
    patterns: [
      /already exists/i,
      /A pull request already exists/i
    ]
  },
  // 7. Not found
  {
    code: 'NOT_FOUND',
    retryable: false,
    patterns: [
      /HTTP 404/i,
      /Could not resolve to a (?:PullRequest|Issue|Repository|User)/i,
      /Could not resolve to an issue or pull request/i,
      /no pull requests found/i,
      /no issues found/i,
      /not found/i
    ]
  },
  // 8. Infrastructure / Docker / 5xx unavailable
  {
    code: 'UNAVAILABLE',
    retryable: true,
    patterns: [
      /HTTP 5\d\d/i,
      /error response from daemon/i,
      /Cannot connect to the Docker daemon/i,
      /connection refused/i,
      /temporary failure/i
    ]
  }
];

export function classifyGitHubFailure(
  stderr: string,
  stdout: string,
  action: string
): ClassifiedGitHubError {
  let text = `${stderr}\n${stdout}`.trim();
  let step: string | undefined;

  // Handle structured JSON error output (e.g. from issue_publish jq errors)
  if (stderr.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(stderr.trim()) as { error?: string; step?: string };
      if (parsed.error) {
        text = `${parsed.error}\n${text}`;
      }
      if (parsed.step) {
        step = parsed.step;
      }
    } catch {
      // Ignore JSON parse failure and fallback to raw text matching
    }
  }

  for (const rule of CLASSIFIER_RULES) {
    if (rule.actions && !rule.actions.includes(action)) {
      continue;
    }
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return {
          code: rule.code,
          message: `GitHub ${action} failed: ${stderr || stdout}`.trim().slice(0, 2_000),
          retryable: rule.retryable,
          ...(rule.retryAfterMs ? { retryAfterMs: rule.retryAfterMs } : {}),
          ...(step ? { step } : {})
        };
      }
    }
  }

  return {
    code: 'GITHUB_ACTION_FAILED',
    message: `GitHub ${action} failed: ${stderr || stdout}`.trim().slice(0, 2_000),
    retryable: false,
    ...(step ? { step } : {})
  };
}
