import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildToseManifest, IMAGES } from '../scripts/build-tose-manifest.mjs';

type ImageEntry = { key: string; dockerfile: string; localTag: string };
type Manifest = {
  images: Record<string, string>;
  localTags: Record<string, string>;
  networks: Record<string, { internal: boolean }>;
  systemContainers: Array<{ name: string; image: string; networks: Array<{ name: string }> }>;
  services: Record<string, { image: string }>;
};

const script = resolve(import.meta.dirname, '../scripts/build-tose-manifest.mjs');
const commit = 'a'.repeat(40);
const imageKeys = (IMAGES as ImageEntry[]).map((image) => image.key);
const digestFor = (index: number) => `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`;
const digests = Object.fromEntries(imageKeys.map((key, index) => [key, digestFor(index)]));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function build(overrides: Record<string, unknown> = {}): Manifest {
  return buildToseManifest({ registry: 'docker.io/digitop', version: '1.2.3', commit, repository: 'bestagentkits/cloud-harness-mcp', digests, ...overrides }) as Manifest;
}

describe('hosted image manifest', () => {
  it('pins every image by registry digest under the cloudharness repository names', () => {
    const manifest = build();
    expect(Object.keys(manifest.images).sort()).toEqual([...imageKeys].sort());
    for (const [key, reference] of Object.entries(manifest.images)) {
      expect(reference).toMatch(new RegExp(`^docker\\.io/digitop/cloudharness-${key}@sha256:[a-f0-9]{64}$`));
    }
  });

  it('names the local tags the runner starts containers by and only images the Docker host runs', () => {
    const manifest = build();
    expect(manifest.localTags).toEqual({
      'cloud-harness-api:local': 'api',
      'cloud-harness-model-gateway:local': 'model-gateway',
      'cloud-harness-executor:local': 'executor',
      'cloud-harness-agent:local': 'agent',
      'cloud-harness-network-guard:local': 'network-guard'
    });
  });

  it('references only declared images and networks from system containers and services', () => {
    const manifest = build();
    for (const container of manifest.systemContainers) {
      expect(manifest.images).toHaveProperty(container.image);
      for (const network of container.networks) expect(manifest.networks).toHaveProperty(network.name);
    }
    for (const service of Object.values(manifest.services)) expect(manifest.images).toHaveProperty(service.image);
    expect(manifest.systemContainers.map((container) => container.name)).toEqual(['cloudharness-model-gateway', 'cloudharness-provisioning-proxy']);
    expect(manifest.networks['cloud-harness-mcp_provisioning']?.internal).toBe(true);
  });

  it('refuses a missing, malformed or unknown digest so a partial release is never published', () => {
    const missing = Object.fromEntries(Object.entries(digests).filter(([key]) => key !== 'executor'));
    expect(() => build({ digests: missing })).toThrow('missing or invalid digest for executor');
    expect(() => build({ digests: { ...digests, agent: 'latest' } })).toThrow('missing or invalid digest for agent');
    expect(() => build({ digests: { ...digests, ingress: digestFor(9) } })).toThrow('unknown image: ingress');
  });

  it('refuses an invalid version, commit or registry namespace', () => {
    expect(() => build({ version: 'v1.2.3' })).toThrow('invalid release version');
    expect(() => build({ commit: 'abc' })).toThrow('invalid commit SHA');
    expect(() => build({ registry: 'Docker.io/Digitop' })).toThrow('invalid image registry namespace');
  });

  it('writes the manifest from the command line', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ch-tose-manifest-'));
    temporaryDirectories.push(directory);
    const out = join(directory, 'manifest.json');
    const result = spawnSync(process.execPath, [
      script, '--version', '1.2.3', '--commit', commit, '--out', out,
      ...imageKeys.flatMap((key) => ['--digest', `${key}=${digests[key]}`])
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
    expect(Object.values(written.images).every((reference) => reference.includes('@sha256:'))).toBe(true);
  });

  it('exits non-zero without writing when a digest is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ch-tose-manifest-'));
    temporaryDirectories.push(directory);
    const result = spawnSync(process.execPath, [script, '--version', '1.2.3', '--commit', commit, '--out', join(directory, 'manifest.json'), '--digest', `api=${digests.api}`], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing or invalid digest for runner');
  });
});
