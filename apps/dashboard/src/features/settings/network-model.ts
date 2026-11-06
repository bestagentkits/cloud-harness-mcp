/**
 * The instance default network profile (`GET/POST /settings` → `defaultNetworkProfile`) and
 * the egress readiness probe (`POST /settings/network-check`). Both answers are unmapped
 * runner passthroughs (parity matrix F7), so only the known values are read.
 */

export const NETWORK_PROFILES = ['dependency-access', 'network-none'] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

export const NETWORK_OPTIONS: ReadonlyArray<{ value: NetworkProfile; label: string }> = [
  { value: 'dependency-access', label: 'Dependency access — public DNS and TCP 80/443 egress; required for gh and the GitHub API' },
  { value: 'network-none', label: 'No network — air-gapped isolation' }
];

/** `''` in the select means "use the runner default", which the API stores as `null`. */
export type NetworkSelection = NetworkProfile | '';

export type NetworkProfileView = { value: NetworkProfile; stored: boolean };
export type Readiness = { ready: boolean; reason: string | undefined };

export function networkProfileLabel(profile: NetworkProfile): string {
  return profile === 'network-none' ? 'No network' : 'Dependency access';
}

/**
 * The effective profile and whether this dashboard stored it. Anything but an explicit
 * `network-none` is the shipped `dependency-access` default, as the classic page reads it.
 */
export function readNetworkProfile(raw: unknown): NetworkProfileView {
  const profile = raw && typeof raw === 'object' ? (raw as { value?: unknown; source?: unknown }) : {};
  return { value: profile.value === 'network-none' ? 'network-none' : 'dependency-access', stored: profile.source === 'setting' };
}

/** The select's initial value: the stored profile, or the runner default when nothing is stored. */
export function networkSelection(view: NetworkProfileView): NetworkSelection {
  return view.stored ? view.value : '';
}

export function readReadiness(raw: unknown): Readiness {
  const data = raw && typeof raw === 'object' ? (raw as { ready?: unknown; reason?: unknown }) : {};
  return { ready: data.ready === true, reason: typeof data.reason === 'string' && data.reason ? data.reason.slice(0, 400) : undefined };
}

export function readinessMessage(readiness: Readiness): string {
  return readiness.ready ? 'Egress readiness confirmed.' : `Egress is not ready: ${readiness.reason ?? 'the readiness probe reported no reason'}`;
}
