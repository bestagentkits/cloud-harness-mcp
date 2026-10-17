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

/** Provider-reported token counts are clamped here, so a hostile or buggy report cannot overflow cost math. */
export const MAX_REPORTED_TOKENS = 1_000_000_000;

/** A present field must be a non-negative integer; absent or null reads as undefined. */
function count(value: unknown): Field {
  if (value === undefined || value === null) return undefined;
  return Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, MAX_REPORTED_TOKENS) : INVALID;
}

/** The larger of two aliases, so a report carrying both never charges the smaller. */
function larger(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  return second === undefined ? first : Math.max(first, second);
}

function nested(container: Record<string, unknown>, detailsKey: string, key: string): Field {
  const details = container[detailsKey];
  if (details === undefined || details === null) return undefined;
  const detailsRecord = record(details);
  return detailsRecord === undefined ? INVALID : count(detailsRecord[key]);
}

/** True when the event carries a usage object, whether or not it is well formed. */
export function carriesUsage(event: unknown): boolean {
  return usageRecord(event) !== undefined;
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
    // Rounding at picodollars removes binary noise (0.1 * 1e6 = 100000.00000000001)
    // before rounding up to whole micros.
    providerCostMicros = Math.min(Math.ceil(Math.round(usage.cost * 1e12) / 1e6), Number.MAX_SAFE_INTEGER);
  }

  const anthropicNames = value.anthropicRead !== undefined || value.anthropicWrite !== undefined;
  const reportedPrompt = larger(value.promptTokens, value.inputTokens);
  const reportedOutput = larger(value.completionTokens, value.outputTokens);
  if (reportedPrompt === undefined || reportedOutput === undefined) return undefined;
  // DeepSeek reports `prompt_cache_hit_tokens` and may omit the OpenAI-style detail.
  const read = Math.max(larger(value.chatCached, value.responsesCached) ?? value.deepseekHit ?? 0, value.anthropicRead ?? 0);
  const write = Math.max(value.chatCacheWrite ?? 0, value.anthropicWrite ?? 0);
  const additive = split(reportedPrompt + read + write, reportedPrompt, read, write);
  let prompt: [PromptSplit, ...PromptSplit[]];
  if (anthropicNames && value.promptTokens === undefined) {
    // Anthropic's native names are additive: `input_tokens` excludes cache reads and writes.
    prompt = [additive];
  } else {
    const primary = inclusiveOrAdditive(reportedPrompt, read, write);
    // Anthropic cache names next to `prompt_tokens` may or may not be included in it.
    prompt = anthropicNames ? [primary, additive] : [primary];
  }

  const reasoningTokens = larger(value.chatReasoning, value.responsesReasoning) ?? 0;
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
