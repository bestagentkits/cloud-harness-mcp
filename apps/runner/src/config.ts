import { readFileSync } from 'node:fs';
import { RunnerConfigSchema, type RunnerConfig } from '@cloud-harness/contracts';

function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const csv = (value: string | undefined, fallback: string) => (value ?? fallback).split(',').map((entry) => entry.trim()).filter(Boolean);

export function loadRunnerConfig(): RunnerConfig {
  const githubAppId = process.env.GITHUB_APP_ID;
  const githubInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const githubPrivateKey = secret('GITHUB_APP_PRIVATE_KEY');
  return RunnerConfigSchema.parse({
    host: process.env.RUNNER_HOST,
    port: process.env.RUNNER_PORT,
    serviceToken: secret('RUNNER_TOKEN'),
    jobsRoot: process.env.JOBS_ROOT ?? '/var/lib/cloud-harness/jobs',
    stateDb: process.env.STATE_DB ?? '/var/lib/cloud-harness/state/cloud-harness.db',
    executorImage: process.env.EXECUTOR_IMAGE ?? 'cloud-harness-executor:local',
    allowedGitHosts: csv(process.env.ALLOWED_GIT_HOSTS, 'github.com'),
    networkMode: process.env.WORKSPACE_NETWORK_MODE,
    wallTtlSeconds: process.env.WORKSPACE_WALL_TTL_SECONDS,
    idleTtlSeconds: process.env.WORKSPACE_IDLE_TTL_SECONDS,
    maxOutputBytes: process.env.MAX_OUTPUT_BYTES,
    minFreeBytes: process.env.MIN_FREE_BYTES,
    maxWorkspaceBytes: process.env.MAX_WORKSPACE_BYTES,
    reaperIntervalSeconds: process.env.REAPER_INTERVAL_SECONDS,
    githubApp: githubAppId && githubInstallationId && githubPrivateKey ? {
      appId: githubAppId,
      installationId: githubInstallationId,
      privateKey: githubPrivateKey
    } : undefined
  });
}
