import { readFileSync } from 'node:fs';
import { ApiConfigSchema, type ApiConfig } from '@cloud-harness/contracts';

function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const csv = (value: string | undefined, fallback = '') => (value ?? fallback).split(',').map((entry) => entry.trim()).filter(Boolean);

export function loadApiConfig(): ApiConfig {
  return ApiConfigSchema.parse({
    host: process.env.API_HOST,
    port: process.env.API_PORT,
    ownerId: process.env.OWNER_ID,
    authMode: process.env.AUTH_MODE,
    bearerToken: secret('MCP_BEARER_TOKEN'),
    accessIssuer: process.env.CLOUDFLARE_ACCESS_ISSUER,
    accessAudience: process.env.CLOUDFLARE_ACCESS_AUDIENCE,
    accessJwksUrl: process.env.CLOUDFLARE_ACCESS_JWKS_URL,
    runnerUrl: process.env.RUNNER_URL ?? 'http://runner:3001',
    runnerToken: secret('RUNNER_TOKEN'),
    publicHosts: csv(process.env.API_PUBLIC_HOSTS, 'localhost,127.0.0.1'),
    allowedOrigins: csv(process.env.API_ALLOWED_ORIGINS),
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS,
    maxBodyBytes: process.env.MAX_BODY_BYTES
  });
}
