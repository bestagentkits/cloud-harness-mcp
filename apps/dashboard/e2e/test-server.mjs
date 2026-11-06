// Playwright web server: the real Express API (`apps/api/dist`) serving the built React
// Dashboard (`apps/dashboard/dist`) in Cloudflare Access mode. This process stands in for
// the Access edge: it signs a short-lived assertion with a key generated at startup and
// adds it to every request, and the API verifies it against that key's offline JWKS.
// Nothing here is a real credential; the key never leaves the process.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiConfigSchema } from '@cloud-harness/contracts';
import { createApiApp } from '../../api/dist/app.js';
import { startDeweeGatewayStub } from './dewee-gateway-stub.mjs';

const PORT = Number(process.env.DASHBOARD_E2E_PORT ?? 4319);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const issuer = 'https://e2e.cloudflareaccess.invalid';
const audience = 'dashboard-e2e';
const kid = 'e2e';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });

// One Access subject per browser context, so per test: Playwright opens a fresh context with
// an empty cookie jar for every test, and the first response hands it a new subject in an
// HttpOnly cookie that this edge reads back (and strips) on every later request. Within a
// test the subject is stable across reloads and `page.request`, so the BFF session, CSRF and
// the Dewee visitor behave as for one signed-in owner; across tests each subject gets its own
// window of the API's real per-principal limit instead of the whole suite sharing one owner's
// 120 requests per minute. The limit itself is unchanged and `e2e/states.spec.ts` drives a
// real 429 from it.
const SUBJECT_COOKIE = 'e2e-access-subject';
const SUBJECT_PATTERN = /^e2e-owner-\d{1,9}$/;
let subjects = 0;

function subjectFor(request, response) {
  const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter(Boolean);
  const own = cookies.find((part) => part.startsWith(`${SUBJECT_COOKIE}=`))?.slice(SUBJECT_COOKIE.length + 1);
  const rest = cookies.filter((part) => !part.startsWith(`${SUBJECT_COOKIE}=`));
  if (rest.length) request.headers.cookie = rest.join('; ');
  else delete request.headers.cookie;
  if (own && SUBJECT_PATTERN.test(own)) return own;
  subjects += 1;
  const subject = `e2e-owner-${subjects}`;
  // The API sets its own cookies with setHeader, so ours is merged in when the headers are
  // sent (Node routes the implicit header flush through writeHead too). A headers object
  // passed to writeHead, such as a replayed asset's cached one, is copied, never mutated.
  const cookie = `${SUBJECT_COOKIE}=${subject}; Path=/; HttpOnly; SameSite=Strict`;
  const writeHead = response.writeHead.bind(response);
  response.writeHead = (status, ...rest) => {
    const index = rest.findIndex((value) => value && typeof value === 'object' && !Array.isArray(value));
    const given = index >= 0 ? { ...rest[index] } : {};
    const passed = Object.keys(given).filter((name) => name.toLowerCase() === 'set-cookie');
    const existing = [...passed.flatMap((name) => [given[name]].flat()), ...[response.getHeader('set-cookie') ?? []].flat()].map(String);
    for (const name of passed) delete given[name];
    response.removeHeader('set-cookie');
    given['set-cookie'] = [...existing, cookie];
    const args = index >= 0 ? rest.map((value, at) => (at === index ? given : value)) : [...rest, given];
    return writeHead(status, ...args);
  };
  return subject;
}

function assertion(subject) {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [audience], sub: subject, email: 'owner@example.test', type: 'app', nbf: now - 5, exp: now + 300
  })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

// The assistant suite talks to a scripted loopback gateway; these test-only values never
// leave the process and stand in for the production Dewee settings.
const DEWEE_GATEWAY_TOKEN = 'e2e-dewee-gateway-token';
const dewee = await startDeweeGatewayStub(DEWEE_GATEWAY_TOKEN);

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
  dashboardUi: 'react',
  deweeGatewayUrl: dewee.url,
  deweeGatewayToken: DEWEE_GATEWAY_TOKEN,
  deweeWebchatSecret: 'e2e-dewee-webchat-secret-longer-than-32-characters'
});

const runtime = createApiApp(config, { accessVerifier: { fetcher: async () => new Response(jwks, { status: 200 }) } });

// Each Playwright test opens a fresh browser context, so without help every page load would
// re-download every content-hashed chunk and the whole suite would exceed the API's
// per-minute request limit. Like a browser cache for immutable files, the first request for
// each hashed asset goes through the real API (its routing, allowlist and security headers)
// and later ones replay that exact status, headers and body without entering Express. Only a
// 200 that carries the API's immutable caching and security headers is replayed; anything
// else keeps going through the API every time, and `e2e/smoke.spec.ts` asserts the headers
// a replayed asset carries, so a header regression still fails the suite.
const ASSET = /^\/dashboard\/assets\/[^/?]+$/;
const assetCache = new Map();

/** The headers every served asset must carry; a response without them is never cached. */
function replayable(headers) {
  return String(headers['cache-control'] ?? '').includes('immutable')
    && headers['x-content-type-options'] === 'nosniff'
    && Boolean(headers['content-security-policy']);
}

function replay(cached, response) {
  response.writeHead(cached.status, cached.headers);
  response.end(cached.body);
}

function captureAsset(path, response) {
  const chunks = [];
  const write = response.write.bind(response);
  const end = response.end.bind(response);
  response.write = (chunk, ...rest) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...rest); };
  response.end = (chunk, ...rest) => {
    if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
    const headers = response.getHeaders();
    if (response.statusCode === 200 && replayable(headers)) assetCache.set(path, { status: 200, headers, body: Buffer.concat(chunks) });
    return end(chunk, ...rest);
  };
}

// Test-only route (never forwarded to the API): what the gateway received, so a spec can
// assert the page context and action results that left the BFF.
const DEWEE_MESSAGES = '/__e2e/dewee-messages';

const server = createServer((request, response) => {
  const path = request.url ?? '';
  const subject = subjectFor(request, response);
  if (path === DEWEE_MESSAGES) {
    if (request.method === 'DELETE') dewee.messages.length = 0;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ messages: dewee.messages }));
    return;
  }
  if (request.method === 'GET' && ASSET.test(path)) {
    const cached = assetCache.get(path);
    if (cached) { replay(cached, response); return; }
    captureAsset(path, response);
  }
  request.headers['cf-access-jwt-assertion'] = assertion(subject);
  runtime.app(request, response);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Dashboard e2e server on ${ORIGIN}`));

async function shutdown() {
  server.close();
  await runtime.close();
  await dewee.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
