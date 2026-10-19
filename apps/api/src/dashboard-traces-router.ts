import type { NextFunction, Response, Router } from 'express';
import {
  AGENT_TRACE_RESULT_SCHEMAS,
  AgentTraceExportInputSchema,
  AgentTraceGetInputSchema,
  AgentTraceSpansInputSchema,
  AgentTracesListInputSchema,
  TraceIdSchema,
  type AgentTraceOperation,
  type RunnerPrincipalSelector,
  type RunnerResponse
} from '@cloud-harness/contracts';
import { z } from 'zod';
import type { DashboardRequest, DashboardRunnerClient } from './dashboard-types.js';

/** Query parameters the trace list accepts. Unknown parameters are refused rather than forwarded. */
const listQuery = z.object({
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  profileId: z.string().optional(),
  state: z.string().optional(),
  workflowId: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  includeSummary: z.enum(['true', 'false']).transform((value) => value === 'true').optional()
}).strict();
const spansQuery = z.object({
  kind: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().optional()
}).strict();
const exportQuery = z.object({ format: z.string().optional() }).strict();

const statuses: Record<string, number> = {
  INVALID_INPUT: 400, NOT_FOUND: 404, FORBIDDEN: 404, FEATURE_DISABLED: 409, TRACE_EXPIRED: 410,
  LIMIT_EXCEEDED: 429, TIMEOUT: 504, UNAVAILABLE: 503
};
const messages: Record<string, string> = {
  INVALID_INPUT: 'This trace page is out of date. Reload the list.',
  NOT_FOUND: 'Trace not found.',
  FORBIDDEN: 'Trace not found.',
  FEATURE_DISABLED: 'Agent traces are turned off on this server.',
  TRACE_EXPIRED: 'This trace passed its retention period and was removed.',
  LIMIT_EXCEEDED: 'Too many requests. Try again later.',
  TIMEOUT: 'The workspace service took too long to respond.',
  UNAVAILABLE: 'The workspace service is temporarily unavailable.'
};

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * Sends a runner trace response. Success data is re-parsed with the strict public result schema, so
 * only the documented trace fields reach the browser; anything else fails closed. Runner error text
 * never reaches the browser, only a fixed message per code.
 */
function send(response: Response, operation: AgentTraceOperation, result: RunnerResponse): z.infer<typeof AGENT_TRACE_RESULT_SCHEMAS[AgentTraceOperation]> | undefined {
  if (!result.ok) {
    const code = result.error?.code ?? 'INTERNAL_ERROR';
    response.status(statuses[code] ?? 500).json({
      error: code.toLowerCase(),
      message: messages[code] ?? 'The workspace service could not complete the request.'
    });
    return undefined;
  }
  const parsed = AGENT_TRACE_RESULT_SCHEMAS[operation].safeParse(result.data);
  if (!parsed.success) {
    response.status(502).json({ error: 'invalid_runner_response', message: 'The workspace service returned an unexpected trace.' });
    return undefined;
  }
  return parsed.data;
}

/**
 * Dashboard trace routes: read-only views over the caller's own agent traces. Every runner input is
 * rebuilt from a strict query and the public tool schema; the principal comes from the session only.
 */
export function registerDashboardTraceRoutes(
  router: Router,
  runner: DashboardRunnerClient,
  principal: (request: DashboardRequest, response: Response) => RunnerPrincipalSelector | undefined
): void {
  const traceOf = (request: DashboardRequest) => TraceIdSchema.parse(request.params.traceId);

  router.get('/api/v1/traces', endpoint('agent_traces_list', (request) => (
    AgentTracesListInputSchema.parse(withoutUndefined(listQuery.parse(request.query)))
  )));
  // Whether traces are recorded, without computing a summary: one bounded, indexed list read. A
  // disabled feature is an answer here, not an error.
  router.get('/api/v1/traces/status', async (request: DashboardRequest, response: Response, next: NextFunction) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const input = AgentTracesListInputSchema.parse({ limit: 1, includeSummary: false });
      const result = await runner.call('agent_traces_list', input, selected);
      if (!result.ok && result.error?.code === 'FEATURE_DISABLED') {
        response.json({ data: { enabled: false } });
        return;
      }
      if (send(response, 'agent_traces_list', result)) response.json({ data: { enabled: true } });
    } catch (error) { next(error); }
  });
  router.get('/api/v1/traces/:traceId', endpoint('agent_trace_get', (request) => (
    AgentTraceGetInputSchema.parse({ traceId: traceOf(request) })
  )));
  router.get('/api/v1/traces/:traceId/spans', endpoint('agent_trace_spans', (request) => (
    AgentTraceSpansInputSchema.parse({ ...withoutUndefined(spansQuery.parse(request.query)), traceId: traceOf(request) })
  )));

  // The export is a download: the bounded document is sent as an attachment with its own media type,
  // never rendered inline, so exported content cannot execute in the dashboard origin.
  router.get('/api/v1/traces/:traceId/export', async (request: DashboardRequest, response: Response, next: NextFunction) => {
    try {
      const selected = principal(request, response);
      if (!selected) return;
      const input = AgentTraceExportInputSchema.parse({ ...withoutUndefined(exportQuery.parse(request.query)), traceId: traceOf(request) });
      const data = send(response, 'agent_trace_export', await runner.call('agent_trace_export', input, selected)) as
        z.infer<typeof AGENT_TRACE_RESULT_SCHEMAS.agent_trace_export> | undefined;
      if (!data) return;
      response.setHeader('Content-Type', `${data.contentType}; charset=utf-8`);
      response.setHeader('Content-Disposition', `attachment; filename="${data.filename}"`);
      response.setHeader('X-Trace-Export-Truncated', data.truncated ? '1' : '0');
      response.send(data.content);
    } catch (error) { next(error); }
  });

  function endpoint(operation: Exclude<AgentTraceOperation, 'agent_trace_export'>, build: (request: DashboardRequest) => Record<string, unknown>) {
    return async (request: DashboardRequest, response: Response, next: NextFunction): Promise<void> => {
      try {
        const selected = principal(request, response);
        if (!selected) return;
        const input = build(request);
        const data = send(response, operation, await runner.call(operation, input, selected));
        if (data) response.json({ data });
      } catch (error) { next(error); }
    };
  }
}
