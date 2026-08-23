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
  'PRIVILEGE_APPROVAL_REQUIRED'
]);

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(2_000),
  data: z.unknown().optional(),
  error: z
    .object({
      code: ErrorCodeSchema,
      message: z.string().max(2_000),
      retryable: z.boolean(),
      grantRequest: z
        .object({
          grantId: z.string(),
          workspaceId: z.string(),
          commandSha256: z.string(),
          cwd: z.string().optional(),
          expiresAt: z.string()
        })
        .optional()
    })
    .optional(),
  truncated: z.boolean().default(false),
  cursor: z.string().max(256).optional()
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export class HarnessError extends Error {
  constructor(
    public readonly code: z.infer<typeof ErrorCodeSchema>,
    message: string,
    public readonly status = 400,
    public readonly retryable = false
  ) {
    super(message);
  }
}
