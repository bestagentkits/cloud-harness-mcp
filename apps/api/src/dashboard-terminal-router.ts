import type { NextFunction, Response, Router } from 'express';
import {
  TERMINAL_MAX_WAIT_MS,
  TerminalCloseInputSchema,
  TerminalColsSchema,
  TerminalIdSchema,
  TerminalInputInputSchema,
  TerminalListInputSchema,
  TerminalOpenInputSchema,
  TerminalReadInputSchema,
  TerminalResizeInputSchema,
  TerminalRowsSchema,
  WorkspaceIdSchema,
  type InternalRunnerOperation,
  type RunnerPrincipalSelector
} from '@cloud-harness/contracts';
import { z } from 'zod';
import { sendRunnerResponse } from './dashboard-response.js';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';

type TerminalOperation = Extract<InternalRunnerOperation, `terminal_${string}`>;

/**
 * Headroom between the longest read the BFF asks the runner to park and the API's own runner request
 * timeout. Without it a quiet terminal would surface as a TIMEOUT error instead of an empty page.
 */
const LONG_POLL_HEADROOM_MS = 5_000;

/**
 * Request bodies carry only what the browser legitimately chooses. Each schema is strict, so a body that
 * tries to name a workspace, terminal, or principal is refused instead of merged: those come from the
 * path and the authenticated session only.
 */
const openBody = z.object({
  cwd: z.string().optional(),
  cols: TerminalColsSchema.optional(),
  rows: TerminalRowsSchema.optional()
}).strict();
const inputBody = z.object({ data: z.string() }).strict();
const resizeBody = z.object({ cols: TerminalColsSchema, rows: TerminalRowsSchema }).strict();
const emptyBody = z.object({}).strict();
const readQuery = z.object({
  cursor: z.string().optional(),
  waitMs: z.coerce.number().int().min(0).optional()
});

/** The longest a read may park, bounded by the contract and by the API's runner request timeout. */
export function terminalWaitCapMs(requestTimeoutMs: number): number {
  return Math.max(0, Math.min(TERMINAL_MAX_WAIT_MS, requestTimeoutMs - LONG_POLL_HEADROOM_MS));
}

/**
 * Dashboard Terminal routes. The browser reaches a PTY only through these workspace-scoped routes, with
 * the same session principal, origin, and CSRF checks as every other dashboard mutation; it never talks to
 * the runner or Docker. Every runner input is rebuilt from validated path parameters and a strict body,
 * then parsed with the contract schema the runner itself enforces.
 */
export function registerDashboardTerminalRoutes(
  router: Router,
  runner: DashboardRunnerClient,
  principal: (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined,
  requestTimeoutMs: number
): void {
  const waitCapMs = terminalWaitCapMs(requestTimeoutMs);
  const workspaceOf = (request: DashboardRequest) => WorkspaceIdSchema.parse(request.params.workspaceId);
  const terminalOf = (request: DashboardRequest) => TerminalIdSchema.parse(request.params.terminalId);

  router.get('/api/v1/terminals', endpoint('terminal_list', () => TerminalListInputSchema.parse({})));
  router.get('/api/v1/workspaces/:workspaceId/terminals', endpoint('terminal_list', (request) => (
    TerminalListInputSchema.parse({ workspaceId: workspaceOf(request) })
  )));
  router.post('/api/v1/workspaces/:workspaceId/terminals', endpoint('terminal_open', (request) => (
    TerminalOpenInputSchema.parse({ ...openBody.parse(request.body ?? {}), workspaceId: workspaceOf(request) })
  )));
  router.post('/api/v1/workspaces/:workspaceId/terminals/:terminalId/input', endpoint('terminal_input', (request) => (
    TerminalInputInputSchema.parse({ ...inputBody.parse(request.body ?? {}), workspaceId: workspaceOf(request), terminalId: terminalOf(request) })
  )));
  router.post('/api/v1/workspaces/:workspaceId/terminals/:terminalId/resize', endpoint('terminal_resize', (request) => (
    TerminalResizeInputSchema.parse({ ...resizeBody.parse(request.body ?? {}), workspaceId: workspaceOf(request), terminalId: terminalOf(request) })
  )));
  router.post('/api/v1/workspaces/:workspaceId/terminals/:terminalId/close', endpoint('terminal_close', (request) => {
    emptyBody.parse(request.body ?? {});
    return TerminalCloseInputSchema.parse({ workspaceId: workspaceOf(request), terminalId: terminalOf(request) });
  }));

  // The long-poll read. A browser that navigates away or drops the connection aborts the runner request
  // too, so an abandoned read never keeps a runner wait (or an API socket) parked for the full window.
  router.get('/api/v1/workspaces/:workspaceId/terminals/:terminalId/output', async (request: DashboardRequest, response: Response, next: NextFunction) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const query = readQuery.parse(request.query);
      const input = TerminalReadInputSchema.parse({
        workspaceId: workspaceOf(request),
        terminalId: terminalOf(request),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        waitMs: Math.min(query.waitMs ?? 0, waitCapMs)
      });
      if (!runner.callInternal) { unavailable(response); return; }
      const disconnected = new AbortController();
      const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
      response.on('close', onClose);
      try {
        const result = await runner.callInternal('terminal_read', input, selected, disconnected.signal);
        if (disconnected.signal.aborted || response.headersSent) return;
        sendRunnerResponse(response, 'terminal_read', result);
      } finally {
        response.off('close', onClose);
      }
    } catch (error) { next(error); }
  });

  function endpoint(operation: TerminalOperation, build: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        const input = build(request);
        if (!runner.callInternal) { unavailable(response); return; }
        sendRunnerResponse(response, operation, await runner.callInternal(operation, input, selected));
      } catch (error) { next(error); }
    };
  }
}

function unavailable(response: Response): void {
  response.status(503).json({ error: 'terminal_unavailable', message: 'Terminals are temporarily unavailable.' });
}
