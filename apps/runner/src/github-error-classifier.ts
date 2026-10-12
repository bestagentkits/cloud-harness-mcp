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

const MAX_MESSAGE_CHARS = 2_000;

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
  // 3. Review and merge failures. They precede the generic permission rule because GitHub reports
  // several of them as HTTP 403/405/422, and the remedy differs from a missing App permission.
  {
    code: 'GITHUB_MERGE_CONFLICT',
    retryable: false,
    actions: ['pr_merge', 'pr_auto_merge_enable'],
    patterns: [
      /merge conflict/i,
      /conflicting files/i,
      /cannot be cleanly created/i,
      /not mergeable:? .*conflict/i
    ]
  },
  {
    code: 'GITHUB_MERGE_BLOCKED',
    retryable: false,
    actions: ['pr_merge'],
    patterns: [
      /not mergeable/i,
      /base branch policy prohibits the merge/i,
      /required status checks?/i,
      /status checks? (?:are|is) (?:expected|failing|pending)/i,
      /at least \d+ (?:approving )?reviews? (?:is|are) required/i,
      /review is required/i,
      /changes requested/i,
      /branch protection/i,
      /protected branch/i,
      /head branch was modified/i,
      /merge queue/i
    ]
  },
  {
    code: 'GITHUB_AUTO_MERGE_UNAVAILABLE',
    retryable: false,
    actions: ['pr_auto_merge_enable', 'pr_auto_merge_disable'],
    patterns: [
      /auto[- ]?merge (?:is )?not allowed/i,
      /auto[- ]?merge is not (?:enabled|available)/i,
      /in clean status/i,
      /auto[- ]?merge[^\n]*(?:is not|isn't) (?:enabled|set|active)/i,
      /protected branch rules not configured/i
    ]
  },
  {
    code: 'GITHUB_REVIEW_NOT_ALLOWED',
    retryable: false,
    actions: ['pr_review'],
    patterns: [
      /can ?not (?:approve|request changes on) your own pull request/i,
      /own pull request/i,
      /review cannot be (?:submitted|created)/i,
      /pending review/i
    ]
  },
  {
    code: 'GITHUB_REVIEW_COMMENT_INVALID',
    retryable: false,
    actions: ['pr_review_comment', 'pr_review_reply'],
    patterns: [
      /must be part of the diff/i,
      /(?:line|position|start_line|path|start_side|commit_id|side)[^\n]*(?:could not be resolved|is not part of|is invalid|must precede|is outdated|wasn't found)/i,
      /diff hunk/i,
      /outdated/i,
      /unprocessable entity/i
    ]
  },
  {
    code: 'GITHUB_REVIEWER_UNASSIGNABLE',
    retryable: false,
    actions: ['pr_reviewers_request', 'pr_reviewers_remove'],
    patterns: [
      /reviews? may only be requested from collaborators/i,
      /review cannot be requested from pull request author/i,
      /not a collaborator/i,
      /could not (?:add|remove) reviewers?/i,
      /unprocessable entity/i
    ]
  },
  // 4. Permission errors
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
  // 5. Invalid PR base branch (applicable to PR creation and update)
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
  // 6. Invalid input (e.g. invalid HEAD branch or missing required fields)
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
  // 7. Conflicts / already exists
  {
    code: 'CONFLICT',
    retryable: false,
    patterns: [
      /already exists/i,
      /A pull request already exists/i
    ]
  },
  // 8. Not found
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
  // 9. Infrastructure / Docker / 5xx unavailable
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
        const detail = `GitHub ${action} failed: ${stderr || stdout}`.trim();
        // A permission failure is only actionable with its remedy: the broker has no
        // way to know which credential GitHub rejected after the helper ran. The
        // remedy must survive truncation of a long helper message.
        const remedy = 'the credential used for this action is missing the required GitHub permission. Add it to the GitHub App and approve the pending installation change, or configure an operator GH_TOKEN runtime secret.';
        const message = rule.code === 'GITHUB_PERMISSION_MISSING'
          ? `${detail.slice(0, MAX_MESSAGE_CHARS - remedy.length - 3)} — ${remedy}`
          : detail.slice(0, MAX_MESSAGE_CHARS);
        return {
          code: rule.code,
          message,
          retryable: rule.retryable,
          ...(rule.retryAfterMs ? { retryAfterMs: rule.retryAfterMs } : {}),
          ...(step ? { step } : {})
        };
      }
    }
  }

  return {
    code: 'GITHUB_ACTION_FAILED',
    message: `GitHub ${action} failed: ${stderr || stdout}`.trim().slice(0, MAX_MESSAGE_CHARS),
    retryable: false,
    ...(step ? { step } : {})
  };
}
