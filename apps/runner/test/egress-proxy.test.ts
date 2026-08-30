import { describe, expect, it } from 'vitest';
import { isForbiddenIp, resolveAndValidateHost } from '../../../deploy/provisioning-proxy.mjs';

describe('Provisioning Egress Proxy IP Validation', () => {
  it('rejects loopback and current network IPv4 addresses', () => {
    expect(isForbiddenIp('127.0.0.1')).toBe(true);
    expect(isForbiddenIp('127.0.1.1')).toBe(true);
    expect(isForbiddenIp('0.0.0.0')).toBe(true);
    expect(isForbiddenIp('0.1.2.3')).toBe(true);
  });

  it('rejects cloud metadata and link-local IPv4 addresses', () => {
    expect(isForbiddenIp('169.254.169.254')).toBe(true);
    expect(isForbiddenIp('169.254.1.1')).toBe(true);
  });

  it('rejects RFC1918 private subnets', () => {
    expect(isForbiddenIp('10.0.0.1')).toBe(true);
    expect(isForbiddenIp('10.255.255.255')).toBe(true);
    expect(isForbiddenIp('172.16.0.1')).toBe(true);
    expect(isForbiddenIp('172.31.255.255')).toBe(true);
    expect(isForbiddenIp('192.168.0.1')).toBe(true);
    expect(isForbiddenIp('192.168.100.50')).toBe(true);
  });

  it('rejects carrier-grade NAT, multicast, and test subnets', () => {
    expect(isForbiddenIp('100.64.0.1')).toBe(true);
    expect(isForbiddenIp('100.127.255.255')).toBe(true);
    expect(isForbiddenIp('192.0.2.1')).toBe(true);
    expect(isForbiddenIp('198.51.100.1')).toBe(true);
    expect(isForbiddenIp('203.0.113.1')).toBe(true);
    expect(isForbiddenIp('224.0.0.1')).toBe(true);
    expect(isForbiddenIp('240.0.0.1')).toBe(true);
    expect(isForbiddenIp('255.255.255.255')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 representations of forbidden addresses', () => {
    expect(isForbiddenIp('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenIp('::ffff:169.254.169.254')).toBe(true);
    expect(isForbiddenIp('::ffff:10.0.0.1')).toBe(true);
    expect(isForbiddenIp('::ffff:192.168.1.1')).toBe(true);
  });

  it('rejects IPv6 loopback, link-local, and unique-local addresses', () => {
    expect(isForbiddenIp('::1')).toBe(true);
    expect(isForbiddenIp('::')).toBe(true);
    expect(isForbiddenIp('fe80::1')).toBe(true);
    expect(isForbiddenIp('fc00::1')).toBe(true);
    expect(isForbiddenIp('fd00::1234')).toBe(true);
    expect(isForbiddenIp('ff02::1')).toBe(true);
  });

  it('accepts legitimate public IPv4 addresses', () => {
    expect(isForbiddenIp('140.82.121.4')).toBe(false); // GitHub
    expect(isForbiddenIp('1.1.1.1')).toBe(false);
    expect(isForbiddenIp('8.8.8.8')).toBe(false);
  });
});

describe('Provisioning Egress Proxy Host Resolution and Validation', () => {
  it('allows allowlisted hosts that resolve to public IPs', async () => {
    const result = await resolveAndValidateHost('github.com');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.hostname).toBe('github.com');
      expect(isForbiddenIp(result.validatedIp)).toBe(false);
    }
  });

  it('rejects hosts not in allowlist', async () => {
    const result = await resolveAndValidateHost('evil-attacker.com');
    expect(result).toBeNull();
  });

  it('rejects localhost and invalid hosts', async () => {
    expect(await resolveAndValidateHost('localhost')).toBeNull();
    expect(await resolveAndValidateHost('')).toBeNull();
  });
});
