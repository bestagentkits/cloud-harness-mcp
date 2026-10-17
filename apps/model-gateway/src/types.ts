export type GatewayMode = 'production' | 'test';

export interface ProfileLimits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxHeaderBytes: number;
  maxHeaders: number;
  deadlineMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  maxStreamLineBytes: number;
}

export interface GatewayProfile {
  id: string;
  provider: string;
  model: string;
  downstreamPath: '/v1/chat/completions' | '/v1/responses';
  upstream: URL;
  credentialFile: string;
  credentialSecret?: string | undefined;
  credentialHeader: 'authorization' | 'x-api-key';
  credentialScheme: '' | 'Bearer';
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  /** Price of prompt tokens served from the provider cache; absent means the input price. */
  cacheReadMicrosPerMillionTokens?: number | undefined;
  /** Price of prompt tokens written to the provider cache; absent means the input price. */
  cacheWriteMicrosPerMillionTokens?: number | undefined;
  /**
   * Long-context price tiers, ascending by `minPromptTokens`. A tier applies when
   * the prompt total reaches its threshold; below the first tier the base prices
   * apply. Prices never fall from one tier to the next.
   */
  tiers?: readonly PriceTier[] | undefined;
  limits: ProfileLimits;
  testOnly: boolean;
  allowPrivateUpstream: boolean;
  tlsCaFile?: string | undefined;
}

export interface TokenPrices {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  cacheReadMicrosPerMillionTokens: number;
  cacheWriteMicrosPerMillionTokens: number;
}

export interface PriceTier extends TokenPrices {
  minPromptTokens: number;
}

export interface GatewayConfig {
  mode: GatewayMode;
  host: string;
  port: number;
  controlSocket: string;
  profiles: ReadonlyMap<string, GatewayProfile>;
  tlsCaFile?: string | undefined;
  /**
   * Optional provider session header. Some OpenAI-compatible providers reject a
   * request that carries no stable conversation identifier (OpenCode Go returns
   * `400 MissingSessionID` without `x-opencode-session`). When set, the gateway
   * sends this header with the calling agent's id, which is stable for one agent
   * conversation, and always identifies itself through `user-agent`.
   */
  sessionHeader?: string | undefined;
}

/** Running totals for one lease, kept so a revoked or expired lease can be settled. */
export interface LeaseAccounting {
  initialInputTokens: number;
  initialOutputTokens: number;
  initialCostMicros: number;
  /** Every micro charged beyond a request's reservation. */
  overrunCostMicros: number;
  /** The part of the overrun that the lease's remaining budget could not absorb. */
  unabsorbedOverrunCostMicros: number;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
  requestsWithoutUsage: number;
}

export interface LeaseGrant {
  agentId: string;
  profileId: string;
  expiresAt: number;
  remainingInputTokens: number;
  remainingOutputTokens: number;
  remainingCostMicros: number;
  accounting: LeaseAccounting;
}

/**
 * What a lease consumed, reported when it is revoked or expires. `costMicros`
 * counts failed and still-running requests at their reservation and adds any
 * overrun the remaining budget could not absorb.
 */
export interface LeaseSettlement {
  leaseId: string;
  reason: 'revoked' | 'expired';
  settledAt: number;
  initialInputTokens: number;
  initialOutputTokens: number;
  initialCostMicros: number;
  costMicros: number;
  overrunCostMicros: number;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  requests: number;
  requestsWithoutUsage: number;
}

export interface LeaseIssueInput {
  leaseId: string;
  agentId: string;
  profileId: string;
  ttlMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
}

export interface Usage {
  /** Prompt total, including tokens read from or written to the provider cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Output total, including reasoning tokens. */
  outputTokens: number;
  reasoningTokens: number;
  costMicros: number;
}

export interface BudgetReservation {
  lease: LeaseGrant;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface GatewayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
