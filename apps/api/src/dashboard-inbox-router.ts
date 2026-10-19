import type { NextFunction, Response, Router } from 'express';
import {
  NotificationsRunnerDataSchemas,
  NotificationsRunnerRequestSchema,
  type NotificationsRunnerErrorCode,
  type NotificationsRunnerOperation,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';

const ERROR_STATUS: Record<NotificationsRunnerErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  FEATURE_DISABLED: 503,
  UNAVAILABLE: 503,
  INTERNAL: 503
};

const jsonObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
/** Only a single string query value is forwarded; anything else becomes null and fails the runner schema. */
const queryValue = (value: unknown): unknown => (value === undefined || value === '' ? undefined : typeof value === 'string' ? value : null);
const queryNumber = (value: unknown): unknown => {
  const text = queryValue(value);
  return typeof text === 'string' && /^\d{1,9}$/u.test(text) ? Number(text) : text;
};
const queryBoolean = (value: unknown): unknown => {
  const text = queryValue(value);
  return text === 'true' ? true : text === 'false' ? false : text;
};
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/**
 * Owner Dashboard routes for the notification inbox (`/api/v1/inbox`) and its delivery preferences
 * (`/api/v1/notification-preferences`). The session decides the principal, so an inbox can only ever be
 * read or marked by its owner; every request is validated against the full runner schema before it is
 * forwarded, and mutations pass the Dashboard Origin and CSRF checks like every other write.
 */
export function registerInboxRoutes(
  router: Router,
  runner: DashboardRunnerClient,
  principal: (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined
): void {
  router.get('/api/v1/inbox/status', endpoint('inbox_status', () => ({})));
  router.get('/api/v1/inbox', endpoint('inbox_list', (request) => defined({
    cursor: queryValue(request.query.cursor),
    limit: queryNumber(request.query.limit),
    unreadOnly: queryBoolean(request.query.unread)
  })));
  router.post('/api/v1/inbox/read', endpoint('inbox_mark_read', (request) => jsonObject(request.body)));
  router.get('/api/v1/notification-preferences', endpoint('preferences_get', () => ({})));
  router.put('/api/v1/notification-preferences', endpoint('preferences_put', (request) => jsonObject(request.body)));

  function endpoint<O extends NotificationsRunnerOperation>(operation: O, input: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        if (!runner.callNotifications) {
          response.status(503).json({ error: 'unavailable', message: 'Notifications are not available.' });
          return;
        }
        const parsed = NotificationsRunnerRequestSchema.safeParse({ version: 1, principal: selected, operation, input: input(request) });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 2 ? `${issue.path.slice(2).join('.')}: ` : '';
          response.status(400).json({ error: 'invalid_request', message: `${where}${issue?.message ?? 'The request could not be processed.'}`.slice(0, 500) });
          return;
        }
        const result = await runner.callNotifications(parsed.data);
        if (!result.ok) {
          const status = ERROR_STATUS[result.error.code];
          const generic = status === 503 && result.error.code !== 'FEATURE_DISABLED';
          response.status(status).json({
            error: result.error.code.toLowerCase(),
            message: generic ? 'Notifications are temporarily unavailable.' : result.error.message
          });
          return;
        }
        const data = NotificationsRunnerDataSchemas[operation].safeParse(result.data);
        if (!data.success) {
          response.status(503).json({ error: 'unavailable', message: 'Notifications are temporarily unavailable.' });
          return;
        }
        response.json({ data: data.data });
      } catch (error) { next(error); }
    };
  }
}
