import { ACTION_LIMITS } from 'dewee-webchat/server';

/**
 * The Dashboard webchat sends a page context the agent reads as data. The page is built to
 * send only non-secret summary state, but this server still strips anything secret-shaped
 * before the context leaves for the Dewee gateway and its LLM provider: a page bug or a
 * hostile script must not be able to exfiltrate a credential through the chat.
 */

/** Thrown for a request the webchat contract answers with a typed JSON error before streaming. */
export class DeweeInputError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'DeweeInputError';
  }
}

const REDACTED = '[redacted]';
const MAX_DEPTH = 32;
// Bare `key` and `value` fields are redacted fail-safe, so page-context fields must use more
// specific names (for example `filterValue`) to reach the agent.
const SECRET_KEY = /token|secret|passw(?:or)?d|passphrase|pwd|api[-_]?key|(?:access|signing|encryption|master|client)[-_]?key|authori[sz]ation|cookie|credential|private[-_]?key|bearer|csrf|session[-_]?id|signature|^(?:key|value|pass|auth)$/i;
const SECRET_VALUES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bchm_key_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`]
];

// Long hex keeps a 40-character git commit id readable; longer runs are digests or keys.
const LONG_HEX = /\b[0-9a-fA-F]{41,}\b/g;
// `/` is left out so a route is judged segment by segment, never as one long run.
const LONG_BASE64 = /[A-Za-z0-9+_-]{32,}={0,2}/g;
/**
 * Public resource ids are a prefix plus random base64url, which the entropy check would
 * otherwise redact, yet they are exactly what page context carries. Each prefix is pinned to
 * the exact length its generator produces:
 * - 32 chars, `randomBytes(24)`: `opaqueId` (runner `metadata-records.ts`), `id` (runner
 *   `operation-manager.ts`), agents, artifacts, principals and model spend;
 * - 22 chars, `randomBytes(16)`: repository caches, memories and event deliveries;
 * - 24 chars: MCP gateway tool ids (`apps/api/src/mcp-gateway/catalog.ts`).
 * Ids built from lowercase hex (skills, knowledge, credentials, events) never trip the
 * heuristics and are not listed, so `sk_live_…`-style keys get no pass. Credential-bearing
 * prefixes (gateway `lease_`, API key `apk_`/`chm_key_`) are deliberately not listed.
 * The single capture group makes `split` return the ids at odd indexes.
 */
const PUBLIC_ID = /(?<![A-Za-z0-9_-])((?:ws|agent|task|sess|term|art|env|prj|mcps|mcpg|msp|prn)_[A-Za-z0-9_-]{32}|(?:rc|mem|dlv)_[A-Za-z0-9_-]{22}|mcpt_[A-Za-z0-9_-]{24})(?![A-Za-z0-9_-])/;

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / value.length) * Math.log2(count / value.length);
  return bits;
}

/** A base64/base64url run that mixes cases and digits and looks random, unlike a path or slug. */
function looksLikeKey(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && entropy(value) >= 4;
}

/** Applies the long-hex and random-base64 heuristics to text that holds no public id. */
function redactRandom(text: string): string {
  return text.replace(LONG_HEX, REDACTED).replace(LONG_BASE64, (match) => looksLikeKey(match) ? REDACTED : match);
}

function redactString(value: string): string {
  let output = value;
  for (const [pattern, replacement] of SECRET_VALUES) output = output.replace(pattern, replacement);
  // Public ids sit at odd indexes and pass through; only the text between them is checked.
  return output.split(PUBLIC_ID).map((part, index) => index % 2 ? part : redactRandom(part)).join('');
}

/** Returns a copy with secret-named fields and secret-shaped strings replaced by a marker. */
export function sanitizeDeweePageContext(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeDeweePageContext(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : sanitizeDeweePageContext(entry, depth + 1);
  }
  return output;
}

/**
 * Serializes the sanitized page context for the `[[dewee-page v1]]` block, or undefined when
 * the request has none. Oversized context is refused with `413 context_too_large`.
 */
export function serializeDeweePageContext(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const limit = ACTION_LIMITS.maxPageContextBytes;
  const tooLarge = () => new DeweeInputError(`pageContext exceeds ${limit} bytes`, 'context_too_large', 413);
  if (byteLength(JSON.stringify(input)) > limit) throw tooLarge();
  const serialized = JSON.stringify(sanitizeDeweePageContext(input));
  if (byteLength(serialized) > limit) throw tooLarge();
  return serialized;
}
