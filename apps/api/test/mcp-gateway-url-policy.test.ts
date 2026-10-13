import { describe, expect, it } from 'vitest';
import { ApiConfigSchema } from '@cloud-harness/contracts';
import {
  assertGatewayEndpoint,
  createPinnedLookup,
  isAlwaysBlockedAddress,
  isUnsafeAddress,
  validateGatewayEndpoint,
  type ResolvedAddress
} from '../src/mcp-gateway/url-policy.js';

const publicResolver = async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }];
const baseOptions = { allowInsecureHttp: false, allowPrivateEndpoints: false, resolve: publicResolver };
const privateOptions = { allowInsecureHttp: false, allowPrivateEndpoints: true, resolve: publicResolver };
const insecureOptions = { allowInsecureHttp: true, allowPrivateEndpoints: true, resolve: publicResolver };

async function rejected(rawUrl: string, options = baseOptions): Promise<string> {
  const result = await validateGatewayEndpoint(rawUrl, options);
  expect(result.ok, `${rawUrl} should be rejected`).toBe(false);
  return result.ok ? '' : result.error;
}

async function accepted(rawUrl: string, options = baseOptions): Promise<ResolvedAddress[]> {
  const result = await validateGatewayEndpoint(rawUrl, options);
  expect(result.ok, `${rawUrl} should be accepted`).toBe(true);
  return result.ok ? result.addresses : [];
}

describe('isUnsafeAddress', () => {
  it('blocks the full IPv4 private, loopback, link-local, CGNAT, documentation, and reserved set', () => {
    for (const address of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255'
    ]) {
      expect(isUnsafeAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1']) {
      expect(isUnsafeAddress(address), address).toBe(false);
    }
  });

  it('unwraps IPv4-mapped IPv6 in dotted and hex-word form', () => {
    expect(isUnsafeAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isUnsafeAddress('::ffff:7f00:1')).toBe(true);
    expect(isUnsafeAddress('::ffff:10.0.0.5')).toBe(true);
    expect(isUnsafeAddress('::ffff:a00:5')).toBe(true);
    expect(isUnsafeAddress('::ffff:192.168.1.1')).toBe(true);
    expect(isUnsafeAddress('::ffff:c0a8:101')).toBe(true);
    expect(isUnsafeAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isUnsafeAddress('::ffff:808:808')).toBe(false);
  });

  it('blocks IPv6 loopback, unspecified, ULA, link-local, multicast, and documentation prefixes', () => {
    for (const address of [
      '::',
      '::1',
      'fc00::1',
      'fd00::1',
      'fe80::1',
      'fe80::a9fe:a9fe',
      'ff02::1',
      '2001:db8::1',
      '2001:2::1',
      '100::1'
    ]) {
      expect(isUnsafeAddress(address), address).toBe(true);
    }
    for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2001:1::1']) {
      expect(isUnsafeAddress(address), address).toBe(false);
    }
  });

  it('strips an IPv6 zone id before classifying', () => {
    expect(isUnsafeAddress('fe80::1%eth0')).toBe(true);
    expect(isUnsafeAddress('fe80::1%25eth0')).toBe(true);
    expect(isUnsafeAddress('2606:4700::1111%eth0')).toBe(false);
  });

  it('fails closed for anything that is not a valid IP literal', () => {
    for (const value of ['not-an-ip', '999.1.1.1', '1.2.3', '0x7f000001', '2130706433', '127.0.0.1.nip.io', '']) {
      expect(isUnsafeAddress(value), value).toBe(true);
    }
  });

  it('keeps link-local and metadata addresses blocked even for opted-in private endpoints', () => {
    expect(isAlwaysBlockedAddress('169.254.169.254')).toBe(true);
    expect(isAlwaysBlockedAddress('fe80::a9fe:a9fe')).toBe(true);
    expect(isAlwaysBlockedAddress('127.0.0.1')).toBe(false);
    expect(isAlwaysBlockedAddress('10.0.0.5')).toBe(false);
  });
});

describe('validateGatewayEndpoint', () => {
  it('rejects cleartext, credentials, query, fragment, and non-https schemes', async () => {
    await rejected('http://example.com/mcp');
    await rejected('https://user:pass@example.com/mcp');
    await rejected('https://mcp.example.com/mcp?token=x');
    await rejected('https://mcp.example.com/mcp#frag');
    await rejected('ftp://example.com/x');
    await rejected('https://example.com/mcp\\evil');
    await rejected('https://example.com/%2e%2e/secret');
  });

  it('never echoes a credential, query, or fragment in the rejection message', async () => {
    expect(await rejected('https://user:super-secret@example.com/mcp')).not.toContain('super-secret');
    expect(await rejected('https://mcp.example.com/mcp?token=super-secret')).not.toContain('super-secret');
    expect(await rejected('https://mcp.example.com/mcp#super-secret')).not.toContain('super-secret');
  });

  it('rejects loopback, private, link-local, metadata, and unsafe hostnames', async () => {
    await rejected('https://localhost/mcp');
    await rejected('https://127.0.0.1/mcp');
    await rejected('https://10.0.0.5/mcp');
    await rejected('https://100.64.1.1/mcp');
    await rejected('https://172.16.4.4/mcp');
    await rejected('https://192.168.1.1/mcp');
    await rejected('https://169.254.169.254/latest/meta-data');
    await rejected('https://[::1]/mcp');
    await rejected('https://[::ffff:127.0.0.1]/mcp');
    await rejected('https://[::ffff:7f00:1]/mcp');
    await rejected('https://[fd00::1]/mcp');
    await rejected('https://metadata.google.internal/mcp');
    await rejected('https://mcp.internal/mcp');
    await rejected('https://intranet/mcp');
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    const message = await rejected('https://rebind.example.com/mcp', {
      ...baseOptions,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }]
    });
    expect(message).toContain('private');
  });

  it('rejects a mixed resolution where any address is unsafe', async () => {
    await rejected('https://rebind.example.com/mcp', {
      ...baseOptions,
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 }
      ]
    });
  });

  it('accepts a mapped public IPv6 address and public https endpoints', async () => {
    expect(await accepted('https://[::ffff:8.8.8.8]/mcp')).toEqual([{ address: '::ffff:808:808', family: 6 }]);
    expect(await accepted('https://mcp.example.com/mcp')).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(await accepted('https://example.com:8443/mcp')).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('honours the private-endpoint and insecure-http opt-ins', async () => {
    await rejected('https://127.0.0.1/mcp', baseOptions);
    expect(await accepted('https://127.0.0.1/mcp', privateOptions)).toEqual([{ address: '127.0.0.1', family: 4 }]);
    await rejected('http://127.0.0.1:4123/mcp', privateOptions);
    expect(await accepted('http://127.0.0.1:4123/mcp', insecureOptions)).toEqual([{ address: '127.0.0.1', family: 4 }]);
    // Link-local and metadata stay refused even with the private opt-in.
    await rejected('https://169.254.169.254/latest/meta-data', privateOptions);
    await rejected('https://[fe80::1]/mcp', privateOptions);
  });

  it('fails loudly with INVALID_INPUT from assertGatewayEndpoint', async () => {
    await expect(assertGatewayEndpoint('https://127.0.0.1/mcp', baseOptions)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    const endpoint = await assertGatewayEndpoint('https://mcp.example.com/mcp', baseOptions);
    expect(endpoint.url.pathname).toBe('/mcp');
    expect(endpoint.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('createPinnedLookup', () => {
  it('answers only the validated addresses regardless of the transport lookup', () => {
    const lookup = createPinnedLookup([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 }
    ]);
    let single: { address: string | unknown[]; family: number | undefined } | undefined;
    lookup('rebind.example.com', { all: false }, (_error, address, family) => {
      single = { address: address as string, family };
    });
    expect(single).toEqual({ address: '8.8.8.8', family: 4 });

    let all: { address: string | unknown[]; family: number | undefined } | undefined;
    lookup('rebind.example.com', { all: true }, (_error, address, family) => {
      all = { address: address as unknown[], family };
    });
    expect(all?.address).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 }
    ]);
  });

  it('fails the lookup when there is no validated address to pin', () => {
    const lookup = createPinnedLookup([]);
    let failure: NodeJS.ErrnoException | null = null;
    lookup('example.com', { all: true }, (error) => {
      failure = error;
    });
    expect(failure).not.toBeNull();
  });
});

describe('gateway config mode gating', () => {
  const common = {
    runnerToken: 'another-token-that-is-long-enough-1234',
    runnerUrl: 'http://runner:3001',
    publicHosts: ['localhost']
  };
  const owner = { ...common, bearerToken: 'owner-token-that-is-long-enough-123456' };
  const access = {
    ...common,
    authMode: 'cloudflare-access' as const,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAudience: 'application-audience',
    accessJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs'
  };

  it('defaults every gateway bound to a safe value', () => {
    const config = ApiConfigSchema.parse(owner);
    expect(config.mcpGatewayTimeoutMs).toBe(30_000);
    expect(config.mcpGatewayMaxResponseBytes).toBe(262_144);
    expect(config.mcpGatewayMaxToolsPerServer).toBe(500);
    expect(config.mcpGatewayMaxSchemaBytes).toBe(65_536);
    expect(config.mcpGatewayMaxCatalogBytes).toBe(2_097_152);
    expect(config.mcpGatewayMaxTraceRows).toBe(20_000);
    expect(config.mcpGatewayMaxConnections).toBe(32);
    expect(config.mcpGatewayAllowInsecureHttp).toBe(false);
    expect(config.mcpGatewayAllowPrivateEndpoints).toBe(false);
  });

  it('refuses both dangerous gateway opt-ins in cloudflare-access mode', () => {
    expect(() => ApiConfigSchema.parse({ ...access, mcpGatewayAllowInsecureHttp: true })).toThrow();
    expect(() => ApiConfigSchema.parse({ ...access, mcpGatewayAllowPrivateEndpoints: true })).toThrow();
    expect(() =>
      ApiConfigSchema.parse({ ...access, mcpGatewayAllowInsecureHttp: true, mcpGatewayAllowPrivateEndpoints: true })
    ).toThrow();
  });

  it('requires the private opt-in before cleartext http in owner-bearer mode', () => {
    expect(() => ApiConfigSchema.parse({ ...owner, mcpGatewayAllowInsecureHttp: true })).toThrow();
    const parsed = ApiConfigSchema.parse({
      ...owner,
      mcpGatewayAllowInsecureHttp: true,
      mcpGatewayAllowPrivateEndpoints: true
    });
    expect(parsed.mcpGatewayAllowInsecureHttp).toBe(true);
    expect(parsed.mcpGatewayAllowPrivateEndpoints).toBe(true);
  });
});
