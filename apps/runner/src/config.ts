import { readFileSync } from 'node:fs';
import { RunnerConfigSchema, SecretKeyringConfigSchema, type RunnerConfig } from '@cloud-harness/contracts';

function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

/**
 * `GH_TOKEN` and `GITHUB_TOKEN` are ordinary environment names that unrelated
 * tooling also sets, so a value that cannot be a GitHub credential is ignored
 * after a warning rather than failing runner startup. The credential is used
 * only when no GitHub App repository token is available and only in
 * `owner-bearer` mode; `resolveGitHubFallbackToken` owns that policy, and the
 * resolved value is registered with the ingest-time redactor rather than being
 * logged or placed in an executor environment.
 */
function plausibleGitHubToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 20 || /[\s\0]/.test(value)) {
    console.warn('[runner-config] ignoring GH_TOKEN/GITHUB_TOKEN: value is not a plausible GitHub credential');
    return undefined;
  }
  return value;
}

/**
 * The Managed OAuth control-plane integration is configured only when the
 * operator supplies all three identifiers; a partial set fails startup through
 * the schema rather than silently disabling the Dashboard controls.
 */
function cloudflareAccessOAuth(): Record<string, unknown> | undefined {
  const apiToken = secret('CLOUDFLARE_ACCESS_API_TOKEN');
  const accountId = process.env.CLOUDFLARE_ACCESS_ACCOUNT_ID;
  const appId = process.env.CLOUDFLARE_ACCESS_APP_ID;
  const access = process.env.CLOUDFLARE_ACCESS_OAUTH_ACCESS;
  const maxGrantSeconds = process.env.CLOUDFLARE_ACCESS_OAUTH_MAX_GRANT_SECONDS;
  if (!apiToken && !accountId && !appId && !access && !maxGrantSeconds) return undefined;
  return {
    apiToken,
    accountId,
    appId,
    ...(access ? { access } : {}),
    ...(maxGrantSeconds ? { maxGrantSeconds } : {})
  };
}

const csv = (value: string | undefined, fallback: string) => (value ?? fallback).split(',').map((entry) => entry.trim()).filter(Boolean);

type PrincipalRelinks = NonNullable<RunnerConfig['principalRelinks']>;
type AgentProfiles = NonNullable<RunnerConfig['agents']>['profiles'];

/**
 * Parse `ACCESS_PRINCIPAL_RELINKS` at its boundary. The configuration schema owns the shape, so this
 * only guarantees the value is JSON and fails closed with a named error rather than a bare SyntaxError.
 */
function principalRelinks(value: string | undefined): PrincipalRelinks | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as PrincipalRelinks;
  } catch {
    throw new Error('ACCESS_PRINCIPAL_RELINKS must contain valid JSON');
  }
}

function agentProfiles(value: string | undefined, file: string | undefined): AgentProfiles | undefined {
  if (value !== undefined && file !== undefined) {
    throw new Error('configure only one of AGENT_PROFILES_JSON or AGENT_PROFILES_FILE');
  }
  const serialized = value ?? (file === undefined ? undefined : readFileSync(file, 'utf8'));
  if (serialized === undefined) return undefined;
  try {
    return JSON.parse(serialized) as AgentProfiles;
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
  const githubToken = plausibleGitHubToken(secret('GH_TOKEN') ?? secret('GITHUB_TOKEN'));
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
    'AGENT_LOOKUP_HORIZON_SECONDS',
    'AGENT_SESSION_PERSISTENCE_ENABLED',
    'AGENT_MAX_SESSION_MESSAGES',
    'AGENT_MAX_SESSION_BYTES',
    'AGENT_SESSION_RETENTION_MS',
    'AGENT_GLOBAL_SESSION_BYTES',
    'AGENT_PRINCIPAL_SESSION_BYTES',
    'AGENT_WORKSPACE_SESSION_BYTES',
    'AGENT_DURABLE_RUNTIME_ENABLED',
    'AGENT_DURABLE_MAX_LINEAGE_BYTES',
    'AGENT_MAX_RECEIPT_BYTES_PER_LINEAGE'
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
    terminalMaxPerWorkspace: process.env.TERMINAL_MAX_PER_WORKSPACE,
    terminalRetainedBytes: process.env.TERMINAL_RETAINED_BYTES,
    terminalIdleTimeoutMs: process.env.TERMINAL_IDLE_TIMEOUT_MS,
    terminalMaxLifetimeMs: process.env.TERMINAL_MAX_LIFETIME_MS,
    packagesEnabled: process.env.PACKAGES_ENABLED,
    typesafeEgress: process.env.TYPESAFE_EGRESS,
    decisionPlanePurposes: process.env.DECISION_PLANE_PURPOSES === undefined ? undefined : csv(process.env.DECISION_PLANE_PURPOSES, ''),
    toolboxMaxConcurrent: process.env.TOOLBOX_MAX_CONCURRENT,
    packagesRoot: process.env.PACKAGES_ROOT,
    packagesEcosystems: process.env.PACKAGES_ECOSYSTEMS === undefined ? undefined : csv(process.env.PACKAGES_ECOSYSTEMS, ''),
    packagesApprovalMode: process.env.PACKAGES_APPROVAL_MODE,
    packagesNpmLifecycleScripts: process.env.PACKAGES_NPM_LIFECYCLE_SCRIPTS,
    packagesMaxReleaseBytes: process.env.PACKAGES_MAX_RELEASE_BYTES,
    packagesMaxOwnerBytes: process.env.PACKAGES_MAX_OWNER_BYTES,
    packagesMaxBindings: process.env.PACKAGES_MAX_BINDINGS,
    packagesBuildTimeoutMs: process.env.PACKAGES_BUILD_TIMEOUT_MS,
    minFreeBytes: process.env.MIN_FREE_BYTES,
    maxWorkspaceBytes: process.env.MAX_WORKSPACE_BYTES,
    maxActiveWorkspacesPerOwner: process.env.MAX_ACTIVE_WORKSPACES_PER_OWNER,
    // An empty value must not coerce to 0, which would select immediate auto-close.
    recoverableGraceSeconds: process.env.WORKSPACE_RECOVERABLE_GRACE_SECONDS || undefined,
    lifecycleEnvironmentKeys: lifecycleEnvironmentKeys(),
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
    builtinSkillsRoot: process.env.BUILTIN_SKILLS_ROOT,
    agentkitRegistryUrl: process.env.AGENTKIT_REGISTRY_URL,
    agentkitRegistryCredentialSecret: process.env.AGENTKIT_REGISTRY_CREDENTIAL_SECRET,
    agentkitRegistryKeyId: process.env.AGENTKIT_REGISTRY_KEY_ID,
    agentkitRegistryPublicKey: process.env.AGENTKIT_REGISTRY_PUBLIC_KEY,
    provisioningNetwork: process.env.PROVISIONING_NETWORK,
    secretKeyring,
    legacyPrincipalMapping: legacyOwnerId || legacyIssuer || legacySubject ? {
      legacyOwnerId,
      issuer: legacyIssuer,
      subject: legacySubject
    } : undefined,
    principalRelinks: principalRelinks(process.env['ACCESS_PRINCIPAL_RELINKS']),
    githubApp: githubAppId || githubInstallationId || githubPrivateKey || githubAppSlug ? {
      appId: githubAppId,
      installationId: githubInstallationId,
      privateKey: githubPrivateKey,
      appSlug: process.env.GITHUB_APP_SLUG
    } : undefined,
    githubToken,
    cloudflareAccessOAuth: cloudflareAccessOAuth(),
    agents: agentConfigurationPresent ? {
      image: process.env.AGENT_IMAGE,
      networkMode: process.env.AGENT_NETWORK_MODE,
      gatewayUrl: process.env.AGENT_GATEWAY_URL,
      profiles: agentProfiles(process.env.AGENT_PROFILES_JSON, process.env.AGENT_PROFILES_FILE),
      sessionPersistenceEnabled: process.env.AGENT_SESSION_PERSISTENCE_ENABLED,
      durableRuntimeEnabled: process.env.AGENT_DURABLE_RUNTIME_ENABLED,
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
        lookupHorizonSeconds: process.env.AGENT_LOOKUP_HORIZON_SECONDS,
        maxSessionMessages: process.env.AGENT_MAX_SESSION_MESSAGES,
        maxSessionBytes: process.env.AGENT_MAX_SESSION_BYTES,
        sessionRetentionMs: process.env.AGENT_SESSION_RETENTION_MS,
        globalSessionBytes: process.env.AGENT_GLOBAL_SESSION_BYTES,
        principalSessionBytes: process.env.AGENT_PRINCIPAL_SESSION_BYTES,
        workspaceSessionBytes: process.env.AGENT_WORKSPACE_SESSION_BYTES,
        maxDurableLineageBytes: process.env.AGENT_DURABLE_MAX_LINEAGE_BYTES,
        maxReceiptBytesPerLineage: process.env.AGENT_MAX_RECEIPT_BYTES_PER_LINEAGE
      }
    } : undefined
  });
  if (packageApprovalUnavailable(config)) {
    console.warn('[runner-config] PACKAGES_APPROVAL_MODE=required has no Dashboard approver in owner-bearer mode: packages_apply is refused until PACKAGES_APPROVAL_MODE=none');
  }
  return { config, ...(secretReadinessError ? { secretReadinessError } : {}) };
}

/**
 * Package plans need a Dashboard approval by default, and the Dashboard exists only in
 * `cloudflare-access` mode. The runner still starts in that combination (the toolbox is opt-in and
 * refusing to boot would break unrelated features); apply is refused instead.
 */
export function packageApprovalUnavailable(config: Pick<RunnerConfig, 'authMode' | 'packagesEnabled' | 'packagesApprovalMode'>): boolean {
  return config.packagesEnabled && config.packagesApprovalMode === 'required' && (config.authMode ?? 'owner-bearer') === 'owner-bearer';
}

/** The lifecycle values the environment sets explicitly; an empty variable counts as unset, as zod coercion does not. */
function lifecycleEnvironmentKeys(): string[] {
  const variables: Array<[string, string]> = [
    ['maxActiveWorkspacesPerOwner', 'MAX_ACTIVE_WORKSPACES_PER_OWNER'],
    ['idleTtlSeconds', 'WORKSPACE_IDLE_TTL_SECONDS'],
    ['wallTtlSeconds', 'WORKSPACE_WALL_TTL_SECONDS'],
    ['recoverableGraceSeconds', 'WORKSPACE_RECOVERABLE_GRACE_SECONDS']
  ];
  return variables.filter(([, name]) => process.env[name] !== undefined && process.env[name] !== '').map(([key]) => key);
}

export const loadRunnerConfig = (): RunnerConfig => loadRunnerConfigWithReadiness().config;
