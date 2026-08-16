import { spawnSync } from 'node:child_process';

const result = spawnSync('docker', [
  'compose', '-f', 'compose.yaml', '-f', 'compose.production.yaml', 'config', '--format', 'json'
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

requireBoundary(!services.api.ports?.length, 'API must not publish a host port');
requireBoundary(!services.runner.ports?.length, 'runner must not publish a host port');
requireBoundary(!services.api.volumes?.length, 'API must not receive host mounts');
requireBoundary(!services.ingress.volumes?.length, 'ingress must not receive host mounts');
requireBoundary(JSON.stringify(networkNames(services.api)) === JSON.stringify(['control', 'frontend']), 'API network boundary changed');
requireBoundary(JSON.stringify(networkNames(services.runner)) === JSON.stringify(['control', 'runner-egress']), 'runner network boundary changed');
requireBoundary(JSON.stringify(networkNames(services.ingress)) === JSON.stringify(['frontend', 'ingress']), 'ingress network boundary changed');
requireBoundary(networks.control.internal === true && networks.frontend.internal === true, 'private networks must remain internal');
requireBoundary(networks.ingress.internal !== true && networks['runner-egress'].internal !== true, 'gateway networks must remain routable');

const published = services.ingress.ports ?? [];
requireBoundary(published.length === 1, 'ingress must publish exactly one port');
requireBoundary(published[0].host_ip === '127.0.0.1' && Number(published[0].target) === 3100, 'ingress must bind only loopback port 3100');
const ingressEnvironment = Object.keys(services.ingress.environment ?? {});
requireBoundary(!ingressEnvironment.some((name) => /TOKEN|SECRET|PASSWORD|GITHUB_APP/.test(name)), 'ingress must not receive secret variables');

const runnerMounts = services.runner.volumes ?? [];
requireBoundary(runnerMounts.some((mount) => mount.source === '/var/run/docker.sock' && mount.target === '/var/run/docker.sock'), 'runner Docker socket mount is missing');
console.log('compose-boundaries=pass');
