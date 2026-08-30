import { inspectNetwork, runDocker } from './docker-engine.js';

export type FirewallAttestationResult = {
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type HostFirewallAttestorConfig = {
  networkName?: string;
  bridgeInterface?: string;
  bridgeSubnet?: string;
  dnsResolvers?: string[];
  networkGuardImage?: string;
  executorImage?: string;
};

export class HostFirewallAttestor {
  public readonly networkName: string;
  public readonly bridgeInterface: string;
  public readonly bridgeSubnet: string;
  public readonly dnsResolvers: string[];
  public readonly networkGuardImage: string;

  constructor(config: HostFirewallAttestorConfig = {}) {
    this.networkName = config.networkName ?? 'cloud-harness-dependency-access';
    this.bridgeInterface = config.bridgeInterface ?? 'chm-egress0';
    this.bridgeSubnet = config.bridgeSubnet ?? '172.30.240.0/24';
    this.dnsResolvers = config.dnsResolvers && config.dnsResolvers.length > 0 ? config.dnsResolvers : ['8.8.8.8', '1.1.1.1'];
    this.networkGuardImage = config.networkGuardImage ?? 'cloud-harness-network-guard:local';
  }

  public verifyDockerNetwork(networkInspect: Record<string, unknown> | undefined): { ok: boolean; reason?: string } {
    if (!networkInspect) {
      return { ok: false, reason: `dedicated bridge network '${this.networkName}' is not found` };
    }

    if (networkInspect.Driver !== 'bridge') {
      return { ok: false, reason: `network driver must be 'bridge', found '${String(networkInspect.Driver)}'` };
    }

    const options = (networkInspect.Options as Record<string, string> | undefined) ?? {};
    if (options['com.docker.network.bridge.name'] !== this.bridgeInterface) {
      return { ok: false, reason: `bridge interface must be exactly '${this.bridgeInterface}', found '${options['com.docker.network.bridge.name'] ?? '(unset)'}'` };
    }

    if (options['com.docker.network.bridge.enable_icc'] !== 'false') {
      return { ok: false, reason: "inter-container communication (enable_icc) must be 'false'" };
    }

    if (options['com.docker.network.bridge.enable_ip_masquerade'] !== 'false') {
      return { ok: false, reason: "default IP masquerade (enable_ip_masquerade) must be 'false'" };
    }

    if (networkInspect.EnableIPv6 !== false) {
      return { ok: false, reason: 'IPv6 must be explicitly disabled for dependency-access network' };
    }

    const ipam = (networkInspect.IPAM as { Config?: Array<{ Subnet?: string }> } | undefined) ?? {};
    const subnets = (ipam.Config ?? []).map((c) => c.Subnet).filter((s): s is string => Boolean(s));
    if (subnets.length !== 1 || subnets[0] !== this.bridgeSubnet) {
      return { ok: false, reason: `network must have exactly one subnet '${this.bridgeSubnet}', found '${subnets.join(', ') || '(none)'}'` };
    }

    return { ok: true };
  }

  public parseFirewallRules(iptablesText: string): { ok: boolean; reason?: string } {
    if (!iptablesText || iptablesText.trim().length === 0) {
      return { ok: false, reason: 'empty firewall configuration' };
    }

    const lines = iptablesText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));

    // 1. FORWARD must jump to DOCKER-USER, and no prior FORWARD rule may accept
    // traffic from the managed bridge before that jump.
    const forwardRules = lines.filter((l) => l.startsWith('-A FORWARD'));
    const dockerUserJumpIdx = forwardRules.findIndex((l) => l.includes('-j DOCKER-USER'));
    if (forwardRules.length > 0 && dockerUserJumpIdx === -1) {
      return { ok: false, reason: 'FORWARD chain does not jump to DOCKER-USER' };
    }
    if (dockerUserJumpIdx > 0) {
      const priorForwardAccept = forwardRules.slice(0, dockerUserJumpIdx).some((l) => l.includes('-j ACCEPT') && (!l.includes('-i ') || l.includes(`-i ${this.bridgeInterface}`)));
      if (priorForwardAccept) {
        return { ok: false, reason: `broad ACCEPT rule precedes FORWARD jump to DOCKER-USER for '${this.bridgeInterface}'` };
      }
    }
    // 2. Check INPUT jump
    const inputRules = lines.filter((l) => l.startsWith('-A INPUT'));
    const inputInterfaceRules = inputRules.filter((l) => l.includes(`-i ${this.bridgeInterface}`));
    if (inputInterfaceRules.length === 0) {
      return { ok: false, reason: `missing INPUT jump rule for interface '${this.bridgeInterface}'` };
    }
    // Managed jump must be the literal first rule in the INPUT chain so no prior
    // rule (ACCEPT, RETURN, or a jump to an accepting chain) can bypass it.
    const firstInput = inputRules[0];
    if (!firstInput || !firstInput.includes(`-i ${this.bridgeInterface}`)) {
      return { ok: false, reason: `managed INPUT jump for '${this.bridgeInterface}' must be the first INPUT rule` };
    }
    const inputTarget = firstInput.match(/-j\s+([A-Za-z0-9_-]+)/)?.[1];
    if (!inputTarget || inputTarget === 'ACCEPT' || inputTarget === 'RETURN') {
      return { ok: false, reason: `invalid or broad ACCEPT/RETURN target jump for '${this.bridgeInterface}' in INPUT` };
    }

    // The owned INPUT target chain must deny with no ACCEPT rule that could
    // let executor traffic reach the host.
    if (inputTarget !== 'REJECT' && inputTarget !== 'DROP') {
      const inputChainRules = lines.filter((l) => l.startsWith(`-A ${inputTarget}`));
      if (inputChainRules.some((l) => l.includes('-j ACCEPT'))) {
        return { ok: false, reason: `INPUT target chain '${inputTarget}' must not contain ACCEPT rules` };
      }
      const lastInput = inputChainRules[inputChainRules.length - 1];
      if (!lastInput || (!lastInput.includes('-j REJECT') && !lastInput.includes('-j DROP'))) {
        return { ok: false, reason: `chain '${inputTarget}' must terminate with REJECT or DROP` };
      }
    }

    // 3. Check DOCKER-USER jump
    const dockerUserRules = lines.filter((l) => l.startsWith('-A DOCKER-USER'));
    const dockerUserInterfaceRules = dockerUserRules.filter((l) => l.includes(`-i ${this.bridgeInterface}`));
    if (dockerUserInterfaceRules.length === 0) {
      return { ok: false, reason: `missing DOCKER-USER jump rule for interface '${this.bridgeInterface}'` };
    }

    // Managed jump must be the literal first rule in DOCKER-USER so no prior
    // rule (ACCEPT, RETURN, or a jump to an accepting chain) can bypass it.
    const firstEgress = dockerUserRules[0];
    if (!firstEgress || !firstEgress.includes(`-i ${this.bridgeInterface}`)) {
      return { ok: false, reason: `managed DOCKER-USER jump for '${this.bridgeInterface}' must be the first DOCKER-USER rule` };
    }
    const egressTarget = firstEgress.match(/-j\s+([A-Za-z0-9_-]+)/)?.[1];
    if (!egressTarget || egressTarget === 'ACCEPT' || egressTarget === 'RETURN') {
      return { ok: false, reason: `invalid or broad ACCEPT/RETURN target jump for '${this.bridgeInterface}' in DOCKER-USER` };
    }

    // 4. Check EGRESS chain rules in strict order
    const egressRules = lines.filter((l) => l.startsWith(`-A ${egressTarget}`));
    if (egressRules.length === 0) {
      return { ok: false, reason: `egress target chain '${egressTarget}' has no rules` };
    }

    // First rule must be established conntrack
    const firstRule = egressRules[0];
    if (!firstRule || !firstRule.includes('conntrack') || !firstRule.includes('ESTABLISHED') || !firstRule.includes('-j ACCEPT')) {
      return { ok: false, reason: 'first rule in egress chain must be ESTABLISHED conntrack accept' };
    }

    // Required deny CIDRs
    const requiredDenyCidrs = ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10'];
    const denyIndices: number[] = [];
    for (const cidr of requiredDenyCidrs) {
      const idx = egressRules.findIndex((l) => l.includes(`-d ${cidr}`) && (l.includes('-j REJECT') || l.includes('-j DROP')));
      if (idx === -1) {
        return { ok: false, reason: `egress chain missing deny rule for '${cidr}'` };
      }
      denyIndices.push(idx);
    }
    const maxDenyIdx = Math.max(...denyIndices);

    // Allowed ports 80 and 443
    const port80Idx = egressRules.findIndex((l) => l.includes('--dport 80') && l.includes('-j ACCEPT'));
    const port443Idx = egressRules.findIndex((l) => l.includes('--dport 443') && l.includes('-j ACCEPT'));
    if (port80Idx === -1 || port443Idx === -1) {
      return { ok: false, reason: 'egress chain missing HTTP/HTTPS (ports 80, 443) accept rules' };
    }

    // All deny rules MUST appear BEFORE port 80/443 accept rules
    if (maxDenyIdx > port80Idx || maxDenyIdx > port443Idx) {
      return { ok: false, reason: 'port 80/443 allow rules must not precede forbidden destination deny rules' };
    }

    // Must have DNS resolvers on port 53 for both UDP and TCP
    for (const resolver of this.dnsResolvers) {
      const hasDnsUdp = egressRules.some((l) => l.includes(`-d ${resolver}`) && l.includes('--dport 53') && l.includes('-p udp') && l.includes('-j ACCEPT'));
      const hasDnsTcp = egressRules.some((l) => l.includes(`-d ${resolver}`) && l.includes('--dport 53') && l.includes('-p tcp') && l.includes('-j ACCEPT'));
      if (!hasDnsUdp) {
        return { ok: false, reason: `egress chain missing DNS UDP accept rule for '${resolver}'` };
      }
      if (!hasDnsTcp) {
        return { ok: false, reason: `egress chain missing DNS TCP accept rule for '${resolver}'` };
      }
    }

    // Every ACCEPT rule in the egress chain must be one of the four allowed
    // shapes: established conntrack, DNS to a configured resolver, or public
    // TCP 80/443. Any other ACCEPT is a broad bypass.
    const acceptRules = egressRules.filter((l) => l.includes('-j ACCEPT'));
    for (const rule of acceptRules) {
      const isEstablished = rule.includes('conntrack') && rule.includes('ESTABLISHED');
      const isDns = this.dnsResolvers.some((r) => rule.includes(`-d ${r}`)) && rule.includes('--dport 53');
      const isWeb = !rule.includes('-d ') && (rule.includes('--dport 80') || rule.includes('--dport 443'));
      if (!isEstablished && !isDns && !isWeb) {
        return { ok: false, reason: `egress chain contains a broad ACCEPT rule: ${rule}` };
      }
    }

    // Must terminate with REJECT or DROP
    const lastRule = egressRules[egressRules.length - 1];
    if (!lastRule || (!lastRule.includes('-j REJECT') && !lastRule.includes('-j DROP'))) {
      return { ok: false, reason: 'egress chain must end with terminal REJECT or DROP' };
    }

    // 5. NAT table is mandatory: scoped masquerade for allowed egress, no broad rule
    const natIndex = lines.indexOf('*nat');
    if (natIndex === -1) {
      return { ok: false, reason: 'nat table section missing; scoped MASQUERADE rules are required' };
    }
    const natLines = lines.slice(natIndex);
    const postroutingRules = natLines.filter((l) => l.startsWith('-A POSTROUTING') && l.includes(`-s ${this.bridgeSubnet}`));
    if (postroutingRules.length === 0) {
      return { ok: false, reason: `no scoped MASQUERADE rules found for '${this.bridgeSubnet}' in nat table` };
    }
    const broadMasq = postroutingRules.some((l) => l.includes('-j MASQUERADE') && !l.includes('--dport') && !l.includes('-p'));
    if (broadMasq) {
      return { ok: false, reason: `broad unconstrained MASQUERADE rule found for '${this.bridgeSubnet}' in nat table` };
    }
    const hasWebMasq = postroutingRules.some((l) => l.includes('-j MASQUERADE') && (l.includes('80') || l.includes('443')));
    if (!hasWebMasq) {
      return { ok: false, reason: `missing scoped HTTP/HTTPS MASQUERADE rule for '${this.bridgeSubnet}'` };
    }
    for (const resolver of this.dnsResolvers) {
      const hasDnsMasq = postroutingRules.some((l) => l.includes('-j MASQUERADE') && l.includes(`-d ${resolver}`) && l.includes('--dport 53'));
      if (!hasDnsMasq) {
        return { ok: false, reason: `missing scoped DNS MASQUERADE rule for resolver '${resolver}'` };
      }
    }

    return { ok: true };
  }

  public async attestHostKernel(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const result = await runDocker([
        'run', '--rm', '--network', 'host',
        '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
        '--security-opt', 'no-new-privileges',
        '--user', '0:0',
        this.networkGuardImage
      ], { timeoutMs: 15_000 });

      if (result.exitCode !== 0) {
        return { ok: false, reason: `host firewall probe failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}` };
      }

      return this.parseFirewallRules(result.stdout);
    } catch (err) {
      return { ok: false, reason: `host firewall attestation error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  public async verify(): Promise<FirewallAttestationResult> {
    try {
      const netInspect = await inspectNetwork(this.networkName);
      const netResult = this.verifyDockerNetwork(netInspect);
      if (!netResult.ok) {
        return { ok: false, ...(netResult.reason ? { reason: netResult.reason } : {}) };
      }

      const fwResult = await this.attestHostKernel();
      if (!fwResult.ok) {
        return { ok: false, ...(fwResult.reason ? { reason: fwResult.reason } : {}) };
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `firewall attestation error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
