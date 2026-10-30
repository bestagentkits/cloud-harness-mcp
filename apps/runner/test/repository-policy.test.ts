import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import type * as DnsPromises from 'node:dns/promises';
import type { RunnerConfig } from '@cloud-harness/contracts';
import { mintRepositoryToken } from '../src/github-app-broker.js';
import { validateRepositoryUrl } from '../src/repository-policy.js';

// Hostnames resolve through the real resolver unless a test sets an answer, so DNS-dependent cases are deterministic.
const dns = vi.hoisted(() => ({ answer: undefined as LookupAddress[] | undefined }));
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof DnsPromises>();
  return {
    ...actual,
    lookup: async (hostname: string, options: LookupAllOptions) => dns.answer ?? actual.lookup(hostname, options)
  };
});

const baseConfig: RunnerConfig = {
  host: '127.0.0.1',
  port: 3001,
  serviceToken: 'runner-test-token-that-is-longer-than-32-characters',
  jobsRoot: '/tmp/jobs',
  stateDb: '/tmp/state.db',
  executorImage: 'cloud-harness-executor:local',
  allowedGitHosts: ['github.com'],
  networkProfile: 'network-none',
  wallTtlSeconds: 300,
  idleTtlSeconds: 180,
  maxOutputBytes: 262_144,
  minFreeBytes: 104_857_600,
  maxWorkspaceBytes: 536_870_912,
  reaperIntervalSeconds: 30
};

describe('repository URL policy', () => {
  afterEach(() => {
    dns.answer = undefined;
  });

  it.each([
    ['a private IPv4 address', [{ address: '10.0.0.5', family: 4 }]],
    ['the IPv4 loopback address', [{ address: '127.0.0.1', family: 4 }]],
    ['the cloud metadata link-local address', [{ address: '169.254.169.254', family: 4 }]],
    ['the IPv6 loopback address', [{ address: '::1', family: 6 }]],
    ['an IPv4-mapped private address', [{ address: '::ffff:10.0.0.5', family: 6 }]],
    ['an IPv4-mapped loopback address in hex form', [{ address: '::ffff:7f00:1', family: 6 }]],
    ['an IPv4-mapped metadata address', [{ address: '::ffff:169.254.169.254', family: 6 }]],
    ['a fully written IPv4-mapped private address', [{ address: '0:0:0:0:0:ffff:c0a8:0101', family: 6 }]],
    ['a public address alongside a private one', [{ address: '140.82.112.3', family: 4 }, { address: '10.0.0.5', family: 4 }]]
  ])('refuses an allowlisted host that DNS resolves to %s', async (_label, answer) => {
    dns.answer = answer;

    await expect(validateRepositoryUrl('https://github.com/owner/repo.git', ['github.com'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['all public', [{ address: '140.82.112.3', family: 4 }]],
    ['an IPv4-mapped public address', [{ address: '::ffff:140.82.112.3', family: 6 }]],
    ['a DNS64-synthesized public address', [{ address: '64:ff9b::8c52:7003', family: 6 }]]
  ])('accepts an allowlisted host whose resolved addresses are %s', async (_label, answer) => {
    dns.answer = answer;

    const url = await validateRepositoryUrl('https://github.com/owner/repo.git', ['github.com']);

    expect(url.href).toBe('https://github.com/owner/repo.git');
  });

  it('rejects local, credentialed, non-HTTPS, and non-allowlisted repositories', async () => {
    await expect(validateRepositoryUrl('file:///etc/passwd', ['github.com'])).rejects.toThrow();
    await expect(validateRepositoryUrl('https://token@github.com/owner/repo.git', ['github.com'])).rejects.toThrow();
    await expect(validateRepositoryUrl('https://127.0.0.1/repo.git', ['127.0.0.1'])).rejects.toThrow();
    await expect(validateRepositoryUrl('https://example.com/repo.git', ['github.com'])).rejects.toThrow();
  });

  it('does not mint credentials unless the optional GitHub App broker is configured', async () => {
    await expect(mintRepositoryToken(baseConfig, new URL('https://github.com/owner/repo.git'))).resolves.toBeUndefined();
  });

  it('rejects ambiguous GitHub repository paths before contacting the broker', async () => {
    const config: RunnerConfig = {
      ...baseConfig,
      githubApp: { appId: '1', installationId: '2', privateKey: 'not-used' }
    };
    await expect(mintRepositoryToken(config, new URL('https://github.com/owner/repo/extra.git'))).rejects.toThrow(
      'GitHub repository URL must identify one owner and repository'
    );
  });
});
