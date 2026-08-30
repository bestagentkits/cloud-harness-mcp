import type { BudgetReservation, GatewayProfile, LeaseGrant, Usage } from './types.js';

export interface BudgetHooks {
  reserve(reservation: BudgetReservation): void | Promise<void>;
  reconcile(reservation: BudgetReservation, actual: Usage): void | Promise<void>;
}

export const noOpBudgetHooks: BudgetHooks = {
  reserve: () => undefined,
  reconcile: () => undefined
};

function costMicros(tokens: number, pricePerMillion: number): number {
  const numerator = BigInt(tokens) * BigInt(pricePerMillion);
  return Number((numerator + 999_999n) / 1_000_000n);
}

function requestedOutputTokens(body: Record<string, unknown>, profile: GatewayProfile): number {
  const fields = profile.downstreamPath === '/v1/responses'
    ? ['max_output_tokens']
    : ['max_tokens', 'max_completion_tokens'];
  const requested: number[] = [];
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
    requested.push(value as number);
  }
  delete body.max_completion_tokens;
  return requested.length === 0 ? profile.limits.maxOutputTokens : Math.min(...requested);
}

export function reserveBudget(
  body: Record<string, unknown>,
  bodyBytes: number,
  lease: LeaseGrant,
  profile: GatewayProfile
): BudgetReservation {
  const estimatedInputTokens = Math.max(1, bodyBytes);
  const inputTokens = Math.min(estimatedInputTokens, lease.remainingInputTokens, profile.limits.maxInputTokens);
  if (estimatedInputTokens > inputTokens) throw new Error('input token budget exceeded');
  const inputCost = costMicros(inputTokens, profile.inputMicrosPerMillionTokens);
  if (inputCost > lease.remainingCostMicros) throw new Error('input cost budget exceeded');
  const requested = Math.min(requestedOutputTokens(body, profile), lease.remainingOutputTokens, profile.limits.maxOutputTokens);
  let affordableOutput = requested;
  if (profile.outputMicrosPerMillionTokens !== 0) {
    const affordable = BigInt(lease.remainingCostMicros - inputCost) * 1_000_000n / BigInt(profile.outputMicrosPerMillionTokens);
    affordableOutput = Number(affordable > BigInt(requested) ? BigInt(requested) : affordable);
  }
  const outputTokens = Math.min(requested, affordableOutput);
  if (outputTokens < 1) throw new Error('output cost budget exhausted');
  const field = profile.downstreamPath === '/v1/responses' ? 'max_output_tokens' : 'max_tokens';
  body[field] = outputTokens;
  body.model = profile.model;
  body.stream = true;
  if (profile.downstreamPath === '/v1/chat/completions') {
    body.stream_options = { include_usage: true };
  }
  const reservation: BudgetReservation = {
    lease,
    inputTokens,
    outputTokens,
    costMicros: inputCost + costMicros(outputTokens, profile.outputMicrosPerMillionTokens)
  };
  lease.remainingInputTokens -= reservation.inputTokens;
  lease.remainingOutputTokens -= reservation.outputTokens;
  lease.remainingCostMicros -= reservation.costMicros;
  return reservation;
}

export function reconcileBudget(reservation: BudgetReservation, actual: Usage | undefined): Usage {
  const usage = actual === undefined
    ? {
        inputTokens: reservation.inputTokens,
        outputTokens: reservation.outputTokens,
        costMicros: reservation.costMicros
      }
    : {
        inputTokens: Math.min(actual.inputTokens, reservation.inputTokens),
        outputTokens: Math.min(actual.outputTokens, reservation.outputTokens),
        costMicros: Math.min(actual.costMicros, reservation.costMicros)
      };
  reservation.lease.remainingInputTokens += reservation.inputTokens - usage.inputTokens;
  reservation.lease.remainingOutputTokens += reservation.outputTokens - usage.outputTokens;
  reservation.lease.remainingCostMicros += reservation.costMicros - usage.costMicros;
  return usage;
}

export function usageFromProvider(value: unknown, profile: GatewayProfile): Usage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const input = usageRecord.input_tokens ?? usageRecord.prompt_tokens;
  const output = usageRecord.output_tokens ?? usageRecord.completion_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || (input as number) < 0 || (output as number) < 0) return undefined;
  const inputTokens = input as number;
  const outputTokens = output as number;
  return {
    inputTokens,
    outputTokens,
    costMicros: costMicros(inputTokens, profile.inputMicrosPerMillionTokens) + costMicros(outputTokens, profile.outputMicrosPerMillionTokens)
  };
}
