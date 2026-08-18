import { z } from 'zod';
import { AgentProxyOperationSchema } from './runner-api.js';

const token = z.string().min(32).max(512).refine((value) => !value.startsWith('change-me'), 'placeholder secret is forbidden');

const positiveBoundedInteger = (maximum: number, defaultValue: number) =>
  z.coerce.number().int().min(1).max(maximum).default(defaultValue);

const gatewayUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'http:'
    && url.hostname === 'model-gateway'
    && url.pathname === '/'
    && !url.username
    && !url.password
    && !url.search
    && !url.hash;
}, 'agent gateway URL must be the fixed internal http://model-gateway origin');

export const AgentModelProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  displayName: z.string().min(1).max(120),
  provider: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  inputMicrosPerMillionTokens: z.coerce.number().int().min(0).max(1_000_000_000),
  outputMicrosPerMillionTokens: z.coerce.number().int().min(0).max(1_000_000_000),
  maxInputTokens: z.coerce.number().int().min(1).max(2_000_000),
  maxOutputTokens: z.coerce.number().int().min(1).max(2_000_000),
  maxCostMicros: z.coerce.number().int().min(0).max(1_000_000_000),
  maxProxyOperations: z.array(AgentProxyOperationSchema)
    .min(1)
    .max(AgentProxyOperationSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, 'profile proxy operations must be unique')
}).strict();

export const RunnerAgentLimitsSchema = z.object({
  globalActive: positiveBoundedInteger(1_000, 16),
  principalActive: positiveBoundedInteger(1_000, 8),
  workspaceActive: positiveBoundedInteger(100, 4),
  parentActive: positiveBoundedInteger(100, 2),
  workspaceLifetimeRecords: positiveBoundedInteger(100_000, 1_000),
  minTtlSeconds: positiveBoundedInteger(3_600, 30),
  maxTtlSeconds: positiveBoundedInteger(86_400, 3_600),
  maxPromptBytes: positiveBoundedInteger(131_072, 131_072),
  maxMessageBytes: positiveBoundedInteger(65_536, 65_536),
  maxOutputBytesPerAgent: positiveBoundedInteger(10_485_760, 262_144),
  maxLogBytesPerAgent: positiveBoundedInteger(67_108_864, 4_194_304),
  maxLogEventsPerAgent: positiveBoundedInteger(100_000, 10_000),
  maxLogEventBytes: positiveBoundedInteger(65_536, 16_384),
  globalRetainedRows: positiveBoundedInteger(10_000_000, 100_000),
  principalRetainedRows: positiveBoundedInteger(1_000_000, 50_000),
  workspaceRetainedRows: positiveBoundedInteger(100_000, 10_000),
  globalRetainedBytes: positiveBoundedInteger(17_179_869_184, 1_073_741_824),
  principalRetainedBytes: positiveBoundedInteger(8_589_934_592, 536_870_912),
  workspaceRetainedBytes: positiveBoundedInteger(1_073_741_824, 134_217_728),
  cancellationGraceMs: positiveBoundedInteger(120_000, 10_000),
  cleanupRetryLimit: positiveBoundedInteger(1_000, 20),
  cleanupRetryMaxDelayMs: positiveBoundedInteger(86_400_000, 3_600_000),
  retentionSeconds: positiveBoundedInteger(31_536_000, 604_800),
  lookupHorizonSeconds: positiveBoundedInteger(31_536_000, 2_592_000)
}).strict().superRefine((limits, context) => {
  if (limits.minTtlSeconds > limits.maxTtlSeconds) {
    context.addIssue({ code: 'custom', path: ['minTtlSeconds'], message: 'minimum agent TTL cannot exceed maximum agent TTL' });
  }
  if (limits.workspaceActive > limits.principalActive || limits.principalActive > limits.globalActive) {
    context.addIssue({ code: 'custom', path: ['workspaceActive'], message: 'active limits must satisfy workspace <= principal <= global' });
  }
  if (limits.parentActive > limits.workspaceActive) {
    context.addIssue({ code: 'custom', path: ['parentActive'], message: 'parent active limit cannot exceed workspace active limit' });
  }
  if (limits.workspaceRetainedRows > limits.principalRetainedRows || limits.principalRetainedRows > limits.globalRetainedRows) {
    context.addIssue({ code: 'custom', path: ['workspaceRetainedRows'], message: 'retained row limits must satisfy workspace <= principal <= global' });
  }
  if (limits.workspaceRetainedBytes > limits.principalRetainedBytes || limits.principalRetainedBytes > limits.globalRetainedBytes) {
    context.addIssue({ code: 'custom', path: ['workspaceRetainedBytes'], message: 'retained byte limits must satisfy workspace <= principal <= global' });
  }
  if (limits.retentionSeconds > limits.lookupHorizonSeconds) {
    context.addIssue({ code: 'custom', path: ['retentionSeconds'], message: 'retention cannot exceed lookup horizon' });
  }
});

export const DEFAULT_RUNNER_AGENT_LIMITS = RunnerAgentLimitsSchema.parse({});

export const RunnerAgentsConfigSchema = z.object({
  image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/),
  networkMode: z.literal('none').default('none'),
  gatewayUrl,
  profiles: z.array(AgentModelProfileSchema).min(1).max(100).refine(
    (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
    'agent profile IDs must be unique'
  ),
  limits: RunnerAgentLimitsSchema.default(DEFAULT_RUNNER_AGENT_LIMITS)
}).strict();

export const ApiConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(3000),
  ownerId: z.string().min(1).max(100).default('owner'),
  bearerToken: token,
  runnerUrl: z.url(),
  runnerToken: token,
  publicHosts: z.array(z.string().min(1)).min(1),
  allowedOrigins: z.array(z.url()).default([]),
  requestTimeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  maxBodyBytes: z.coerce.number().int().min(1_024).max(4_194_304).default(1_048_576)
});

export const RunnerConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(3001),
  serviceToken: token,
  jobsRoot: z.string().min(1),
  stateDb: z.string().min(1),
  executorImage: z.string().min(1),
  allowedGitHosts: z.array(z.string().min(1)).min(1),
  networkMode: z.enum(['none', 'bridge']).default('none'),
  wallTtlSeconds: z.coerce.number().int().min(60).max(86_400).default(900),
  idleTtlSeconds: z.coerce.number().int().min(30).max(43_200).default(300),
  maxOutputBytes: z.coerce.number().int().min(1_024).max(10_485_760).default(262_144),
  minFreeBytes: z.coerce.number().int().min(104_857_600).default(2_147_483_648),
  maxWorkspaceBytes: z.coerce.number().int().min(104_857_600).default(2_147_483_648),
  reaperIntervalSeconds: z.coerce.number().int().min(10).max(3_600).default(30),
  githubApp: z.object({
    appId: z.coerce.number().int().positive(),
    installationId: z.coerce.number().int().positive(),
    privateKey: z.string().includes('PRIVATE KEY').max(32_768)
  }).optional(),
  agents: RunnerAgentsConfigSchema.optional()
}).strict();

export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
export type AgentModelProfile = z.infer<typeof AgentModelProfileSchema>;
export type RunnerAgentLimits = z.infer<typeof RunnerAgentLimitsSchema>;
export type RunnerAgentsConfig = z.infer<typeof RunnerAgentsConfigSchema>;
