import { spawnSync } from 'node:child_process';

const result = spawnSync('docker', [
  'compose', '--profile', 'gateway-test', '-f', 'compose.yaml', '-f', 'compose.production.yaml', 'config', '--format', 'json'
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, CLOUD_HARNESS_ENV_FILE: '.env.example' }
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

for (const [name, service] of Object.entries(services)) {
  if (name === 'ingress') continue;
  requireBoundary(!service.ports?.length, `${name} must not publish a host port`);
}
const published = services.ingress.ports ?? [];
requireBoundary(published.length === 1, 'ingress must publish exactly one port');
requireBoundary(published[0].host_ip === '127.0.0.1' && Number(published[0].target) === 3100, 'ingress must bind only loopback port 3100');

requireBoundary(!services.api.volumes?.length, 'API must not receive host mounts');
requireBoundary(!services.ingress.volumes?.length, 'ingress must not receive host mounts');
requireBoundary(sameNames(networkNames(services.api), ['control', 'frontend']), 'API network boundary changed');
requireBoundary(sameNames(networkNames(services.runner), ['control', 'runner-egress']), 'runner network boundary changed');
requireBoundary(sameNames(networkNames(services.ingress), ['frontend', 'ingress']), 'ingress network boundary changed');
requireBoundary(networks.control.internal === true && networks.frontend.internal === true, 'private networks must remain internal');
requireBoundary(networks.ingress.internal !== true && networks['runner-egress'].internal !== true, 'ingress and runner egress must remain routable');

const gateway = services['model-gateway'];
requireBoundary(gateway.read_only === true, 'model gateway filesystem must be read-only');
requireBoundary(sameNames(networkNames(gateway), ['provider-egress']), 'model gateway may join only provider-egress statically');
requireBoundary(networks['provider-egress'].internal !== true, 'provider-egress must remain separately routable');
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
  'MODEL_GATEWAY_PROFILES_FILE'
]), 'model gateway environment allowlist changed');
requireBoundary(gateway.environment.MODEL_GATEWAY_MODE === 'production', 'production gateway must force production profile validation');

for (const serviceName of ['api', 'runner', 'ingress']) {
  const names = environmentNames(services[serviceName]);
  requireBoundary(!names.some((name) => /^MODEL_GATEWAY_|PROVIDER_|.*(?:API_KEY|SECRET)$/u.test(name)), `${serviceName} must not receive gateway/provider environment`);
}
const ingressEnvironment = environmentNames(services.ingress);
requireBoundary(!ingressEnvironment.some((name) => /TOKEN|SECRET|PASSWORD|GITHUB_APP/u.test(name)), 'ingress must not receive secret variables');

const runnerMounts = services.runner.volumes ?? [];
requireBoundary(runnerMounts.some((mount) => mount.source === '/var/run/docker.sock' && mount.target === '/var/run/docker.sock'), 'runner Docker socket mount is missing');
requireBoundary(runnerMounts.some((mount) => mount.source === '/etc/cloud-harness-mcp/github-app-private-key.pem' && mount.target === '/run/cloud-harness-secrets/github-app-private-key.pem' && mount.read_only === true), 'runner GitHub key must be one exact read-only file');
requireBoundary(!runnerMounts.some((mount) => mount.source === '/etc/cloud-harness-mcp' || mount.target === '/run/cloud-harness-secrets'), 'runner must not mount a secret directory');
requireBoundary(!runnerMounts.some((mount) => /model-gateway|provider-api-key/u.test(`${mount.source}:${mount.target}`)), 'runner must not receive model gateway secrets');

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

console.log('compose-boundaries=pass');
