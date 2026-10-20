import { beforeEach, describe, expect, it, vi } from 'vitest';

const dockerMocks = vi.hoisted(() => ({
  runDocker: vi.fn(),
  inspectNetwork: vi.fn()
}));
vi.mock('../src/docker-engine.js', () => dockerMocks);

import { HostFirewallAttestor } from '../src/host-firewall-attestor.js';

const egressChain = `
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
-A POSTROUTING -j ts-postrouting
-A POSTROUTING -s 172.30.240.0/24 -j CHM-NAT-v1
-A CHM-NAT-v1 -p tcp -m multiport --dports 80,443 -j MASQUERADE
-A CHM-NAT-v1 -d 8.8.8.8/32 -p udp -m udp --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -d 1.1.1.1/32 -p udp -m udp --dport 53 -j MASQUERADE
-A CHM-NAT-v1 -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j MASQUERADE
COMMIT
`;

const ruleset = (head: string) => `*filter\n:INPUT ACCEPT [0:0]\n:FORWARD ACCEPT [0:0]\n${head.trim()}\n${egressChain}`;

const canonical = ruleset(`
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A INPUT -j ts-input
-A FORWARD -j DOCKER-USER
-A FORWARD -j ts-forward
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A DOCKER-USER -j RETURN
-A ts-input -p udp -m udp --dport 41641 -j ACCEPT
`);

// The shape reported in production: tailscaled re-inserted its jumps at the head of INPUT and FORWARD.
const tailscaleFirst = ruleset(`
-A INPUT -j ts-input
-A INPUT -i chm-egress0 -j CHM-INPUT-v1
-A FORWARD -j ts-forward
-A FORWARD -j DOCKER-USER
-A DOCKER-USER -i chm-egress0 -j CHM-EGRESS-v1
-A DOCKER-USER -j RETURN
-A ts-input -p udp -m udp --dport 41641 -j ACCEPT
`);

const attestor = new HostFirewallAttestor({ networkGuardImage: 'guard:test' });
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', truncated: false });

describe('HostFirewallAttestor ordering repair', () => {
  beforeEach(() => {
    dockerMocks.runDocker.mockReset();
  });

  it('plans to move only the displaced managed jumps to the head of their chains', () => {
    expect(attestor.parseFirewallRules(tailscaleFirst).reason).toContain("first FORWARD rule must be exactly '-A FORWARD -j DOCKER-USER'");
    expect(attestor.planOrderingRepair(tailscaleFirst)).toEqual([
      { chain: 'FORWARD', rule: '-j DOCKER-USER' },
      { chain: 'INPUT', rule: '-i chm-egress0 -j CHM-INPUT-v1' }
    ]);
    expect(attestor.planOrderingRepair(canonical)).toBeUndefined();
  });

  it('refuses to plan a repair when reordering alone would not attest', () => {
    const widened = tailscaleFirst.replace('--dport 443 -j ACCEPT', '--dport 4430 -j ACCEPT');
    expect(attestor.planOrderingRepair(widened)).toBeUndefined();
    const missingJump = tailscaleFirst.replace('-A INPUT -i chm-egress0 -j CHM-INPUT-v1\n', '');
    expect(attestor.planOrderingRepair(missingJump)).toBeUndefined();
    const broadInput = tailscaleFirst.replace('-A INPUT -i chm-egress0 -j CHM-INPUT-v1', '-A INPUT -i chm-egress0 -j ACCEPT');
    expect(attestor.planOrderingRepair(broadInput)).toBeUndefined();
  });

  it('repairs the ordering through the network guard image and re-attests', async () => {
    dockerMocks.runDocker
      .mockResolvedValueOnce(ok(tailscaleFirst))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok(canonical));

    const result = await attestor.attestHostKernel();

    expect(result).toEqual({ ok: true, repaired: [
      { chain: 'FORWARD', rule: '-j DOCKER-USER' },
      { chain: 'INPUT', rule: '-i chm-egress0 -j CHM-INPUT-v1' }
    ] });
    const repairCall = dockerMocks.runDocker.mock.calls[2]![0] as string[];
    expect(repairCall).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--entrypoint', '/bin/sh', 'guard:test']));
    expect(repairCall.slice(-6)).toEqual(['chm-repair', 'INPUT', '-i', 'chm-egress0', '-j', 'CHM-INPUT-v1']);
  });

  it('fails closed when the ruleset still does not attest after the repair', async () => {
    dockerMocks.runDocker
      .mockResolvedValueOnce(ok(tailscaleFirst))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok(tailscaleFirst));

    const result = await attestor.attestHostKernel();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('(after ordering repair)');
  });

  it('fails closed with both reasons when the repair command fails', async () => {
    dockerMocks.runDocker
      .mockResolvedValueOnce(ok(tailscaleFirst))
      .mockResolvedValueOnce({ exitCode: 4, stdout: '', stderr: 'Permission denied', truncated: false });

    const result = await attestor.attestHostKernel();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("first FORWARD rule must be exactly '-A FORWARD -j DOCKER-USER'");
    expect(result.reason).toContain('ordering repair failed for FORWARD');
    expect(dockerMocks.runDocker).toHaveBeenCalledTimes(2);
  });

  it('does not touch the firewall when the defect is not an ordering defect', async () => {
    dockerMocks.runDocker.mockResolvedValueOnce(ok(canonical.replace('--dport 443 -j ACCEPT', '--dport 4430 -j ACCEPT')));

    const result = await attestor.attestHostKernel();

    expect(result.ok).toBe(false);
    expect(dockerMocks.runDocker).toHaveBeenCalledTimes(1);
  });
});
