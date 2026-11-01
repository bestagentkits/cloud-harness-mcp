import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Writes the image manifest a hosting platform reads to run Cloud Harness against a remote Docker
 * host: every image pinned by registry digest, the local tags the runner starts containers by (it
 * runs them with `--pull never`), and the system containers and networks that live inside that
 * Docker daemon. The API, ingress and runner run beside the daemon, not inside it.
 */

/** Built images: manifest key, Dockerfile, and the local tag the runner or Compose names it by. */
export const IMAGES = [
  { key: 'api', dockerfile: 'docker/api.Dockerfile', localTag: 'cloud-harness-api:local' },
  { key: 'runner', dockerfile: 'docker/runner.Dockerfile', localTag: 'cloud-harness-runner:local' },
  { key: 'model-gateway', dockerfile: 'docker/model-gateway.Dockerfile', localTag: 'cloud-harness-model-gateway:local' },
  { key: 'executor', dockerfile: 'docker/executor.Dockerfile', localTag: 'cloud-harness-executor:local' },
  { key: 'agent', dockerfile: 'docker/agent.Dockerfile', localTag: 'cloud-harness-agent:local' },
  { key: 'network-guard', dockerfile: 'docker/network-guard.Dockerfile', localTag: 'cloud-harness-network-guard:local' }
];

/** Images the Docker host must hold under their local tag; api and runner run outside it. */
const DOCKER_HOST_IMAGES = ['model-gateway', 'executor', 'agent', 'network-guard', 'api'];

const PROVISIONING_NETWORK = 'cloud-harness-mcp_provisioning';
const PROXY_EGRESS_NETWORK = 'cloud-harness-mcp_runner-egress';
const PROVIDER_EGRESS_NETWORK = 'cloud-harness-mcp_provider-egress';
const MODEL_GATEWAY_CONTAINER = 'cloudharness-model-gateway';
const PROVISIONING_PROXY_CONTAINER = 'cloudharness-provisioning-proxy';
const PROVISIONING_PROXY_ALLOWED_HOSTS = 'github.com,agentkit.best,releases.agentkit.best,api.github.com,objects.githubusercontent.com,skillx.sh';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

/** `docker.io/digitop` + `api` -> `docker.io/digitop/cloudharness-api`. */
export function imageRepository(registry, key) {
  return `${registry}/cloudharness-${key}`;
}

const hardening = {
  readOnly: true,
  capDrop: ['ALL'],
  securityOpt: ['no-new-privileges:true']
};

function systemContainers() {
  return [
    {
      name: MODEL_GATEWAY_CONTAINER,
      image: 'model-gateway',
      env: {
        MODEL_GATEWAY_MODE: 'production',
        MODEL_GATEWAY_HOST: '0.0.0.0',
        MODEL_GATEWAY_PORT: '3210',
        MODEL_GATEWAY_PROFILES_FILE: '/run/model-gateway-config/profiles.json',
        MODEL_GATEWAY_CONTROL_SOCKET: '/tmp/model-gateway-control.sock'
      },
      mounts: [
        { purpose: 'model-gateway-profiles', target: '/run/model-gateway-config/profiles.json', readOnly: true },
        { purpose: 'provider-api-key', target: '/run/model-gateway-secrets/provider-api-key', readOnly: true }
      ],
      tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=8m,mode=0700,uid=1000,gid=1000' },
      ...hardening,
      networks: [{ name: PROVIDER_EGRESS_NETWORK }],
      healthcheck: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3210/healthz').then(r=>{if(!r.ok)process.exit(1)})"]
    },
    {
      name: PROVISIONING_PROXY_CONTAINER,
      image: 'api',
      command: ['node', '/app/deploy/provisioning-proxy.mjs'],
      env: {
        PROVISIONING_PROXY_HOST: '0.0.0.0',
        PROVISIONING_PROXY_PORT: '3128',
        ALLOWED_HOSTS: PROVISIONING_PROXY_ALLOWED_HOSTS
      },
      mounts: [],
      tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=8m' },
      ...hardening,
      networks: [{ name: PROVISIONING_NETWORK, aliases: ['provisioning-proxy'] }, { name: PROXY_EGRESS_NETWORK }]
    }
  ];
}

/** Processes that run next to the Docker host and reach it through `DOCKER_HOST`. */
function services() {
  return {
    api: { image: 'api', command: ['node', 'apps/api/dist/index.js'], env: { API_HOST: '127.0.0.1', API_PORT: '3000', RUNNER_URL: 'http://127.0.0.1:3001', AUTH_MODE: 'oidc' } },
    ingress: { image: 'api', command: ['node', '/app/deploy/ingress-proxy.mjs'], env: { INGRESS_HOST: '0.0.0.0', INGRESS_PORT: '3100', API_UPSTREAM_HOST: '127.0.0.1', API_UPSTREAM_PORT: '3000' } },
    runner: {
      image: 'runner',
      env: {
        RUNNER_HOST: '127.0.0.1',
        RUNNER_PORT: '3001',
        DOCKER_HOST: 'unix:///var/run/tose-docker/docker.sock',
        AUTH_MODE: 'oidc',
        DOCKER_ON_DEMAND: 'true',
        // Internal networks and the dependency-access firewall rely on iptables, which the hosted
        // Docker daemon (--iptables=false) does not provide until that isolation is verified.
        WORKSPACE_NETWORK_PROFILE: 'network-none',
        AGENT_GATEWAY_CONTAINER: MODEL_GATEWAY_CONTAINER,
        AGENT_GATEWAY_URL: 'http://model-gateway:3210',
        PROVISIONING_NETWORK,
        TOOLKIT_EGRESS_PROXY: 'http://provisioning-proxy:3128'
      }
    }
  };
}

/**
 * Builds the manifest. `digests` maps every key in IMAGES to the registry digest of the pushed image;
 * anything missing, extra or malformed is refused so a partial release is never published.
 */
export function buildToseManifest({ registry, version, commit, repository, digests }) {
  if (typeof registry !== 'string' || !REPOSITORY_PATTERN.test(registry)) throw new Error(`invalid image registry namespace: ${registry}`);
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error(`invalid release version: ${version}`);
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) throw new Error(`invalid commit SHA: ${commit}`);
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`invalid source repository: ${repository}`);
  const known = new Set(IMAGES.map((image) => image.key));
  for (const key of Object.keys(digests)) {
    if (!known.has(key)) throw new Error(`unknown image: ${key}`);
  }
  const images = {};
  for (const { key } of IMAGES) {
    const digest = digests[key];
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) throw new Error(`missing or invalid digest for ${key}`);
    images[key] = `${imageRepository(registry, key)}@${digest}`;
  }
  const localTags = {};
  for (const { key, localTag } of IMAGES) {
    if (DOCKER_HOST_IMAGES.includes(key)) localTags[localTag] = key;
  }
  return {
    schemaVersion: 1,
    source: { repository, version, commit },
    images,
    localTags,
    networks: {
      [PROVISIONING_NETWORK]: { driver: 'bridge', internal: true },
      [PROXY_EGRESS_NETWORK]: { driver: 'bridge', internal: false },
      [PROVIDER_EGRESS_NETWORK]: { driver: 'bridge', internal: false }
    },
    systemContainers: systemContainers(),
    services: services()
  };
}

function parseDigestArguments(values) {
  const digests = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) throw new Error(`--digest expects <image>=sha256:<hex>, got: ${value}`);
    const key = value.slice(0, separator);
    if (Object.hasOwn(digests, key)) throw new Error(`duplicate digest for ${key}`);
    digests[key] = value.slice(separator + 1);
  }
  return digests;
}

function main() {
  const { values } = parseArgs({
    options: {
      registry: { type: 'string', default: 'docker.io/digitop' },
      version: { type: 'string' },
      commit: { type: 'string' },
      repository: { type: 'string', default: 'bestagentkits/cloud-harness-mcp' },
      digest: { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: 'deploy/tose/manifest.json' }
    },
    strict: true
  });
  const manifest = buildToseManifest({
    registry: values.registry,
    version: values.version,
    commit: values.commit,
    repository: values.repository,
    digests: parseDigestArguments(values.digest)
  });
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
