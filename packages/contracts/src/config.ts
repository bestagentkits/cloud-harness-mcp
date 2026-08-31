import { z } from 'zod';
import { ExecutorNetworkProfileSchema } from './identifiers.js';
import { AgentProxyOperationSchema } from './runner-api.js';
const token = z.string().min(32).max(512).refine((value) => !value.startsWith('change-me'), 'placeholder secret is forbidden');

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS URL required');
const enabled = z.preprocess((value) => value === true || value === 'true', z.boolean()).default(false);

const principalRelink = z.object({
  oldIssuer: httpsUrl,
  oldSubject: z.string().min(1).max(512),
  newIssuer: httpsUrl,
  newSubject: z.string().min(1).max(512)
}).strict().refine(
  (mapping) => mapping.oldIssuer !== mapping.newIssuer || mapping.oldSubject !== mapping.newSubject,
  'principal relink source and target must differ'
);

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
  authMode: z.enum(['owner-bearer', 'cloudflare-access']).optional(),
  ownerId: z.string().min(1).max(100).default('owner'),
  bearerToken: token.optional(),
  accessIssuer: httpsUrl.optional(),
  accessAudience: z.string().min(1).max(512).optional(),
  accessJwksUrl: httpsUrl.optional(),
  apiKeyAuthEnabled: enabled,
  apiKeyGatewayAccessAudience: z.string().min(1).max(512).optional(),
  apiKeyGatewayServiceSubject: z.string().regex(/^cf-service:[A-Za-z0-9_-]+$/).max(512).optional(),
  apiKeyGatewayPublicUrl: httpsUrl.optional(),
  runnerUrl: z.url(),
  runnerToken: token,
  publicHosts: z.array(z.string().min(1)).min(1),
  allowedOrigins: z.array(z.url()).default([]),
  requestTimeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  maxBodyBytes: z.coerce.number().int().min(1_024).max(4_194_304).default(1_048_576)
}).superRefine((config, context) => {
  const mode = config.authMode ?? 'owner-bearer';
  const accessValues = [config.accessIssuer, config.accessAudience, config.accessJwksUrl];
  const apiKeyValues = [config.apiKeyGatewayAccessAudience, config.apiKeyGatewayServiceSubject, config.apiKeyGatewayPublicUrl];
  if (mode === 'owner-bearer') {
    if (!config.bearerToken) context.addIssue({ code: 'custom', path: ['bearerToken'], message: 'bearer token is required in owner-bearer mode' });
    if (accessValues.some((value) => value !== undefined)) context.addIssue({ code: 'custom', path: ['authMode'], message: 'Cloudflare Access settings are forbidden in owner-bearer mode' });
    if (config.apiKeyAuthEnabled || apiKeyValues.some((value) => value !== undefined)) context.addIssue({ code: 'custom', path: ['apiKeyAuthEnabled'], message: 'API key gateway is only valid in cloudflare-access mode' });
    return;
  }
  if (config.bearerToken) context.addIssue({ code: 'custom', path: ['bearerToken'], message: 'owner bearer token is forbidden in cloudflare-access mode' });
  for (const [path, value] of [
    ['accessIssuer', config.accessIssuer],
    ['accessAudience', config.accessAudience],
    ['accessJwksUrl', config.accessJwksUrl]
  ] as const) {
    if (!value) context.addIssue({ code: 'custom', path: [path], message: `${path} is required in cloudflare-access mode` });
  }
  if (config.apiKeyAuthEnabled) {
    for (const [path, value] of [
      ['apiKeyGatewayAccessAudience', config.apiKeyGatewayAccessAudience],
      ['apiKeyGatewayServiceSubject', config.apiKeyGatewayServiceSubject],
      ['apiKeyGatewayPublicUrl', config.apiKeyGatewayPublicUrl]
    ] as const) {
      if (!value) context.addIssue({ code: 'custom', path: [path], message: `${path} is required when API key authentication is enabled` });
    }
    if (config.apiKeyGatewayAccessAudience === config.accessAudience) {
      context.addIssue({ code: 'custom', path: ['apiKeyGatewayAccessAudience'], message: 'API key gateway audience must differ from the main Access audience' });
    }
  } else if (apiKeyValues.some((value) => value !== undefined)) {
    context.addIssue({ code: 'custom', path: ['apiKeyAuthEnabled'], message: 'API key gateway settings require API key authentication to be enabled' });
  }
});

export const SecretKeyringConfigSchema = z.object({
  activeVersion: z.number().int().positive(),
  keys: z.array(z.object({ version: z.number().int().positive(), key: z.string().min(43).max(64) }).strict()).min(1)
}).strict();

export const RunnerConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(3001),
  authMode: z.enum(['owner-bearer', 'cloudflare-access']).optional(),
  serviceToken: token,
  jobsRoot: z.string().min(1),
  stateDb: z.string().min(1),
  executorImage: z.string().min(1),
  networkGuardImage: z.string().min(1).default('cloud-harness-network-guard:local'),
  allowedGitHosts: z.array(z.string().min(1)).min(1),
  networkProfile: ExecutorNetworkProfileSchema.default('network-none'),
  dependencyDnsResolvers: z.array(z.string().regex(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)).min(1).default(['8.8.8.8', '1.1.1.1']),
  dependencyBridgeSubnet: z.string().default('172.30.240.0/24'),
  dependencyBridgeInterface: z.string().default('chm-egress0'),
  dependencyNetworkName: z.string().default('cloud-harness-dependency-access'),
  wallTtlSeconds: z.coerce.number().int().min(60).max(86_400).default(900),
  idleTtlSeconds: z.coerce.number().int().min(30).max(43_200).default(300),
  maxOutputBytes: z.coerce.number().int().min(1_024).max(10_485_760).default(262_144),
  minFreeBytes: z.coerce.number().int().min(104_857_600).default(2_147_483_648),
  maxWorkspaceBytes: z.coerce.number().int().min(104_857_600).default(2_147_483_648),
  reaperIntervalSeconds: z.coerce.number().int().min(10).max(3_600).default(30),
  artifactRoot: z.string().min(1).default('/var/lib/cloud-harness/artifacts'),
  maxArtifactBytes: z.coerce.number().int().min(1_024).max(268_435_456).default(16_777_216),
  maxPrincipalArtifactBytes: z.coerce.number().int().min(1_024).max(2_147_483_648).default(134_217_728),
  artifactRetentionSeconds: z.coerce.number().int().min(60).max(2_592_000).default(86_400),
  enableRepoCache: enabled.default(false),
  repoCacheRoot: z.string().min(1).default('/var/lib/cloud-harness/cache/repos'),
  enableToolkitCache: enabled.default(true),
  toolkitCacheRoot: z.string().min(1).default('/var/lib/cloud-harness/cache/toolkits'),
  toolkitNetworkPolicy: z.enum(['cache-only', 'runner-fetch']).default('cache-only'),
  toolkitEgressProxy: z.string().min(1).optional(),
  provisioningNetwork: z.string().min(1).default('cloud-harness-mcp_provisioning'),
  secretKeyring: SecretKeyringConfigSchema.optional(),
  legacyPrincipalMapping: z.object({
    legacyOwnerId: z.string().min(1).max(100),
    issuer: httpsUrl,
    subject: z.string().min(1).max(512)
  }).strict().optional(),
  principalRelinks: z.array(principalRelink).max(100).optional(),
  githubApp: z.object({
    appId: z.coerce.number().int().positive(),
    installationId: z.coerce.number().int().positive().optional(),
    privateKey: z.string().includes('PRIVATE KEY').max(32_768),
    appSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/).optional()
  }).optional(),
  agents: RunnerAgentsConfigSchema.optional()
}).superRefine((config, context) => {
  const mode = config.authMode ?? 'owner-bearer';
  if (mode === 'owner-bearer' && config.legacyPrincipalMapping) {
    context.addIssue({ code: 'custom', path: ['legacyPrincipalMapping'], message: 'legacy principal mapping is only valid in cloudflare-access mode' });
  }
  if (mode === 'owner-bearer' && config.principalRelinks !== undefined) {
    context.addIssue({ code: 'custom', path: ['principalRelinks'], message: 'principal relinks are only valid in cloudflare-access mode' });
  }
  const relinkSources = new Set<string>();
  for (const [index, mapping] of (config.principalRelinks ?? []).entries()) {
    const key = JSON.stringify([mapping.oldIssuer, mapping.oldSubject]);
    if (relinkSources.has(key)) {
      context.addIssue({ code: 'custom', path: ['principalRelinks', index], message: 'principal relink sources must be unique' });
    }
    relinkSources.add(key);
  }
  if (mode === 'owner-bearer' && config.githubApp && !config.githubApp.installationId) {
    context.addIssue({ code: 'custom', path: ['githubApp', 'installationId'], message: 'GitHub App installation ID is required in owner-bearer mode' });
  }
  if (mode === 'cloudflare-access' && config.githubApp && !config.githubApp.appSlug) {
    context.addIssue({ code: 'custom', path: ['githubApp', 'appSlug'], message: 'GitHub App slug is required in cloudflare-access mode' });
  }
  if (config.maxArtifactBytes > config.maxPrincipalArtifactBytes) {
    context.addIssue({ code: 'custom', path: ['maxArtifactBytes'], message: 'per-artifact quota cannot exceed principal quota' });
  }
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type AgentModelProfile = z.infer<typeof AgentModelProfileSchema>;
export type RunnerAgentLimits = z.infer<typeof RunnerAgentLimitsSchema>;
export type RunnerAgentsConfig = z.infer<typeof RunnerAgentsConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
