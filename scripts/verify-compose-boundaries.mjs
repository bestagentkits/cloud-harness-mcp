import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

// The provisioning proxy's optional opt-in file is pointed at a path that never exists, so the rendered
// configuration is the shipped default rather than whatever this host has in /etc.
const ABSENT_PROXY_ENV_FILE = '.cloud-harness-verify-compose/absent-provisioning-proxy.env';
const result = spawnSync('docker', [
  'compose', '--profile', 'gateway-test', '-f', 'compose.yaml', '-f', 'compose.production.yaml', 'config', '--format', 'json'
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, CLOUD_HARNESS_ENV_FILE: '.env.example', PROVISIONING_PROXY_ENV_FILE: ABSENT_PROXY_ENV_FILE }
});

if (result.status !== 0) throw new Error(result.stderr || 'production Compose config failed');
const config = JSON.parse(result.stdout);
const services = config.services;
const networks = config.networks;
const requireBoundary = (condition, message) => {
  if (!condition) throw new Error(message);
};
const networkNames = (service) => Object.keys(service.networks ?? {}).sort();
const mountTargets = (service) => (service.volumes ?? []).map((mount) => mount.target).sort();
const environmentNames = (service) => Object.keys(service.environment ?? {}).sort();
const sameNames = (actual, expected) => JSON.stringify(actual) === JSON.stringify([...expected].sort());
requireBoundary(!services.api.ports?.length, 'API must not publish a host port');
requireBoundary(!services.runner.ports?.length, 'runner must not publish a host port');
requireBoundary(!services.api.volumes?.length, 'API must not receive host mounts');
requireBoundary(!services.ingress.volumes?.length, 'ingress must not receive host mounts');
requireBoundary(JSON.stringify(networkNames(services.api)) === JSON.stringify(['api-egress', 'control', 'frontend']), 'API network boundary changed');
requireBoundary(JSON.stringify(networkNames(services.runner)) === JSON.stringify(['control', 'runner-egress']), 'runner network boundary changed');
requireBoundary(JSON.stringify(networkNames(services.ingress)) === JSON.stringify(['frontend', 'ingress']), 'ingress network boundary changed');
requireBoundary(JSON.stringify(networkNames(services['provisioning-proxy'])) === JSON.stringify(['provisioning', 'runner-egress']), 'provisioning-proxy network boundary changed');
requireBoundary(networks.control.internal === true && networks.frontend.internal === true && networks.provisioning.internal === true, 'private networks must remain internal');
requireBoundary(networks.ingress.internal !== true && networks['api-egress'].internal !== true && networks['runner-egress'].internal !== true && networks['provider-egress'].internal !== true, 'gateway networks must remain routable');

const gateway = services['model-gateway'];
requireBoundary(gateway.read_only === true, 'model gateway filesystem must be read-only');
requireBoundary(sameNames(networkNames(gateway), ['provider-egress']), 'model gateway may join only provider-egress statically');
requireBoundary(Object.entries(services).every(([name, service]) => name === 'model-gateway' || !networkNames(service).includes('provider-egress')), 'only model gateway may join provider-egress');
requireBoundary(sameNames(mountTargets(gateway), [
  '/run/model-gateway-config/profiles.json',
  '/run/model-gateway-secrets/provider-api-key'
]), 'model gateway mounts must be the exact profile and provider credential files');
requireBoundary((gateway.volumes ?? []).every((mount) => mount.read_only === true), 'model gateway mounts must be read-only');
requireBoundary(!(gateway.volumes ?? []).some((mount) => /docker\.sock|jobs|state|github|runner|control/u.test(`${mount.source}:${mount.target}`)), 'model gateway must not receive Docker, repository, job, state, runner, or control mounts');
requireBoundary(sameNames(environmentNames(gateway), [
  'MODEL_GATEWAY_CONTROL_SOCKET',
  'MODEL_GATEWAY_HOST',
  'MODEL_GATEWAY_MODE',
  'MODEL_GATEWAY_PORT',
  'MODEL_GATEWAY_PROFILES_FILE',
  'MODEL_GATEWAY_SESSION_HEADER'
]), 'model gateway environment allowlist changed');
requireBoundary(gateway.environment.MODEL_GATEWAY_MODE === 'production', 'production gateway must force production profile validation');

const staticAgentNetworks = Object.keys(networks).filter((name) => /agent/u.test(name) && name !== 'model-gateway-test-agent');
requireBoundary(staticAgentNetworks.length === 0, 'production agent workers require dynamic per-agent networks, not a shared static network');
const testGateway = services['model-gateway-test'];
const fakeProvider = services['fake-provider'];
requireBoundary(testGateway.profiles?.includes('gateway-test') && fakeProvider.profiles?.includes('gateway-test'), 'fake provider topology must remain behind the gateway-test profile');
requireBoundary(testGateway.environment.MODEL_GATEWAY_MODE === 'test', 'test gateway must not masquerade as production');
requireBoundary(sameNames(networkNames(testGateway), ['model-gateway-test-agent', 'provider-egress-test']), 'test gateway topology changed');
requireBoundary(sameNames(networkNames(fakeProvider), ['provider-egress-test']), 'fake provider must be reachable only on test egress');
requireBoundary(networks['model-gateway-test-agent'].internal === true && networks['provider-egress-test'].internal === true, 'test topology networks must remain internal');
requireBoundary(!testGateway.ports?.length && !fakeProvider.ports?.length, 'test topology must not publish host ports');
requireBoundary(!(testGateway.volumes ?? []).some((mount) => mount.target.includes('/run/model-gateway-secrets/provider-api-key')), 'test topology must not mount the production provider secret');

// The agent image's entrypoint runs the agent runtime, so a keepalive `command` would only become runtime
// arguments and the container would exit and restart forever; its entrypoint itself must idle.
const agentKeepalive = services['agent-image-keepalive'];
requireBoundary(
  JSON.stringify(agentKeepalive.entrypoint) === JSON.stringify(['/sbin/tini', '--', 'sleep', 'infinity']) && !agentKeepalive.command?.length,
  'agent image keepalive must replace the agent runtime entrypoint with an idle sleep'
);
requireBoundary(
  JSON.stringify(services['executor-image-keepalive'].command) === JSON.stringify(['sleep', 'infinity']) && !services['executor-image-keepalive'].entrypoint,
  'executor image keepalive must idle under the executor tini entrypoint'
);
for (const name of ['executor-image-keepalive', 'agent-image-keepalive']) {
  const keepalive = services[name];
  requireBoundary(
    keepalive.read_only === true &&
      keepalive.network_mode === 'none' &&
      sameNames(keepalive.cap_drop ?? [], ['ALL']) &&
      (keepalive.security_opt ?? []).includes('no-new-privileges:true') &&
      keepalive.user === '10001:10001' &&
      !keepalive.volumes?.length &&
      !keepalive.ports?.length &&
      !Object.keys(keepalive.environment ?? {}).length,
    `${name} must stay an unprivileged, offline, mount-free idle holder`
  );
}

const published = services.ingress.ports ?? [];
requireBoundary(published.length === 1, 'ingress must publish exactly one port');
requireBoundary(published[0].host_ip === '127.0.0.1' && Number(published[0].target) === 3100, 'ingress must bind only loopback port 3100');
requireBoundary(!services['provisioning-proxy'].ports?.length, 'provisioning-proxy must not publish a host port');
const ingressEnvironment = Object.keys(services.ingress.environment ?? {});
requireBoundary(!ingressEnvironment.some((name) => /TOKEN|SECRET|PASSWORD|GITHUB_APP/.test(name)), 'ingress must not receive secret variables');

const runnerMounts = services.runner.volumes ?? [];
requireBoundary(runnerMounts.some((mount) => mount.source === '/var/run/docker.sock' && mount.target === '/var/run/docker.sock'), 'runner Docker socket mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.target === '/var/lib/cloud-harness/artifacts'), 'runner artifact persistence mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.target === '/var/lib/cloud-harness/cache/repos'), 'runner repo cache persistence mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.target === '/var/lib/cloud-harness/cache/toolkits'), 'runner toolkit cache persistence mount is missing');
requireBoundary(!runnerMounts.some((mount) => /model-gateway|provider-api-key/u.test(`${mount.source}:${mount.target}`)), 'runner must not receive model gateway secrets');
requireBoundary(!runnerMounts.some((mount) => mount.source.includes('cloud-harness-model-gateway')), 'runner must not mount model gateway secret directory');
const packagesMount = runnerMounts.find((mount) => mount.target === '/var/lib/cloud-harness/packages');
requireBoundary(packagesMount?.source === '/var/lib/cloud-harness/packages' && packagesMount.read_only !== true, 'runner managed-toolbox packages mount is missing or its host path differs from the runner path');
requireBoundary(Object.entries(services).every(([name, service]) => name === 'runner' || !(service.volumes ?? []).some((mount) => mount.target.includes('/packages') || String(mount.source ?? '').includes('/cloud-harness/packages'))), 'only the runner may mount the managed-toolbox packages root');

// The provisioning proxy gets only its own static settings, never the runtime env file, and its default
// allow-list reaches no package registry: npm and PyPI egress is an explicit operator opt-in.
const proxy = services['provisioning-proxy'];
requireBoundary(sameNames(environmentNames(proxy), ['ALLOWED_HOSTS', 'PROVISIONING_PROXY_HOST', 'PROVISIONING_PROXY_PORT']), 'provisioning-proxy environment allowlist changed');
const defaultProxyHosts = String(proxy.environment.ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
requireBoundary(defaultProxyHosts.length > 0, 'provisioning-proxy default allow-list is empty');
requireBoundary(!defaultProxyHosts.some((host) => /npmjs|yarnpkg|pypi|pythonhosted/u.test(host)), 'provisioning-proxy default allow-list must not contain an npm or PyPI host');

// Compose drops env_file from rendered output, so the env-file boundary is checked on the source files.
// Later files override earlier ones per service, as Compose merges them.
const rawServices = {};
for (const file of ['compose.yaml', 'compose.production.yaml']) {
  for (const [name, service] of Object.entries(parseYaml(readFileSync(file, 'utf8')).services ?? {})) {
    rawServices[name] = { ...rawServices[name], ...service };
  }
}
const envFileEntries = (service) => {
  const entries = service.env_file ?? [];
  return Array.isArray(entries) ? entries : [entries];
};
const envFilePaths = (service) => envFileEntries(service).map((entry) => (typeof entry === 'string' ? entry : entry.path));
const proxyEnvFiles = envFileEntries(rawServices['provisioning-proxy']);
requireBoundary(proxyEnvFiles.length === 1 && proxyEnvFiles[0].required === false, 'provisioning-proxy must have exactly one optional env file');
const proxyEnvFile = envFilePaths(rawServices['provisioning-proxy'])[0];
requireBoundary(proxyEnvFile.includes('${PROVISIONING_PROXY_ENV_FILE:-/etc/cloud-harness-mcp/provisioning-proxy.env}'), 'provisioning-proxy env file must be the dedicated provisioning-proxy.env');
requireBoundary(!/CLOUD_HARNESS_ENV_FILE|runtime\.env/u.test(proxyEnvFile), 'provisioning-proxy must not receive the runtime env file');
for (const name of ['api', 'runner']) {
  requireBoundary(!envFilePaths(rawServices[name]).includes(proxyEnvFile), `${name} must not share the provisioning-proxy env file`);
}

for (const name of ['SECRET_KEYRING', 'SECRET_KEYRING_FILE', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE', 'CLOUDFLARE_ACCESS_API_TOKEN', 'CLOUDFLARE_ACCESS_API_TOKEN_FILE']) {
  requireBoundary(!services.api.environment?.[name], `API must not receive ${name}`);
}
// The Managed OAuth control-plane token is runner-only: the API must blank it so a
// shared env file cannot leak it, and nothing else may name it at all.
requireBoundary('CLOUDFLARE_ACCESS_API_TOKEN' in (services.api.environment ?? {}) && 'CLOUDFLARE_ACCESS_API_TOKEN_FILE' in (services.api.environment ?? {}), 'API must explicitly blank the Cloudflare Access API token');
for (const [serviceName, service] of Object.entries(services)) {
  if (serviceName === 'runner' || serviceName === 'api') continue;
  requireBoundary(!Object.keys(service.environment ?? {}).some((name) => name.startsWith('CLOUDFLARE_ACCESS_API_TOKEN')), `${serviceName} must not receive the Cloudflare Access API token`);
}
// The Dashboard webchat gateway token and signing secret are api-only. The runner shares the
// runtime env file, so it must blank them explicitly; no other service may name them at all.
const deweeSecretNames = ['DEWEE_GATEWAY_TOKEN', 'DEWEE_GATEWAY_TOKEN_FILE', 'DEWEE_WEBCHAT_SECRET', 'DEWEE_WEBCHAT_SECRET_FILE'];
for (const name of deweeSecretNames) {
  requireBoundary(name in (services.runner.environment ?? {}) && services.runner.environment[name] === '', `runner must explicitly blank ${name}`);
}
for (const [serviceName, service] of Object.entries(services)) {
  if (serviceName === 'runner' || serviceName === 'api') continue;
  requireBoundary(!Object.keys(service.environment ?? {}).some((name) => name.startsWith('DEWEE_')), `${serviceName} must not receive Dewee webchat settings`);
}
for (const service of ['api', 'runner', 'ingress']) {
  for (const name of ['MCP_CANARY_URL', 'MCP_CANARY_ACCESS_CLIENT_ID', 'MCP_CANARY_ACCESS_CLIENT_SECRET']) {
    requireBoundary(!services[service].environment?.[name], `${service} must not receive ${name}`);
  }
}

const tunnelResult = spawnSync('docker', [
  'compose', '-f', 'compose.yaml', '-f', 'compose.production.yaml', '-f', 'deploy/cloudflare-tunnel/compose.tunnel.yaml', 'config', '--format', 'json'
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, CLOUD_HARNESS_ENV_FILE: '.env.example', CLOUDFLARE_TUNNEL_TOKEN: 'dummy-token' }
});

if (tunnelResult.status !== 0) throw new Error(tunnelResult.stderr || 'tunnel Compose config failed');
const tunnelConfig = JSON.parse(tunnelResult.stdout);
const tunnelServices = tunnelConfig.services;
requireBoundary(Boolean(tunnelServices.cloudflared), 'tunnel Compose must declare cloudflared service');
requireBoundary(!tunnelServices.cloudflared.ports?.length, 'cloudflared must not publish host ports');
requireBoundary(!tunnelServices.cloudflared.volumes?.length, 'cloudflared must not receive host mounts');
requireBoundary(JSON.stringify(networkNames(tunnelServices.cloudflared)) === JSON.stringify(['ingress']), 'cloudflared must attach only to the ingress network');
requireBoundary(tunnelConfig.networks.ingress.internal !== true, 'ingress network must remain routable for tunnel');

const nginx = readFileSync('deploy/nginx/cloud-harness-mcp.conf', 'utf8');
const locationBlock = (pattern) => nginx.match(pattern)?.[0] ?? '';
const dashboardEntry = locationBlock(/location = \/dashboard \{[^}]+\}/s);
const dashboardPrefix = locationBlock(/location \^~ \/dashboard\/ \{[^}]+\}/s);
const mcp = locationBlock(/location = \/mcp \{[^}]+\}/s);
const gatewayMcp = locationBlock(/location = \/mcp-gateway \{[^}]+\}/s);
const apiKeyMcp = locationBlock(/location = \/mcp-api-key \{[^}]+\}/s);
const apiKeyGatewayMcp = locationBlock(/location = \/mcp-api-key\/gateway \{[^}]+\}/s);
const workspaceMcp = locationBlock(/location \^~ \/mcp\/workspaces\/ \{[^}]+\}/s);
requireBoundary(dashboardEntry.includes('proxy_pass http://127.0.0.1:3100/dashboard;'), 'nginx dashboard entry point must preserve its upstream path');
requireBoundary(dashboardPrefix.includes('proxy_pass http://127.0.0.1:3100/dashboard/;'), 'nginx dashboard prefix must preserve asset and BFF paths');
for (const directive of ['proxy_http_version 1.1;', 'proxy_buffering off;', 'proxy_request_buffering off;', 'proxy_read_timeout 3600s;']) {
  requireBoundary(mcp.includes(directive), `nginx MCP streaming directive is missing: ${directive}`);
  requireBoundary(gatewayMcp.includes(directive), `nginx MCP gateway streaming directive is missing: ${directive}`);
  requireBoundary(apiKeyMcp.includes(directive), `nginx API-key MCP streaming directive is missing: ${directive}`);
  requireBoundary(apiKeyGatewayMcp.includes(directive), `nginx API-key MCP gateway streaming directive is missing: ${directive}`);
  requireBoundary(workspaceMcp.includes(directive), `nginx workspace MCP streaming directive is missing: ${directive}`);
}
requireBoundary(workspaceMcp.includes('proxy_pass http://127.0.0.1:3100/mcp/workspaces/;'), 'nginx workspace MCP route must preserve its upstream path');
requireBoundary(gatewayMcp.includes('proxy_pass http://127.0.0.1:3100/mcp-gateway;'), 'nginx MCP gateway route must preserve its upstream path');
requireBoundary(apiKeyMcp.includes('proxy_pass http://127.0.0.1:3100/mcp-api-key;'), 'nginx API-key MCP route must preserve its hidden upstream path');
requireBoundary(
  apiKeyGatewayMcp.includes('proxy_pass http://127.0.0.1:3100/mcp-api-key/gateway;'),
  'nginx API-key MCP gateway route must preserve its hidden upstream path under the API-key Access scope'
);

const oauthCallback = locationBlock(/location = \/dashboard\/mcp-oauth\/callback \{[^}]+\}/s);
requireBoundary(
  oauthCallback.includes('access_log off;') && oauthCallback.includes('proxy_pass http://127.0.0.1:3100/dashboard/mcp-oauth/callback;'),
  'nginx MCP OAuth callback route must keep its one-time code and state out of the access log'
);

const webhookIngress = locationBlock(/location \^~ \/integrations\/webhooks\/ \{[^}]+\}/s);
requireBoundary(
  webhookIngress.includes('client_max_body_size 1m;') && webhookIngress.includes('proxy_pass http://127.0.0.1:3100/integrations/webhooks/;'),
  'nginx automation webhook route must preserve its upstream path and 1m body cap'
);

const nginxUpgrade = readFileSync('deploy/scripts/upgrade-nginx-dashboard.sh', 'utf8');
requireBoundary(
  nginxUpgrade.includes('dashboard_installed -eq 1 && $api_key_installed -eq 1 && $gateway_installed -eq 1'),
  'nginx upgrade must not return early until dashboard, API-key, and gateway routes are installed'
);
requireBoundary(
  nginxUpgrade.includes('location = /mcp-api-key {') &&
    nginxUpgrade.includes('proxy_pass http://127.0.0.1:3100/mcp-api-key;') &&
    nginxUpgrade.includes('add_api_key="$((1 - api_key_installed))"'),
  'nginx upgrade must install the hidden API-key route when it is absent'
);
requireBoundary(
  nginxUpgrade.includes('location = /mcp-gateway {') &&
    nginxUpgrade.includes('proxy_pass http://127.0.0.1:3100/mcp-gateway;') &&
    nginxUpgrade.includes('add_gateway="$((1 - gateway_installed))"') &&
    nginxUpgrade.includes('gateway_installed -eq 0'),
  'nginx upgrade must install the MCP gateway route when it is absent'
);
requireBoundary(
  nginxUpgrade.includes('location = /mcp-api-key/gateway {') &&
    nginxUpgrade.includes('proxy_pass http://127.0.0.1:3100/mcp-api-key/gateway;') &&
    nginxUpgrade.includes('add_api_key_gateway="$((1 - api_key_gateway_installed))"') &&
    nginxUpgrade.includes('$api_key_gateway_installed -eq 1 && $oauth_callback_installed -eq 1 && $webhook_installed -eq 1 ]]'),
  'nginx upgrade must install the hidden API-key MCP gateway route when it is absent'
);
requireBoundary(
  nginxUpgrade.includes('location ^~ /integrations/webhooks/ {') &&
    nginxUpgrade.includes('add_webhook="$((1 - webhook_installed))"') &&
    nginxUpgrade.includes('webhook_installed -eq 0'),
  'nginx upgrade must install the automation webhook route when it is absent'
);
requireBoundary(
  nginxUpgrade.includes('location = /dashboard/mcp-oauth/callback {') &&
    nginxUpgrade.includes('add_oauth_callback="$((1 - oauth_callback_installed))"'),
  'nginx upgrade must install the access-log-free MCP OAuth callback route when it is absent'
);
requireBoundary(
  nginxUpgrade.includes('location ^~ /mcp/workspaces/ {') &&
    nginxUpgrade.includes('proxy_pass http://127.0.0.1:3100/mcp/workspaces/;') &&
    nginxUpgrade.includes('add_workspace="$((1 - workspace_installed))"') &&
    nginxUpgrade.includes('$gateway_installed -eq 1 && $workspace_installed -eq 1'),
  'nginx upgrade must install the workspace MCP route when it is absent'
);
console.log('compose-boundaries=pass');
