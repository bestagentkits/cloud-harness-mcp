import { describe, expect, it } from 'vitest';
import { HostFirewallAttestor } from '../src/host-firewall-attestor.js';

describe('HostFirewallAttestor', () => {
  const attestor = new HostFirewallAttestor({
    networkName: 'cloud-harness-dependency-access',
    bridgeInterface: 'chm-egress0',
    bridgeSubnet: '172.30.240.0/24',
    dnsResolvers: ['8.8.8.8', '1.1.1.1'],
    executorImage: 'cloud-harness-executor:local'
  });

  describe('verifyDockerNetwork', () => {
    it('accepts a valid Docker network inspection object', () => {
      const valid = {
        Name: 'cloud-harness-dependency-access',
        Driver: 'bridge',
        EnableIPv6: false,
        Options: {
          'com.docker.network.bridge.name': 'chm-egress0',
          'com.docker.network.bridge.enable_icc': 'false',
          'com.docker.network.bridge.enable_ip_masquerade': 'false'
        },
        IPAM: {
          Config: [{ Subnet: '172.30.240.0/24' }]
        }
      };
      expect(attestor.verifyDockerNetwork(valid)).toEqual({ ok: true });
    });

    it('rejects missing or invalid network properties', () => {
      expect(attestor.verifyDockerNetwork(undefined).ok).toBe(false);
      expect(attestor.verifyDockerNetwork({ Driver: 'overlay' }).ok).toBe(false);
      // ICC enabled
      expect(attestor.verifyDockerNetwork({
        Driver: 'bridge', EnableIPv6: false,
        Options: { 'com.docker.network.bridge.name': 'chm-egress0', 'com.docker.network.bridge.enable_icc': 'true', 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        IPAM: { Config: [{ Subnet: '172.30.240.0/24' }] }
      }).ok).toBe(false);
      // IPv6 enabled
      expect(attestor.verifyDockerNetwork({
        Driver: 'bridge', EnableIPv6: true,
        Options: { 'com.docker.network.bridge.name': 'chm-egress0', 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        IPAM: { Config: [{ Subnet: '172.30.240.0/24' }] }
      }).ok).toBe(false);
      // Wrong bridge interface
      expect(attestor.verifyDockerNetwork({
        Driver: 'bridge', EnableIPv6: false,
        Options: { 'com.docker.network.bridge.name': 'wrong-if', 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        IPAM: { Config: [{ Subnet: '172.30.240.0/24' }] }
      }).ok).toBe(false);
      // Missing bridge name entirely (would get auto br-* interface)
      const missingName = attestor.verifyDockerNetwork({
        Driver: 'bridge', EnableIPv6: false,
        Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        IPAM: { Config: [{ Subnet: '172.30.240.0/24' }] }
      });
      expect(missingName.ok).toBe(false);
      expect(missingName.reason).toContain("bridge interface must be exactly 'chm-egress0'");
      // Missing IPAM subnet
      const missingSubnet = attestor.verifyDockerNetwork({
        Driver: 'bridge', EnableIPv6: false,
        Options: { 'com.docker.network.bridge.name': 'chm-egress0', 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        IPAM: { Config: [] }
      });
      expect(missingSubnet.ok).toBe(false);
      expect(missingSubnet.reason).toContain('exactly one subnet');
      // Missing masquerade-off option
      const missingMasq = attestor.verifyDockerNetwork({
        Driver: 'bridge', EnableIPv6: false,
        Options: { 'com.docker.network.bridge.name': 'chm-egress0', 'com.docker.network.bridge.enable_icc': 'false' },
        IPAM: { Config: [{ Subnet: '172.30.240.0/24' }] }
      });
      expect(missingMasq.ok).toBe(false);
      expect(missingMasq.reason).toContain('enable_ip_masquerade');
    });
  });

  describe('parseFirewallRules', () => {
    const validIptables = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
    `;

    it('accepts complete canonical iptables save ruleset', () => {
      const full = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
-A POSTROUTING -s 172.30.240.0/24 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      expect(attestor.parseFirewallRules(full)).toEqual({ ok: true });
    });

    it('accepts dedicated CHM-NAT-v1 chain in nat table', () => {
      const natChainRules = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      expect(attestor.parseFirewallRules(natChainRules)).toEqual({ ok: true });
    });

    it('rejects ruleset missing required deny CIDRs or ports', () => {
      const missingMetadata = validIptables.replace('-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited', '');
      expect(attestor.parseFirewallRules(missingMetadata).ok).toBe(false);

      const missingRfc1918 = validIptables.replace('-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited', '');
      expect(attestor.parseFirewallRules(missingRfc1918).ok).toBe(false);

      const missingMulticast = validIptables.replace('-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited', '');
      expect(attestor.parseFirewallRules(missingMulticast).ok).toBe(false);

      const missingClassE = validIptables.replace('-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited', '');
      expect(attestor.parseFirewallRules(missingClassE).ok).toBe(false);

      const missingCurrentNet = validIptables.replace('-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited', '');
      expect(attestor.parseFirewallRules(missingCurrentNet).ok).toBe(false);

      const missingPort443 = validIptables.replace('-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT', '');
      expect(attestor.parseFirewallRules(missingPort443).ok).toBe(false);

      const missingInputJump = validIptables.replace('-A INPUT -i chm-egress0 -j CHM-INPUT-v1', '');
      expect(attestor.parseFirewallRules(missingInputJump).ok).toBe(false);

      const missingDockerUserJump = validIptables.replace('-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1', '');
      expect(attestor.parseFirewallRules(missingDockerUserJump).ok).toBe(false);
    });

    it('rejects adversarial reordering: port 80/443 allow placed before deny rules', () => {
      const reordered = `
*filter
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
      `;
      const result = attestor.parseFirewallRules(reordered);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('port 80/443 allow rules must not precede forbidden destination deny rules');
    });

    it('rejects adversarial broad ACCEPT target or preceding rule on DOCKER-USER jump', () => {
      const directAccept = `
*filter
-A FORWARD -j DOCKER-USER
-A DOCKER-USER -i chm-egress0 -j ACCEPT
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
      `;
      const res1 = attestor.parseFirewallRules(directAccept);
      expect(res1.ok).toBe(false);
      expect(res1.reason).toContain("invalid or broad target jump for 'chm-egress0' in DOCKER-USER");

      const precedingAccept = `
*filter
-A FORWARD -j DOCKER-USER
-A DOCKER-USER -j ACCEPT
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
      `;
      const res2 = attestor.parseFirewallRules(precedingAccept);
      expect(res2.ok).toBe(false);
      expect(res2.reason).toContain('must be the first DOCKER-USER rule');
    });

    it('rejects broad unconstrained NAT masquerade', () => {
      const broadNat = `
*filter
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
*nat
-A POSTROUTING -s 172.30.240.0/24 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(broadNat);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('unauthorized or widened MASQUERADE rule');
    });

    it('rejects a broad ACCEPT rule inside the egress chain', () => {
      const broadEgressAccept = `
*filter
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
*nat
-A POSTROUTING -s 172.30.240.0/24 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p udp -d 8.8.8.8 --dport 53 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p tcp -d 8.8.8.8 --dport 53 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p udp -d 1.1.1.1 --dport 53 -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -p tcp -d 1.1.1.1 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(broadEgressAccept);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('unauthorized or widened rule');
    });

    it('rejects widened port 8000 or 4430 inside egress chain', () => {
      const widened8000 = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 8000 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const res1 = attestor.parseFirewallRules(widened8000);
      expect(res1.ok).toBe(false);

      const widened4430 = widened8000.replace('--dport 8000', '--dport 80').replace('--dport 443', '--dport 4430');
      const res2 = attestor.parseFirewallRules(widened4430);
      expect(res2.ok).toBe(false);
    });

    it('rejects a FORWARD rule that precedes the DOCKER-USER jump', () => {
      const forwardBypass = `
*filter
-A FORWARD -i chm-egress0 -j ACCEPT
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
      `;
      const result = attestor.parseFirewallRules(forwardBypass);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("first FORWARD rule must be exactly '-A FORWARD -j DOCKER-USER'");
    });

    it('rejects conditional or unauthorized FORWARD jump', () => {
      const conditionalForward = `
*filter
-A FORWARD -p tcp -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(conditionalForward);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("first FORWARD rule must be exactly '-A FORWARD -j DOCKER-USER'");
    });

    it('rejects ruleset with missing FORWARD jump to DOCKER-USER', () => {
      const noForward = `
*filter
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT
COMMIT
      `;
      const result = attestor.parseFirewallRules(noForward);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('missing FORWARD jump rule to DOCKER-USER');
    });

    it('rejects widened MASQUERADE on unauthorized port in nat table', () => {
      const widenedNat = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p tcp --dport 22 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(widenedNat);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('unauthorized or widened MASQUERADE rule');
    });

    it('rejects broad MASQUERADE preceding POSTROUTING jump in nat table', () => {
      const precedingNat = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -j MASQUERADE
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(precedingNat);
      expect(result.reason).toContain('broad MASQUERADE or ACCEPT rule precedes POSTROUTING jump');
    });

    it('rejects early RETURN inside egress chain', () => {
      const returnRules = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -j RETURN
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(returnRules);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('unauthorized or widened rule');
    });

    it('rejects unauthorized indirect jump inside egress chain', () => {
      const indirectRules = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
:UNTRUSTED-CHAIN - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -j UNTRUSTED-CHAIN
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(indirectRules);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('unauthorized or widened rule');
    });

    it('rejects early RETURN inside INPUT target chain', () => {
      const inputReturn = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j RETURN
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(inputReturn);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('must not contain RETURN rules');
    });

    it('rejects unauthorized indirect jump inside INPUT target chain', () => {
      const inputIndirect = `
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:CHM-INPUT-v1 - [0:0]
:CHM-EGRESS-v1 - [0:0]
:UNTRUSTED-INPUT - [0:0]
-A FORWARD -j DOCKER-USER
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A CHM-INPUT-v1 -j UNTRUSTED-INPUT
-A CHM-INPUT-v1 -j REJECT --reject-with icmp-port-unreachable
-A CHM-EGRESS-v1 -m conntrack --ctstate ESTABLISHED -j ACCEPT
-A CHM-EGRESS-v1 -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 127.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 224.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 240.0.0.0/4 -j REJECT --reject-with icmp-admin-prohibited
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 80 -j ACCEPT
-A CHM-EGRESS-v1 -p tcp -m tcp --dport 443 -j ACCEPT
-A CHM-EGRESS-v1 -j REJECT --reject-with icmp-port-unreachable
COMMIT
*nat
:POSTROUTING ACCEPT [0:0]
:CHM-NAT-v1 - [0:0]
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 8.8.8.8/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p udp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -p tcp -d 1.1.1.1/32 --dport 53 -j MASQUERADE
COMMIT
      `;
      const result = attestor.parseFirewallRules(inputIndirect);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('unauthorized target');
    });
  });
});
