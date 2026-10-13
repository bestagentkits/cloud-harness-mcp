import { HarnessError, type ExecutorNetworkProfile, type RunnerConfig } from '@cloud-harness/contracts';
import { HostFirewallAttestor } from './host-firewall-attestor.js';

export class NetworkProfileManager {
  public readonly attestor: HostFirewallAttestor;

  constructor(
    public readonly config: RunnerConfig,
    attestor?: HostFirewallAttestor
  ) {
    this.attestor = attestor ?? new HostFirewallAttestor({
      networkName: config.dependencyNetworkName,
      bridgeInterface: config.dependencyBridgeInterface,
      bridgeSubnet: config.dependencyBridgeSubnet,
      dnsResolvers: config.dependencyDnsResolvers,
      networkGuardImage: config.networkGuardImage,
      executorImage: config.executorImage
    });
  }
  public async ensureProfileReady(profile: ExecutorNetworkProfile): Promise<void> {
    if (profile === 'network-none') {
      return;
    }

    let verification: { ok: boolean; reason?: string };
    try {
      verification = await this.attestor.verify();
    } catch (err) {
      throw new HarnessError(
        'DEPENDENCY_EGRESS_UNAVAILABLE',
        `dependency-access egress profile is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        503,
        false
      );
    }
    if (!verification.ok) {
      throw new HarnessError(
        'DEPENDENCY_EGRESS_UNAVAILABLE',
        `dependency-access egress profile is unavailable: ${verification.reason ?? 'verification failed'}`,
        503,
        false
      );
    }
  }

  public dockerLaunchArgs(profile: ExecutorNetworkProfile): string[] {
    if (profile === 'network-none') {
      return ['--network', 'none'];
    }

    const dnsArgs = (this.config.dependencyDnsResolvers ?? ['8.8.8.8', '1.1.1.1']).flatMap((r) => ['--dns', r]);
    return [
      '--network', this.config.dependencyNetworkName ?? 'cloud-harness-dependency-access',
      ...dnsArgs,
      '--label', 'cloud-harness.network-profile=dependency-access'
    ];
  }

  public async checkAttestation(): Promise<{ ok: boolean; reason?: string }> {
    return await this.attestor.verify();
  }
}
