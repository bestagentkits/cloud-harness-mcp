import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const composeFile = fileURLToPath(new URL('../compose.yaml', import.meta.url));

export type GatewayTestStack = {
  project: string;
  gatewayContainer: string;
  providerContainer: string;
};

export function dockerPrerequisiteIssue(images: readonly string[]): string | undefined {
  const probes = [
    ['info'],
    ['compose', 'version'],
    ...images.map((image) => ['image', 'inspect', image])
  ];
  for (const args of probes) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15_000 });
    if (result.status !== 0) return `docker ${args.join(' ')} is unavailable`;
  }
  return undefined;
}

export function dockerGithubNetworkIssue(image: string): string | undefined {
  const probe = [
    'run', '--rm', '--pull', 'never', '--network', 'bridge', '--entrypoint', 'node', image, '-e',
    `const https=require('node:https');const r=https.get('https://github.com/bestagentkits/cloud-harness-mcp.git/info/refs?service=git-upload-pack',()=>process.exit(0));r.setTimeout(10000,()=>r.destroy(new Error('timeout')));r.on('error',()=>process.exit(1));`
  ];
  const result = spawnSync('docker', probe, { encoding: 'utf8', timeout: 15_000 });
  return result.status === 0 ? undefined : 'Docker bridge networking cannot reach the public Git fixture';
}

export function requireDockerPrerequisites(issue: string | undefined): void {
  if (issue !== undefined && process.env.CLOUD_HARNESS_REQUIRE_DOCKER_TESTS === '1') {
    throw new Error(`required Docker test prerequisite failed: ${issue}`);
  }
}

export function startGatewayTestStack(prefix: string): GatewayTestStack {
  const fixtureKey = resolve(process.cwd(), '.cloud-harness-test-fixtures', 'model-gateway', 'provider-api-key');
  if (!existsSync(fixtureKey)) {
    const generatorScript = resolve(process.cwd(), 'scripts', 'generate-model-gateway-test-fixtures.mjs');
    execFileSync('node', [generatorScript], { stdio: 'inherit' });
  }
  const project = `${prefix}-${randomBytes(6).toString('hex')}`;
  let gatewayContainer = '';
  let providerContainer = '';
  try {
    compose(project, ['--profile', 'gateway-test', 'up', '--detach', '--no-build', 'fake-provider', 'model-gateway-test']);
    gatewayContainer = compose(project, ['ps', '--quiet', 'model-gateway-test']).trim();
    providerContainer = compose(project, ['ps', '--quiet', 'fake-provider']).trim();
    if (!gatewayContainer || !providerContainer) throw new Error('gateway test profile did not create both containers');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = spawnSync('docker', [
        'exec', gatewayContainer, 'node', '-e',
        "fetch('http://127.0.0.1:3210/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      ], { stdio: 'ignore', timeout: 5_000 });
      if (ready.status === 0) return { project, gatewayContainer, providerContainer };
      sleep(200);
    }
    throw new Error('model gateway test container did not become ready');
  } catch (error) {
    stopGatewayTestStack({ project, gatewayContainer, providerContainer });
    throw error;
  }
}

export function stopGatewayTestStack(stack: GatewayTestStack): void {
  compose(stack.project, ['--profile', 'gateway-test', 'down', '--volumes', '--remove-orphans', '--timeout', '5'], true);
}

export function dockerLogs(container: string): string {
  const result = spawnSync('docker', ['logs', container], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export async function waitFor<T>(readValue: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await readValue();
  while (!accept(value) && Date.now() < deadline) {
    await delay(100);
    value = await readValue();
  }
  if (!accept(value)) throw new Error(`condition was not met within ${timeoutMs}ms`);
  return value;
}

function compose(project: string, args: string[], ignoreFailure = false): string {
  try {
    return execFileSync('docker', ['compose', '--file', composeFile, '--project-name', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', ignoreFailure ? 'ignore' : 'pipe'],
      timeout: 60_000,
      env: {
        ...process.env,
        CLOUD_HARNESS_ENV_FILE: process.env.CLOUD_HARNESS_ENV_FILE ?? resolve(process.cwd(), '.env.example')
      }
    });
  } catch (error) {
    if (ignoreFailure) return '';
    throw error;
  }
}

// Polls real Docker service readiness; fake timers cannot drive external container state.
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function sleep(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}
