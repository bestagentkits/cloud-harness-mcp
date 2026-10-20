import { GatewayConnection, type ChatStreamEvent, type GatewayCredentials } from 'dewee-webchat/server';

/**
 * One chat turn against the Dewee gateway WebSocket (protocol v3), owned here rather than by
 * the package's `streamChat` for three reasons:
 * - A client that disconnects before the gateway connection opens still closes it at once.
 * - Gateway and run error text is replaced by fixed messages, so nothing the gateway echoes
 *   (a token, a stack, a prompt) reaches the browser.
 * - The whole run is bounded by one deadline, not only the `chat.send` reply.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const ABORT_TIMEOUT_MS = 3_000;
const MAX_TOOL_PAYLOAD_CHARS = 4_000;

export type DeweeChatOptions = {
  creds: GatewayCredentials;
  userId: string;
  agent: string;
  sessionKey: string;
  message: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Receives the gateway's own error (connect or `chat.send`) for logging; the stream gets a fixed message. */
  onGatewayFailure?: (error: unknown) => void;
};

const gatewayError = (): ChatStreamEvent => ({ type: 'error', message: 'The Dewee gateway request failed.', code: 'gateway_error' });

function clip(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TOOL_PAYLOAD_CHARS ? `${text.slice(0, MAX_TOOL_PAYLOAD_CHARS)}…` : text;
}

/** Maps one gateway `agent` event to a widget stream event; undefined skips it. */
function mapAgentEvent(type: unknown, payload: Record<string, unknown>): ChatStreamEvent | undefined {
  switch (type) {
    case 'thinking': return typeof payload.content === 'string' && payload.content ? { type: 'thinking', text: payload.content } : undefined;
    case 'chunk': return typeof payload.content === 'string' && payload.content ? { type: 'delta', text: payload.content } : undefined;
    case 'tool.call': {
      // Small arguments keep their shape for the widget; oversized ones become a clipped string.
      const clipped = clip(payload.arguments);
      const args = clipped !== undefined && clipped.length > MAX_TOOL_PAYLOAD_CHARS ? clipped : payload.arguments;
      return { type: 'tool_call', id: String(payload.id ?? ''), name: String(payload.name || 'tool'), ...(args === undefined || args === null ? {} : { arguments: args }) };
    }
    case 'tool.result': {
      const result = clip(payload.result ?? payload.content);
      return { type: 'tool_result', id: String(payload.id ?? ''), name: String(payload.name || 'tool'), isError: Boolean(payload.is_error), ...(result === undefined ? {} : { result }) };
    }
    case 'run.failed': return { type: 'error', message: 'The agent run failed.', code: 'run_failed' };
    case 'run.cancelled': return { type: 'error', message: 'The agent run was cancelled.', code: 'cancelled' };
    default: return undefined;
  }
}

/** Yields the turn's stream events until it ends, fails, times out or the signal aborts. */
export async function* runDeweeChat(options: DeweeChatOptions): AsyncGenerator<ChatStreamEvent> {
  if (options.signal.aborted) return;
  let connection: GatewayConnection;
  try {
    connection = await GatewayConnection.connect(options.creds, options.userId, CONNECT_TIMEOUT_MS);
  } catch (error) {
    options.onGatewayFailure?.(error);
    yield gatewayError();
    return;
  }
  if (options.signal.aborted) { connection.close(); return; }

  const queue: ChatStreamEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const push = (event: ChatStreamEvent) => { if (!finished) { queue.push(event); wake?.(); } };
  const end = () => { finished = true; wake?.(); };
  const abortRun = () => {
    connection.call('chat.abort', { sessionKey: options.sessionKey }, ABORT_TIMEOUT_MS).catch(() => undefined).finally(() => connection.close());
  };

  const off = connection.onEvent((event, payload) => {
    if (event !== 'agent' || !payload || typeof payload !== 'object') return;
    // The connection is per turn, but an event that names no session cannot be attributed to
    // this one, so it is dropped rather than forwarded.
    const key = payload.visibleSessionKey || payload.sessionKey;
    if (!key || (key !== options.sessionKey && payload.runSessionKey !== options.sessionKey)) return;
    const mapped = mapAgentEvent(payload.type, payload.payload && typeof payload.payload === 'object' ? payload.payload : {});
    if (!mapped) return;
    push(mapped);
    if (mapped.type === 'error') end();
  });
  const onAbort = () => { abortRun(); end(); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => {
    push({ type: 'error', message: 'The agent run timed out.', code: 'timeout' });
    abortRun();
    end();
  }, options.timeoutMs);

  connection.call<{ content?: unknown; usage?: unknown }>('chat.send', {
    agentId: options.agent, sessionKey: options.sessionKey, message: options.message, stream: true
  }, options.timeoutMs).then((result) => {
    push({ type: 'done', content: typeof result?.content === 'string' ? result.content : '', ...(result?.usage && typeof result.usage === 'object' ? { usage: result.usage as Record<string, number> } : {}) });
    end();
  }).catch((error: unknown) => {
    options.onGatewayFailure?.(error);
    push(gatewayError());
    end();
  });

  try {
    while (true) {
      const next = queue.shift();
      if (next) { yield next; continue; }
      if (finished) break;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  } finally {
    clearTimeout(deadline);
    off();
    options.signal.removeEventListener('abort', onAbort);
    connection.close();
  }
}
