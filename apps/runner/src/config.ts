import { readFileSync } from 'node:fs';
import { RunnerConfigSchema, SecretKeyringConfigSchema, type RunnerConfig } from '@cloud-harness/contracts';

function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const csv = (value: string | undefined, fallback: string) => (value ?? fallback).split(',').map((entry) => entry.trim()).filter(Boolean);

const json = (value: string | undefined): unknown => value === undefined ? undefined : JSON.parse(value) as unknown;

function agentProfiles(value: string | undefined, file: string | undefined): unknown {
  if (value !== undefined && file !== undefined) {
    throw new Error('configure only one of AGENT_PROFILES_JSON or AGENT_PROFILES_FILE');
  }
  const serialized = value ?? (file === undefined ? undefined : readFileSync(file, 'utf8'));
  if (serialized === undefined) return undefined;
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error('agent profiles must contain valid JSON');
  }
}

export type RunnerConfigLoadResult = {
  config: RunnerConfig;
  secretReadinessError?: string;
};

export function loadRunnerConfigWithReadiness(): RunnerConfigLoadResult {
  let secretKeyring: RunnerConfig['secretKeyring'];
  let secretReadinessError: string | undefined;
  const encodedKeyring = secret('SECRET_KEYRING');
  if (encodedKeyring) {
    try {
      const parsed = SecretKeyringConfigSchema.safeParse(JSON.parse(encodedKeyring) as unknown);
      if (parsed.success) secretKeyring = parsed.data;
      else secretReadinessError = 'secret keyring configuration is invalid';
    } catch {
      secretReadinessError = 'secret keyring configuration is invalid';
    }
  }
  const githubAppId = process.env.GITHUB_APP_ID;
  const githubInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const githubPrivateKey = secret('GITHUB_APP_PRIVATE_KEY');
  const githubAppSlug = process.env['GITHUB_APP_SLUG'];
  const legacyOwnerId = process.env.ACCESS_LEGACY_OWNER_ID;
  const legacyIssuer = process.env.ACCESS_LEGACY_ISSUER;
  const legacySubject = process.env.ACCESS_LEGACY_SUBJECT;
  if (process.env.WORKSPACE_NETWORK_MODE !== undefined) {
    throw new Error("WORKSPACE_NETWORK_MODE was replaced by WORKSPACE_NETWORK_PROFILE; set WORKSPACE_NETWORK_PROFILE to 'network-none' or 'dependency-access'");
  }

  const agentConfigurationPresent = [
    'AGENT_IMAGE',
    'AGENT_NETWORK_MODE',
    'AGENT_GATEWAY_URL',
    'AGENT_PROFILES_JSON',
    'AGENT_PROFILES_FILE',
    'AGENT_GLOBAL_ACTIVE',
    'AGENT_PRINCIPAL_ACTIVE',
    'AGENT_WORKSPACE_ACTIVE',
    'AGENT_PARENT_ACTIVE',
    'AGENT_WORKSPACE_LIFETIME_RECORDS',
    'AGENT_MIN_TTL_SECONDS',
    'AGENT_MAX_TTL_SECONDS',
    'AGENT_MAX_PROMPT_BYTES',
    'AGENT_MAX_MESSAGE_BYTES',
    'AGENT_MAX_LOG_BYTES',
    'AGENT_MAX_LOG_EVENTS',
    'AGENT_MAX_OUTPUT_BYTES',
    'AGENT_MAX_LOG_EVENT_BYTES',
    'AGENT_GLOBAL_RETAINED_ROWS',
    'AGENT_PRINCIPAL_RETAINED_ROWS',
    'AGENT_WORKSPACE_RETAINED_ROWS',
    'AGENT_GLOBAL_RETAINED_BYTES',
    'AGENT_PRINCIPAL_RETAINED_BYTES',
    'AGENT_WORKSPACE_RETAINED_BYTES',
    'AGENT_CANCELLATION_GRACE_MS',
    'AGENT_CLEANUP_RETRY_LIMIT',
    'AGENT_CLEANUP_RETRY_MAX_DELAY_MS',
    'AGENT_RETENTION_SECONDS',
    'AGENT_LOOKUP_HORIZON_SECONDS'
  ].some((name) => process.env[name] !== undefined);
  const config = RunnerConfigSchema.parse({
    authMode: process.env.AUTH_MODE,
    host: process.env.RUNNER_HOST,
    port: process.env.RUNNER_PORT,
    serviceToken: secret('RUNNER_TOKEN'),
    jobsRoot: process.env.JOBS_ROOT ?? '/var/lib/cloud-harness/jobs',
    stateDb: process.env.STATE_DB ?? '/var/lib/cloud-harness/state/cloud-harness.db',
    executorImage: process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local',
    networkGuardImage: process.env.NETWORK_GUARD_IMAGE ?? 'cloud-harness-network-guard:local',
    allowedGitHosts: csv(process.env.ALLOWED_GIT_HOSTS, 'github.com'),
    networkProfile: process.env.WORKSPACE_NETWORK_PROFILE,
    dependencyDnsResolvers: process.env.DEPENDENCY_DNS_RESOLVERS ? csv(process.env.DEPENDENCY_DNS_RESOLVERS, '8.8.8.8,1.1.1.1') : undefined,
    dependencyBridgeSubnet: process.env.DEPENDENCY_BRIDGE_SUBNET,
    dependencyBridgeInterface: process.env.DEPENDENCY_BRIDGE_INTERFACE,
    dependencyNetworkName: process.env.DEPENDENCY_NETWORK_NAME,
    wallTtlSeconds: process.env.WORKSPACE_WALL_TTL_SECONDS,
    idleTtlSeconds: process.env.WORKSPACE_IDLE_TTL_SECONDS,
    maxOutputBytes: process.env.MAX_OUTPUT_BYTES,
    minFreeBytes: process.env.MIN_FREE_BYTES,
    maxWorkspaceBytes: process.env.MAX_WORKSPACE_BYTES,
    reaperIntervalSeconds: process.env.REAPER_INTERVAL_SECONDS,
    artifactRoot: process.env.ARTIFACT_ROOT,
    maxArtifactBytes: process.env.MAX_ARTIFACT_BYTES,
    maxPrincipalArtifactBytes: process.env.MAX_PRINCIPAL_ARTIFACT_BYTES,
    artifactRetentionSeconds: process.env.ARTIFACT_RETENTION_SECONDS,
    enableRepoCache: process.env.ENABLE_REPO_CACHE,
    repoCacheRoot: process.env.REPO_CACHE_ROOT,
    enableToolkitCache: process.env.ENABLE_TOOLKIT_CACHE,
    toolkitCacheRoot: process.env.TOOLKIT_CACHE_ROOT,
    toolkitNetworkPolicy: process.env.TOOLKIT_NETWORK_POLICY,
    toolkitEgressProxy: process.env.TOOLKIT_EGRESS_PROXY,
    provisioningNetwork: process.env.PROVISIONING_NETWORK,
    secretKeyring,
    legacyPrincipalMapping: legacyOwnerId || legacyIssuer || legacySubject ? {
      legacyOwnerId,
      issuer: legacyIssuer,
      subject: legacySubject
    } : undefined,
    principalRelinks: json(process.env['ACCESS_PRINCIPAL_RELINKS']),
    githubApp: githubAppId || githubInstallationId || githubPrivateKey || githubAppSlug ? {
      appId: githubAppId,
      installationId: githubInstallationId,
      privateKey: githubPrivateKey,
      appSlug: process.env.GITHUB_APP_SLUG
    } : undefined,
    agents: agentConfigurationPresent ? {
      image: process.env.AGENT_IMAGE,
      networkMode: process.env.AGENT_NETWORK_MODE,
      gatewayUrl: process.env.AGENT_GATEWAY_URL,
      profiles: agentProfiles(process.env.AGENT_PROFILES_JSON, process.env.AGENT_PROFILES_FILE),
      limits: {
        globalActive: process.env.AGENT_GLOBAL_ACTIVE,
        principalActive: process.env.AGENT_PRINCIPAL_ACTIVE,
        workspaceActive: process.env.AGENT_WORKSPACE_ACTIVE,
        maxOutputBytesPerAgent: process.env.AGENT_MAX_OUTPUT_BYTES,
        parentActive: process.env.AGENT_PARENT_ACTIVE,
        workspaceLifetimeRecords: process.env.AGENT_WORKSPACE_LIFETIME_RECORDS,
        minTtlSeconds: process.env.AGENT_MIN_TTL_SECONDS,
        maxTtlSeconds: process.env.AGENT_MAX_TTL_SECONDS,
        maxPromptBytes: process.env.AGENT_MAX_PROMPT_BYTES,
        maxMessageBytes: process.env.AGENT_MAX_MESSAGE_BYTES,
        maxLogBytesPerAgent: process.env.AGENT_MAX_LOG_BYTES,
        maxLogEventsPerAgent: process.env.AGENT_MAX_LOG_EVENTS,
        maxLogEventBytes: process.env.AGENT_MAX_LOG_EVENT_BYTES,
        globalRetainedRows: process.env.AGENT_GLOBAL_RETAINED_ROWS,
        principalRetainedRows: process.env.AGENT_PRINCIPAL_RETAINED_ROWS,
        workspaceRetainedRows: process.env.AGENT_WORKSPACE_RETAINED_ROWS,
        globalRetainedBytes: process.env.AGENT_GLOBAL_RETAINED_BYTES,
        principalRetainedBytes: process.env.AGENT_PRINCIPAL_RETAINED_BYTES,
        workspaceRetainedBytes: process.env.AGENT_WORKSPACE_RETAINED_BYTES,
        cancellationGraceMs: process.env.AGENT_CANCELLATION_GRACE_MS,
        cleanupRetryLimit: process.env.AGENT_CLEANUP_RETRY_LIMIT,
        cleanupRetryMaxDelayMs: process.env.AGENT_CLEANUP_RETRY_MAX_DELAY_MS,
        retentionSeconds: process.env.AGENT_RETENTION_SECONDS,
        lookupHorizonSeconds: process.env.AGENT_LOOKUP_HORIZON_SECONDS
      }
    } : undefined
  });
  return { config, ...(secretReadinessError ? { secretReadinessError } : {}) };
}

export const loadRunnerConfig = (): RunnerConfig => loadRunnerConfigWithReadiness().config;
