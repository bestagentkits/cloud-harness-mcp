import {
  AgentProxyOperationSchema,
  CODING_PROXY_OPERATIONS,
  type AgentProxyOperation,
  type TraceCoverage
} from '@cloud-harness/contracts';

/**
 * What a coding runtime can do and how the harness sees it. Brokered actions go through the runner's
 * proxy, so each one is decided by the gate and recorded as a receipt and a trace span. Native actions
 * are ones the runtime performs inside its own process (a built-in shell, its own file writes); the
 * harness cannot decide or observe them, so a runtime that declares any yields partial trace coverage.
 */
export type RuntimeActionManifest = {
  readonly runtimeId: string;
  readonly brokered: readonly AgentProxyOperation[];
  readonly native: readonly string[];
};

/**
 * The Pi runtime: every tool it has is a proxy tool, so every action is brokered and the trace is
 * complete. Its tool set for a coding workflow is exactly the coding proxy operations.
 */
export const PI_RUNTIME_MANIFEST: RuntimeActionManifest = Object.freeze({
  runtimeId: 'pi',
  brokered: Object.freeze([...CODING_PROXY_OPERATIONS]),
  native: Object.freeze([])
});

export type RuntimeConformance =
  | { ok: true; coverage: TraceCoverage; operations: AgentProxyOperation[] }
  | { ok: false; unsupported: string[] };

/**
 * Checks a runtime manifest against the actions a run asks for. An action the manifest does not broker
 * is refused, never silently dropped or run natively: the run fails closed. A manifest that names an
 * operation the proxy does not know is itself invalid.
 */
export function conformRuntime(manifest: RuntimeActionManifest, requested: readonly string[]): RuntimeConformance {
  const known = manifest.brokered.filter((operation) => AgentProxyOperationSchema.safeParse(operation).success);
  const invalid = manifest.brokered.filter((operation) => !known.includes(operation));
  const unsupported = [...invalid, ...requested.filter((operation) => !(known as readonly string[]).includes(operation))];
  if (unsupported.length > 0) return { ok: false, unsupported: [...new Set(unsupported)].sort() };
  return { ok: true, coverage: manifest.native.length === 0 ? 'full' : 'partial', operations: [...new Set(requested)] as AgentProxyOperation[] };
}
