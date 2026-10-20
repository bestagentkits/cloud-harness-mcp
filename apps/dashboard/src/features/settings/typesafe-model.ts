/**
 * The TypeSafe integration's read side: `GET /typesafe/status` (configured, egress, endpoint,
 * model) and the owner's TypeSafe credential metadata from `GET /integration-credentials`
 * (never a value). The key write stays on the classic page until it moves here.
 */

export type TypesafeStatus = { configured: boolean; enabled: boolean; endpoint: string | undefined; model: string | undefined };
export type TypesafeCredential = { label: string | undefined; activeVersion: number | string | undefined };

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown, max = 300): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

export function readTypesafeStatus(raw: unknown): TypesafeStatus {
  const status = record(raw) ?? {};
  return { configured: status.configured === true, enabled: status.enabled === true, endpoint: text(status.endpoint), model: text(status.model, 120) };
}

/** Only the display fields of the owner's TypeSafe credential; its id and generation stay out of the page. */
export function readTypesafeCredential(raw: unknown): TypesafeCredential | undefined {
  const list = record(raw)?.credentials;
  if (!Array.isArray(list)) return undefined;
  const credential = list.map(record).find((entry) => entry?.integration === 'typesafe');
  if (!credential) return undefined;
  const version = credential.activeVersion;
  return {
    label: text(credential.label, 120),
    activeVersion: typeof version === 'number' && Number.isFinite(version) ? version : text(version, 40)
  };
}
