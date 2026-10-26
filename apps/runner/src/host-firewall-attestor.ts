import { inspectNetwork, runDocker } from './docker-engine.js';

export type FirewallAttestationResult = {
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export type FirewallOrderingRepair = { chain: string; rule: string };

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
  private attestationQueue: Promise<unknown> = Promise.resolve();

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
    // mangle and raw also have INPUT/FORWARD chains, but only the filter table
    // decides whether bridge traffic is accepted, so its chains are read alone.
    const filterLines = filterSection(lines) ?? lines;

    // 1. FORWARD must have an exact, unconditional jump to DOCKER-USER as its first rule
    const forwardRules = filterLines.filter((l) => l.startsWith('-A FORWARD'));
    if (forwardRules.length === 0) {
      return { ok: false, reason: 'missing FORWARD jump rule to DOCKER-USER' };
    }
    const firstForward = forwardRules[0]!.replace(/\s+/g, ' ').trim();
    if (firstForward !== '-A FORWARD -j DOCKER-USER') {
      return { ok: false, reason: `first FORWARD rule must be exactly '-A FORWARD -j DOCKER-USER', found '${firstForward}'` };
    }
    // 2. Check INPUT jump
    const inputRules = filterLines.filter((l) => l.startsWith('-A INPUT'));
    if (inputRules.length === 0) {
      return { ok: false, reason: `missing INPUT jump rule for interface '${this.bridgeInterface}'` };
    }
    const firstInput = inputRules[0]!.replace(/\s+/g, ' ').trim();
    const inputPrefix = `-A INPUT -i ${this.bridgeInterface} -j `;
    if (!firstInput.startsWith(inputPrefix)) {
      return { ok: false, reason: `managed INPUT jump for '${this.bridgeInterface}' must be the first INPUT rule, found '${firstInput}'` };
    }
    const inputTarget = firstInput.slice(inputPrefix.length).trim();
    if (inputTarget === 'ACCEPT' || inputTarget === 'RETURN' || !/^[A-Za-z0-9_-]+$/.test(inputTarget)) {
      return { ok: false, reason: `invalid or broad target jump for '${this.bridgeInterface}' in INPUT: ${inputTarget}` };
    }
    // The owned INPUT target chain must strictly deny all host-destined traffic
    // and must not contain any RETURN, ACCEPT, or indirect jump rules.
    if (inputTarget !== 'REJECT' && inputTarget !== 'DROP') {
      const inputChainRules = filterLines.filter((l) => l.startsWith(`-A ${inputTarget}`));
      if (inputChainRules.length === 0) {
        return { ok: false, reason: `INPUT target chain '${inputTarget}' has no rules` };
      }
      for (const rule of inputChainRules) {
        const target = rule.match(/-j\s+([A-Za-z0-9_-]+)/)?.[1];
        if (target === 'RETURN') {
          return { ok: false, reason: `INPUT target chain '${inputTarget}' must not contain RETURN rules: ${rule}` };
        }
        if (target !== 'REJECT' && target !== 'DROP') {
          return { ok: false, reason: `INPUT target chain '${inputTarget}' contains unauthorized target '${target}': ${rule}` };
        }
      }
      const lastInput = inputChainRules[inputChainRules.length - 1];
      if (!lastInput || (!lastInput.includes('-j REJECT') && !lastInput.includes('-j DROP'))) {
        return { ok: false, reason: `chain '${inputTarget}' must terminate with REJECT or DROP` };
      }
    }

    // 3. Check DOCKER-USER jump
    const dockerUserRules = filterLines.filter((l) => l.startsWith('-A DOCKER-USER'));
    if (dockerUserRules.length === 0) {
      return { ok: false, reason: `missing DOCKER-USER jump rule for interface '${this.bridgeInterface}'` };
    }
    const firstEgress = dockerUserRules[0]!.replace(/\s+/g, ' ').trim();
    const egressPrefix = `-A DOCKER-USER -i ${this.bridgeInterface} -j `;
    if (!firstEgress.startsWith(egressPrefix)) {
      return { ok: false, reason: `managed DOCKER-USER jump for '${this.bridgeInterface}' must be the first DOCKER-USER rule, found '${firstEgress}'` };
    }
    const egressTarget = firstEgress.slice(egressPrefix.length).trim();
    if (egressTarget === 'ACCEPT' || egressTarget === 'RETURN' || !/^[A-Za-z0-9_-]+$/.test(egressTarget)) {
      return { ok: false, reason: `invalid or broad target jump for '${this.bridgeInterface}' in DOCKER-USER: ${egressTarget}` };
    }

    // 4. Check EGRESS chain rules in strict order
    const egressRules = filterLines.filter((l) => l.startsWith(`-A ${egressTarget}`));
    if (egressRules.length === 0) {
      return { ok: false, reason: `egress target chain '${egressTarget}' has no rules` };
    }

    // First rule must be established conntrack
    const firstRule = egressRules[0];
    if (!firstRule || !firstRule.includes('conntrack') || !firstRule.includes('ESTABLISHED') || !firstRule.includes('-j ACCEPT')) {
      return { ok: false, reason: 'first rule in egress chain must be ESTABLISHED conntrack accept' };
    }

    // Required deny CIDRs
    const requiredDenyCidrs = [
      '169.254.0.0/16',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '127.0.0.0/8',
      '100.64.0.0/10',
      '0.0.0.0/8',
      '224.0.0.0/4',
      '240.0.0.0/4'
    ];
    const denyIndices: number[] = [];
    for (const cidr of requiredDenyCidrs) {
      const idx = egressRules.findIndex((l) => l.includes(`-d ${cidr}`) && (l.includes('-j REJECT') || l.includes('-j DROP')));
      if (idx === -1) {
        return { ok: false, reason: `egress chain missing deny rule for '${cidr}'` };
      }
      denyIndices.push(idx);
    }
    const maxDenyIdx = Math.max(...denyIndices);

    // Allowed ports 80 and 443 with exact word boundaries
    const port80Idx = egressRules.findIndex((l) => /--dport\s+80\b/.test(l) && /-p\s+tcp\b/.test(l) && /-j\s+ACCEPT\b/.test(l) && !/-d\s+/.test(l));
    const port443Idx = egressRules.findIndex((l) => /--dport\s+443\b/.test(l) && /-p\s+tcp\b/.test(l) && /-j\s+ACCEPT\b/.test(l) && !/-d\s+/.test(l));
    if (port80Idx === -1 || port443Idx === -1) {
      return { ok: false, reason: 'egress chain missing HTTP/HTTPS (ports 80, 443) accept rules' };
    }

    // All deny rules MUST appear BEFORE port 80/443 accept rules
    if (maxDenyIdx > port80Idx || maxDenyIdx > port443Idx) {
      return { ok: false, reason: 'port 80/443 allow rules must not precede forbidden destination deny rules' };
    }

    // Must have DNS resolvers on port 53 for both UDP and TCP
    for (const resolver of this.dnsResolvers) {
      const hasDnsUdp = egressRules.some((l) => l.includes(`-d ${resolver}`) && /--dport\s+53\b/.test(l) && /-p\s+udp\b/.test(l) && /-j\s+ACCEPT\b/.test(l));
      const hasDnsTcp = egressRules.some((l) => l.includes(`-d ${resolver}`) && /--dport\s+53\b/.test(l) && /-p\s+tcp\b/.test(l) && /-j\s+ACCEPT\b/.test(l));
      if (!hasDnsUdp) {
        return { ok: false, reason: `egress chain missing DNS UDP accept rule for '${resolver}'` };
      }
      if (!hasDnsTcp) {
        return { ok: false, reason: `egress chain missing DNS TCP accept rule for '${resolver}'` };
      }
    }

    // Every rule in the egress chain must match an exact authorized canonical shape.
    // Reject any early RETURN, indirect jump, or widened port (e.g. 8000, 4430, 22).
    for (const rule of egressRules) {
      const isConntrack = /^-A\s+\S+\s+-m\s+conntrack\s+--ctstate\s+ESTABLISHED(?:,RELATED)?\s+-j\s+ACCEPT$/.test(rule);
      const isDeny = /^-A\s+\S+\s+-d\s+\S+\s+-j\s+(?:REJECT|DROP)(?:\s+--reject-with\s+\S+)?$/.test(rule);
      const isDns = this.dnsResolvers.some((r) =>
        new RegExp(`^-A\\s+\\S+\\s+-d\\s+${r}(?:/32)?\\s+-p\\s+(?:udp|tcp)(?:\\s+-m\\s+(?:udp|tcp))?\\s+--dport\\s+53\\s+-j\\s+ACCEPT$`).test(rule) ||
        new RegExp(`^-A\\s+\\S+\\s+-p\\s+(?:udp|tcp)(?:\\s+-m\\s+(?:udp|tcp))?\\s+-d\\s+${r}(?:/32)?\\s+--dport\\s+53\\s+-j\\s+ACCEPT$`).test(rule)
      );
      const isWeb = /^-A\s+\S+\s+-p\s+tcp(?:\s+-m\s+tcp)?\s+--dport\s+80\s+-j\s+ACCEPT$/.test(rule) ||
                    /^-A\s+\S+\s+-p\s+tcp(?:\s+-m\s+tcp)?\s+--dport\s+443\s+-j\s+ACCEPT$/.test(rule) ||
                    /^-A\s+\S+\s+-p\s+tcp\s+-m\s+multiport\s+--dports\s+80,443\s+-j\s+ACCEPT$/.test(rule);
      const isTerminal = /^-A\s+\S+\s+-j\s+(?:REJECT|DROP)(?:\s+--reject-with\s+\S+)?$/.test(rule);

      if (!isConntrack && !isDeny && !isDns && !isWeb && !isTerminal) {
        return { ok: false, reason: `egress chain contains unauthorized or widened rule: ${rule}` };
      }
    }
    const lastRule = egressRules[egressRules.length - 1];
    if (!lastRule || (!lastRule.includes('-j REJECT') && !lastRule.includes('-j DROP'))) {
      return { ok: false, reason: 'egress chain must end with terminal REJECT or DROP' };
    }

    // 5. NAT table is mandatory: scoped masquerade for allowed egress in dedicated chain or direct scoped rules
    const natIndex = lines.indexOf('*nat');
    if (natIndex === -1) {
      return { ok: false, reason: 'nat table section missing; scoped MASQUERADE rules are required' };
    }
    const natLines = lines.slice(natIndex);
    const postroutingRules = natLines.filter((l) => l.startsWith('-A POSTROUTING'));
    const subnetJumps = postroutingRules.filter((l) => l.includes(`-s ${this.bridgeSubnet}`));
    if (subnetJumps.length === 0) {
      return { ok: false, reason: `no scoped MASQUERADE or NAT jump rules found for '${this.bridgeSubnet}' in nat table` };
    }
    const firstJump = subnetJumps[0];
    const firstJumpIdx = postroutingRules.indexOf(firstJump!);

    // Ensure no earlier rule in POSTROUTING applies broad masquerade or accept before our subnet jump
    const priorBroadNat = postroutingRules.slice(0, firstJumpIdx).some((l) =>
      (l.includes('-j MASQUERADE') || l.includes('-j ACCEPT')) && (!l.includes('-s ') || l.includes(`-s ${this.bridgeSubnet}`))
    );
    if (priorBroadNat) {
      return { ok: false, reason: `broad MASQUERADE or ACCEPT rule precedes POSTROUTING jump for '${this.bridgeSubnet}'` };
    }

    const natTarget = firstJump?.match(/-j\s+([A-Za-z0-9_-]+)/)?.[1];
    if (!natTarget || natTarget === 'ACCEPT' || natTarget === 'RETURN') {
      return { ok: false, reason: `invalid or broad target jump for subnet '${this.bridgeSubnet}' in POSTROUTING` };
    }
    let targetRules: string[];
    if (natTarget === 'MASQUERADE') {
      // Direct scoped masquerade rules in POSTROUTING
      targetRules = subnetJumps;
    } else {
      // Jump to a dedicated NAT chain (e.g. CHM-NAT-v1)
      targetRules = natLines.filter((l) => l.startsWith(`-A ${natTarget}`));
      if (targetRules.length === 0) {
        return { ok: false, reason: `nat target chain '${natTarget}' has no rules` };
      }
    }

    // Validate that every single rule in target is an authorized scoped MASQUERADE rule
    for (const rule of targetRules) {
      if (rule.includes('-j MASQUERADE')) {
        const isWebMasq = rule.includes('-p tcp') && (rule.includes('--dports 80,443') || rule.includes('--dport 80') || rule.includes('--dport 443')) && !rule.includes('-d ');
        const isDnsMasq = this.dnsResolvers.some((r) => rule.includes(`-d ${r}`)) && (rule.includes('-p udp') || rule.includes('-p tcp')) && rule.includes('--dport 53');
        if (!isWebMasq && !isDnsMasq) {
          return { ok: false, reason: `nat target contains unauthorized or widened MASQUERADE rule: ${rule}` };
        }
      } else if (rule.includes('-j ACCEPT')) {
        return { ok: false, reason: `nat target must not contain broad ACCEPT rules: ${rule}` };
      }
    }

    const hasWebMasq = targetRules.some((l) => l.includes('-j MASQUERADE') && (l.includes('80') || l.includes('443')));
    if (!hasWebMasq) {
      return { ok: false, reason: `missing scoped HTTP/HTTPS MASQUERADE rule for '${this.bridgeSubnet}'` };
    }
    for (const resolver of this.dnsResolvers) {
      const hasDnsUdpMasq = targetRules.some((l) => l.includes('-j MASQUERADE') && l.includes(`-d ${resolver}`) && l.includes('-p udp') && l.includes('--dport 53'));
      const hasDnsTcpMasq = targetRules.some((l) => l.includes('-j MASQUERADE') && l.includes(`-d ${resolver}`) && l.includes('-p tcp') && l.includes('--dport 53'));
      if (!hasDnsUdpMasq || !hasDnsTcpMasq) {
        return { ok: false, reason: `missing scoped UDP/TCP DNS MASQUERADE rule for resolver '${resolver}'` };
      }
    }

    return { ok: true };
  }

  /**
   * Plans a repair for a ruleset whose only defect is that a foreign rule (for
   * example Tailscale's `-A INPUT -j ts-input`) was inserted ahead of a managed
   * jump. Returns the jumps to move to the head of their chain when the ruleset
   * attests with exactly those moves, otherwise undefined. Moving a managed
   * jump earlier only puts the managed deny/egress policy in front of the
   * foreign rule; the bridge can never reach more than the attested egress
   * policy allows.
   */
  public planOrderingRepair(iptablesText: string): FirewallOrderingRepair[] | undefined {
    const lines = iptablesText.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.length > 0 && !l.startsWith('#'));
    const filterStart = lines.indexOf('*filter');
    if (filterStart === -1) return undefined;
    const commitOffset = lines.slice(filterStart).indexOf('COMMIT');
    const filterEnd = commitOffset === -1 ? lines.length : filterStart + commitOffset;
    const managedJump = (chain: string): string | undefined => {
      const prefix = `-A ${chain} -i ${this.bridgeInterface} -j `;
      return lines.slice(filterStart, filterEnd).find((l) => l.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(l.slice(prefix.length)));
    };
    const candidates: Array<[string, string | undefined]> = [
      ['FORWARD', lines.slice(filterStart, filterEnd).find((l) => l === '-A FORWARD -j DOCKER-USER')],
      ['INPUT', managedJump('INPUT')],
      ['DOCKER-USER', managedJump('DOCKER-USER')]
    ];
    const repairs: FirewallOrderingRepair[] = [];
    for (const [chain, rule] of candidates) {
      if (!rule) continue;
      const section = lines.slice(filterStart, filterEnd);
      const first = section.findIndex((l) => l.startsWith(`-A ${chain} `));
      const managed = section.indexOf(rule);
      if (first === -1 || managed <= first) continue;
      lines.splice(filterStart + managed, 1);
      lines.splice(filterStart + first, 0, rule);
      repairs.push({ chain, rule: rule.slice(`-A ${chain} `.length) });
    }
    if (repairs.length === 0) return undefined;
    return this.parseFirewallRules(lines.join('\n')).ok ? repairs : undefined;
  }

  private async probeFirewall(): Promise<{ ok: true; rules: string } | { ok: false; reason: string }> {
    const result = await runDocker([
      'run', '--rm', '--pull', 'never', '--network', 'host',
      '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
      '--security-opt', 'no-new-privileges',
      '--user', '0:0',
      this.networkGuardImage
    ], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      return { ok: false, reason: `host firewall probe failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { ok: true, rules: result.stdout };
  }

  // Moves every displaced managed jump in one iptables-restore transaction:
  // each `-D <spec>` removes the first (displaced) copy by rule spec, never by
  // position, and the matching `-I 1` re-adds it at the head. The commit is
  // atomic, so a concurrent writer can never make it delete a foreign rule, and
  // a jump that vanished since the probe fails the whole commit unchanged.
  private async applyOrderingRepair(repairs: FirewallOrderingRepair[]): Promise<{ ok: boolean; reason?: string }> {
    const lines = ['*filter'];
    for (const { chain, rule } of repairs) {
      if (!rule.split(' ').every((t) => /^[A-Za-z0-9_-]+$/.test(t))) {
        return { ok: false, reason: `refusing to repair unexpected managed jump in ${chain}: ${rule}` };
      }
      lines.push(`-D ${chain} ${rule}`, `-I ${chain} 1 ${rule}`);
    }
    lines.push('COMMIT', '');
    const result = await runDocker([
      'run', '--rm', '-i', '--pull', 'never', '--network', 'host',
      '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
      '--security-opt', 'no-new-privileges',
      '--user', '0:0',
      '--entrypoint', '/sbin/iptables-restore',
      this.networkGuardImage,
      '-w', '10', '--noflush'
    ], { stdin: lines.join('\n'), timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      return { ok: false, reason: `host firewall ordering repair failed (exit code ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { ok: true };
  }

  public async attestHostKernel(): Promise<{ ok: boolean; reason?: string; repaired?: FirewallOrderingRepair[] }> {
    // Concurrent opens, readiness checks, and the reaper attest at the same
    // time; serializing the whole probe/plan/repair/re-probe sequence keeps each
    // repair plan matched to the ruleset it was planned from.
    const run = this.attestationQueue.then(() => this.probeAndRepair());
    this.attestationQueue = run.catch(() => undefined);
    return await run;
  }

  private async probeAndRepair(): Promise<{ ok: boolean; reason?: string; repaired?: FirewallOrderingRepair[] }> {
    try {
      const probe = await this.probeFirewall();
      if (!probe.ok) return probe;
      const parsed = this.parseFirewallRules(probe.rules);
      if (parsed.ok) return parsed;

      const repairs = this.planOrderingRepair(probe.rules);
      if (!repairs) return parsed;
      const repaired = await this.applyOrderingRepair(repairs);
      if (!repaired.ok) return { ok: false, reason: `${parsed.reason}; ${repaired.reason}` };

      const reprobe = await this.probeFirewall();
      if (!reprobe.ok) return reprobe;
      const reparsed = this.parseFirewallRules(reprobe.rules);
      return reparsed.ok ? { ok: true, repaired: repairs } : { ok: false, reason: `${reparsed.reason} (after ordering repair)` };
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

      if (fwResult.repaired) {
        process.stderr.write(`${JSON.stringify({ level: 'warn', time: Date.now(), msg: 'host firewall managed jumps were moved back to the head of their chains', repaired: fwResult.repaired })}\n`);
        return { ok: true, details: { repaired: fwResult.repaired } };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `firewall attestation error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

function filterSection(lines: string[]): string[] | undefined {
  const start = lines.indexOf('*filter');
  if (start === -1) return undefined;
  const end = lines.indexOf('COMMIT', start);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}
