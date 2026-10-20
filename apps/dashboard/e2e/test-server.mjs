// Playwright web server: the real Express API (`apps/api/dist`) serving the built React
// Dashboard (`apps/dashboard/dist`) in Cloudflare Access mode. This process stands in for
// the Access edge: it signs a short-lived assertion with a key generated at startup and
// adds it to every request, and the API verifies it against that key's offline JWKS.
// Nothing here is a real credential; the key never leaves the process.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiConfigSchema } from '@cloud-harness/contracts';
import { createApiApp } from '../../api/dist/app.js';

const PORT = Number(process.env.DASHBOARD_E2E_PORT ?? 4319);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const issuer = 'https://e2e.cloudflareaccess.invalid';
const audience = 'dashboard-e2e';
const kid = 'e2e';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });

function assertion() {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [audience], sub: 'e2e-owner', email: 'owner@example.test', type: 'app', nbf: now - 5, exp: now + 300
  })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

const config = ApiConfigSchema.parse({
  host: '127.0.0.1',
  port: PORT,
  authMode: 'cloudflare-access',
  accessIssuer: issuer,
  accessAudience: audience,
  accessJwksUrl: `${issuer}/cdn-cgi/access/certs`,
  // Never contacted: the smoke only exercises routes that do not reach the runner.
  runnerUrl: 'http://127.0.0.1:9',
  runnerToken: 'e2e-runner-token-that-is-longer-than-32-characters',
  publicHosts: ['127.0.0.1'],
  allowedOrigins: [ORIGIN],
  dashboardUi: 'react'
});

const runtime = createApiApp(config, { accessVerifier: { fetcher: async () => new Response(jwks, { status: 200 }) } });
const server = createServer((request, response) => {
  request.headers['cf-access-jwt-assertion'] = assertion();
  runtime.app(request, response);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Dashboard e2e server on ${ORIGIN}`));

async function shutdown() {
  server.close();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
