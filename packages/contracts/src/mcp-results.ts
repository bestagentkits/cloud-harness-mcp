import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'AUTHENTICATION_FAILED',
  'FORBIDDEN',
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFLICT',
  'EXPIRED',
  'LIMIT_EXCEEDED',
  'TIMEOUT',
  'CANCELLED',
  'UNAVAILABLE',
  'INTERNAL_ERROR',
  'PRIVILEGE_APPROVAL_REQUIRED',
  'REPOSITORY_OPERATION_NOT_AUTHORIZED',
  'GITHUB_PERMISSION_MISSING',
  'GITHUB_RATE_LIMITED',
  'INVALID_PULL_REQUEST_BASE',
  'GITHUB_ACTION_FAILED'
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const ToolResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(2_000),
  data: z.unknown().optional(),
  error: z
    .object({
      code: ErrorCodeSchema,
      message: z.string().max(2_000),
      retryable: z.boolean(),
      retryAfterMs: z.number().int().min(0).optional(),
      deadline: z.string().optional(),
      grantRequest: z
        .object({
          grantId: z.string(),
          workspaceId: z.string(),
          commandSha256: z.string(),
          cwd: z.string().optional(),
          expiresAt: z.string()
        })
        .optional(),
      operation: z.string().optional(),
      repository: z.string().optional(),
      requiredCapability: z.string().optional()
    })
    .optional(),
  truncated: z.boolean().default(false),
  cursor: z.string().max(256).optional()
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export class HarnessError extends Error {
  public readonly operation?: string | undefined;
  public readonly repository?: string | undefined;
  public readonly requiredCapability?: string | undefined;

  constructor(
    public readonly code: z.infer<typeof ErrorCodeSchema>,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
    details?: {
      operation?: string | undefined;
      repository?: string | undefined;
      requiredCapability?: string | undefined;
    }
  ) {
    super(message);
    if (details?.operation !== undefined) {
      this.operation = details.operation;
    }
    if (details?.repository !== undefined) {
      this.repository = details.repository;
    }
    if (details?.requiredCapability !== undefined) {
      this.requiredCapability = details.requiredCapability;
    }
  }
}
