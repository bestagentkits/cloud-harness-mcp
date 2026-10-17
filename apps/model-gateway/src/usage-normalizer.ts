/**
 * Normalises the token usage that OpenAI-compatible providers report into one
 * shape the budget can price. Providers disagree on whether cache reads and
 * writes are included in the prompt total, and some report reasoning outside
 * the output total, so every ambiguity is resolved toward the larger charge.
 */

/** One reading of how the prompt total splits into uncached, cache-read and cache-write tokens. */
export interface PromptSplit {
  promptTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface NormalizedUsage {
  /** Every plausible prompt interpretation; the caller charges the most expensive one. */
  prompt: readonly [PromptSplit, ...PromptSplit[]];
  /** Output total, including reasoning tokens. */
  outputTokens: number;
  reasoningTokens: number;
  /** Provider-reported cost (OpenRouter `usage.cost`), used only as a floor. */
  providerCostMicros?: number;
}

const INVALID = Symbol('invalid usage field');
type Field = number | undefined | typeof INVALID;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A present field must be a non-negative safe integer; absent or null reads as undefined. */
function count(value: unknown): Field {
  if (value === undefined || value === null) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : INVALID;
}

function nested(container: Record<string, unknown>, detailsKey: string, key: string): Field {
  const details = container[detailsKey];
  if (details === undefined || details === null) return undefined;
  const detailsRecord = record(details);
  return detailsRecord === undefined ? INVALID : count(detailsRecord[key]);
}

/** Top-level `usage` (chat chunks, JSON bodies) or `response.usage` (Responses stream events). */
function usageRecord(event: unknown): Record<string, unknown> | undefined {
  const root = record(event);
  if (root === undefined) return undefined;
  return record(root.usage) ?? record(record(root.response)?.usage);
}

function split(promptTokens: number, uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): PromptSplit {
  return { promptTokens, uncachedInputTokens, cacheReadTokens, cacheWriteTokens };
}

/** Cache tokens are part of the reported prompt total, unless that would be inconsistent. */
function inclusiveOrAdditive(prompt: number, read: number, write: number): PromptSplit {
  return read + write <= prompt
    ? split(prompt, prompt - read - write, read, write)
    : split(prompt + read + write, prompt, read, write);
}

/** Returns undefined when the event carries no usable usage; the request then settles at its reservation. */
export function normalizeProviderUsage(event: unknown): NormalizedUsage | undefined {
  const usage = usageRecord(event);
  if (usage === undefined) return undefined;

  const fields = {
    promptTokens: count(usage.prompt_tokens),
    inputTokens: count(usage.input_tokens),
    completionTokens: count(usage.completion_tokens),
    outputTokens: count(usage.output_tokens),
    totalTokens: count(usage.total_tokens),
    chatCached: nested(usage, 'prompt_tokens_details', 'cached_tokens'),
    chatCacheWrite: nested(usage, 'prompt_tokens_details', 'cache_write_tokens'),
    deepseekHit: count(usage.prompt_cache_hit_tokens),
    responsesCached: nested(usage, 'input_tokens_details', 'cached_tokens'),
    anthropicRead: count(usage.cache_read_input_tokens),
    anthropicWrite: count(usage.cache_creation_input_tokens),
    chatReasoning: nested(usage, 'completion_tokens_details', 'reasoning_tokens'),
    responsesReasoning: nested(usage, 'output_tokens_details', 'reasoning_tokens')
  };
  if (Object.values(fields).some((value) => value === INVALID)) return undefined;
  const value = fields as { [K in keyof typeof fields]: number | undefined };

  let providerCostMicros: number | undefined;
  if (usage.cost !== undefined && usage.cost !== null) {
    if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0) return undefined;
    // The epsilon absorbs binary floating-point noise (0.1 * 1e6 = 100000.00000000001).
    providerCostMicros = Math.max(0, Math.ceil(usage.cost * 1_000_000 - 1e-6));
    if (!Number.isSafeInteger(providerCostMicros)) return undefined;
  }

  const anthropicNames = value.anthropicRead !== undefined || value.anthropicWrite !== undefined;
  const anthropicRead = value.anthropicRead ?? 0;
  const anthropicWrite = value.anthropicWrite ?? 0;
  let reportedPrompt: number;
  let prompt: [PromptSplit, ...PromptSplit[]];
  if (value.promptTokens !== undefined) {
    reportedPrompt = value.promptTokens;
    // DeepSeek reports `prompt_cache_hit_tokens` and may omit the OpenAI-style detail.
    const read = Math.max(value.chatCached ?? value.deepseekHit ?? 0, anthropicRead);
    const write = Math.max(value.chatCacheWrite ?? 0, anthropicWrite);
    const primary = inclusiveOrAdditive(reportedPrompt, read, write);
    // Anthropic cache names next to `prompt_tokens` may or may not be included in it.
    prompt = anthropicNames ? [primary, split(reportedPrompt + read + write, reportedPrompt, read, write)] : [primary];
  } else if (value.inputTokens !== undefined) {
    reportedPrompt = value.inputTokens;
    prompt = anthropicNames
      // Anthropic's native names are additive: `input_tokens` excludes cache reads and writes.
      ? [split(reportedPrompt + anthropicRead + anthropicWrite, reportedPrompt, anthropicRead, anthropicWrite)]
      : [inclusiveOrAdditive(reportedPrompt, value.responsesCached ?? 0, 0)];
  } else {
    return undefined;
  }

  const reportedOutput = value.completionTokens ?? value.outputTokens;
  if (reportedOutput === undefined) return undefined;
  const reasoningTokens = value.chatReasoning ?? value.responsesReasoning ?? 0;
  // Reasoning larger than the output total can only have been reported separately from it.
  let outputTokens = reasoningTokens > reportedOutput ? reportedOutput + reasoningTokens : reportedOutput;
  if (value.totalTokens !== undefined) outputTokens = Math.max(outputTokens, value.totalTokens - reportedPrompt);

  return {
    prompt,
    outputTokens,
    reasoningTokens,
    ...(providerCostMicros === undefined ? {} : { providerCostMicros })
  };
}
