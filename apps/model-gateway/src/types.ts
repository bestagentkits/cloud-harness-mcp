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
  limits: ProfileLimits;
  testOnly: boolean;
  allowPrivateUpstream: boolean;
  tlsCaFile?: string | undefined;
}

export interface GatewayConfig {
  mode: GatewayMode;
  host: string;
  port: number;
  controlSocket: string;
  profiles: ReadonlyMap<string, GatewayProfile>;
}

export interface LeaseGrant {
  agentId: string;
  profileId: string;
  expiresAt: number;
  remainingInputTokens: number;
  remainingOutputTokens: number;
  remainingCostMicros: number;
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
  inputTokens: number;
  outputTokens: number;
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
