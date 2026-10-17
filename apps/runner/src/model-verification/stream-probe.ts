import type { AgentModelApiMode, ModelVerificationUsage } from '@cloud-harness/contracts';

// Reads a provider's streamed answer line by line and records only what the
// check needs: whether events of the expected protocol family arrived, whether
// the stream finished, token usage, and any in-stream error. Content is not kept.

export interface StreamProbeState {
  jsonEvents: number;
  protocolEvents: number;
  foreignEvents: number;
  completed: boolean;
  usage?: ModelVerificationUsage;
  streamError?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Usage in either the chat (`prompt_tokens`) or responses (`input_tokens`) shape. */
export function usageFrom(value: unknown): ModelVerificationUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || (input as number) < 0 || (output as number) < 0) return undefined;
  return { inputTokens: input as number, outputTokens: output as number };
}

function errorText(value: unknown): string {
  const record = asRecord(value);
  if (typeof value === 'string') return value;
  if (record && typeof record.message === 'string') return record.message;
  return 'the provider reported an error in the stream';
}

function isChatChunk(event: Record<string, unknown>): boolean {
  return Array.isArray(event.choices) && event.choices.some((choice) => asRecord(asRecord(choice)?.delta) !== undefined);
}

function applyChatEvent(state: StreamProbeState, event: Record<string, unknown>): void {
  if (event.error !== undefined) {
    state.streamError = errorText(event.error);
    return;
  }
  const usage = usageFrom(event.usage);
  if (usage) state.usage = usage;
  if (isChatChunk(event)) {
    state.protocolEvents += 1;
    const choices = event.choices as unknown[];
    if (choices.some((choice) => typeof asRecord(choice)?.finish_reason === 'string')) state.completed = true;
  } else if (typeof event.type === 'string' && event.type.startsWith('response.')) {
    state.foreignEvents += 1;
  }
  if (usage) state.completed = true;
}

function applyResponsesEvent(state: StreamProbeState, event: Record<string, unknown>): void {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'error' || (event.error !== undefined && !type.startsWith('response.'))) {
    state.streamError = errorText(event.error ?? event);
    return;
  }
  if (!type.startsWith('response.')) {
    if (isChatChunk(event)) state.foreignEvents += 1;
    return;
  }
  state.protocolEvents += 1;
  const response = asRecord(event.response);
  if (type === 'response.failed') {
    state.streamError = errorText(response?.error);
    return;
  }
  // `incomplete` is the expected end when the tiny output cap is reached.
  if (type === 'response.completed' || type === 'response.incomplete') {
    state.completed = true;
    const usage = usageFrom(response?.usage);
    if (usage) state.usage = usage;
  }
}

export function createStreamProbe(apiMode: AgentModelApiMode): { state: StreamProbeState; onLine: (line: string) => boolean } {
  const state: StreamProbeState = { jsonEvents: 0, protocolEvents: 0, foreignEvents: 0, completed: false };
  const onLine = (line: string): boolean => {
    if (!line.startsWith('data:')) return true;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      state.completed = true;
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return true;
    }
    const event = asRecord(parsed);
    if (!event) return true;
    state.jsonEvents += 1;
    if (apiMode === 'chat-completions') applyChatEvent(state, event);
    else applyResponsesEvent(state, event);
    // Stop once the answer is complete and usage is known, or the stream reported an error.
    if (state.streamError !== undefined) return false;
    return !(state.completed && (state.usage !== undefined || apiMode === 'responses'));
  };
  return { state, onLine };
}

/**
 * A provider that ignores `stream: true` answers with one JSON document. It still proves the
 * protocol, but not streaming.
 */
export function parseNonStreamedAnswer(apiMode: AgentModelApiMode, body: string): { matches: boolean; usage?: ModelVerificationUsage } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { matches: false };
  }
  const document = asRecord(parsed);
  if (!document) return { matches: false };
  const usage = usageFrom(document.usage);
  const matches = apiMode === 'chat-completions'
    ? Array.isArray(document.choices) && document.choices.some((choice) => asRecord(asRecord(choice)?.message) !== undefined)
    : document.object === 'response' || Array.isArray(document.output);
  return usage ? { matches, usage } : { matches };
}

/** Whether a non-streamed tool-call answer called the named function. */
export function calledTool(apiMode: AgentModelApiMode, body: string, name: string): { called: boolean; usage?: ModelVerificationUsage; parsed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { called: false, parsed: false };
  }
  const document = asRecord(parsed);
  if (!document) return { called: false, parsed: false };
  const usage = usageFrom(document.usage);
  let called = false;
  if (apiMode === 'chat-completions') {
    const choices = Array.isArray(document.choices) ? document.choices : [];
    called = choices.some((choice) => {
      const calls = asRecord(asRecord(choice)?.message)?.tool_calls;
      return Array.isArray(calls) && calls.some((call) => asRecord(asRecord(call)?.function)?.name === name);
    });
  } else {
    const output = Array.isArray(document.output) ? document.output : [];
    called = output.some((item) => asRecord(item)?.type === 'function_call' && asRecord(item)?.name === name);
  }
  return usage ? { called, usage, parsed: true } : { called, parsed: true };
}
