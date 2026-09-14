import { readFileSync } from 'node:fs';
import { ApiConfigSchema, type ApiConfig } from '@cloud-harness/contracts';

function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const environment = (name: string): string | undefined => process.env[name];

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
    maxBodyBytes: process.env.MAX_BODY_BYTES,
    mcpGatewayTimeoutMs: environment('MCP_GATEWAY_TIMEOUT_MS'),
    mcpGatewayMaxResponseBytes: environment('MCP_GATEWAY_MAX_RESPONSE_BYTES'),
    mcpGatewayMaxToolsPerServer: environment('MCP_GATEWAY_MAX_TOOLS_PER_SERVER'),
    mcpGatewayMaxSchemaBytes: environment('MCP_GATEWAY_MAX_SCHEMA_BYTES'),
    mcpGatewayMaxCatalogBytes: environment('MCP_GATEWAY_MAX_CATALOG_BYTES'),
    mcpGatewayMaxTraceRows: environment('MCP_GATEWAY_MAX_TRACE_ROWS'),
    mcpGatewayMaxConnections: environment('MCP_GATEWAY_MAX_CONNECTIONS'),
    mcpGatewayAllowInsecureHttp: environment('MCP_GATEWAY_ALLOW_INSECURE_HTTP'),
    mcpGatewayAllowPrivateEndpoints: environment('MCP_GATEWAY_ALLOW_PRIVATE_ENDPOINTS')
    ,apiKeyAuthEnabled: environment('API_KEY_AUTH_ENABLED'),
    apiKeyGatewayAccessAudience: environment('API_KEY_GATEWAY_ACCESS_AUDIENCE'),
    apiKeyGatewayServiceSubject: environment('API_KEY_GATEWAY_SERVICE_SUBJECT'),
    apiKeyGatewayPublicUrl: environment('API_KEY_GATEWAY_PUBLIC_URL')
  });
}
