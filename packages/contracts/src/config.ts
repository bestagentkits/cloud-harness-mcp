import { z } from 'zod';

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
  mailboxProbeEnabled: enabled,
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
  allowedGitHosts: z.array(z.string().min(1)).min(1),
  networkMode: z.enum(['none', 'bridge']).default('none'),
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
  }).optional()
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
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
