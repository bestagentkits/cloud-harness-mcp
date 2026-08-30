const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /authorization|api[-_]?key|token|lease|secret|credential|cookie|providerHeaders/i;
const SECRET_LIKE_TEXT = /(bearer\s+)[^\s"']+|\bsk-[A-Za-z0-9_-]{8,}\b/gi;

export interface Redactor {
  addSecret(secret: string): void;
  text(value: unknown, maxBytes?: number): string;
  value(value: unknown, maxBytes?: number): unknown;
  error(error: unknown): string;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  if (maxBytes <= 3) return '.'.repeat(maxBytes);
  const suffix = Buffer.from('…', 'utf8');
  return `${new TextDecoder().decode(encoded.subarray(0, maxBytes - suffix.length))}`.replace(/\uFFFD+$/u, '') + '…';
}

export function createRedactor(initialSecrets: readonly string[] = []): Redactor {
  const secrets = new Set(initialSecrets.filter((secret) => secret.length >= 4));

  const redactText = (value: unknown, maxBytes = 4_096): string => {
    let text = typeof value === 'string' ? value : String(value ?? '');
    text = text.replace(SECRET_LIKE_TEXT, (match, bearerPrefix: string | undefined) =>
      bearerPrefix ? `${bearerPrefix}${REDACTED}` : REDACTED);
    for (const secret of secrets) text = text.split(secret).join(REDACTED);
    return truncateUtf8(text, maxBytes);
  };

  const redactValue = (value: unknown, maxBytes = 64 * 1024): unknown => {
    let remaining = maxBytes;
    const visit = (current: unknown, depth: number, key?: string): unknown => {
      if (remaining <= 8) return '[TRUNCATED]';
      remaining -= 8;
      if (key && SENSITIVE_KEY.test(key)) return REDACTED;
      if (current === null || typeof current === 'boolean') return current;
      if (typeof current === 'number') return Number.isFinite(current) ? current : String(current);
      if (typeof current === 'string') {
        const redacted = redactText(current, remaining);
        remaining -= Buffer.byteLength(redacted);
        return redacted;
      }
      if (depth >= 8) return '[TRUNCATED]';
      if (Array.isArray(current)) return current.slice(0, 64).map((item) => visit(item, depth + 1));
      if (typeof current !== 'object') return redactText(current, remaining);
      const output: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(current as Record<string, unknown>).slice(0, 64)) {
        remaining -= Buffer.byteLength(childKey);
        if (remaining <= 0) break;
        output[childKey] = visit(child, depth + 1, childKey);
      }
      return output;
    };
    return visit(value, 0);
  };

  return {
    addSecret(secret) {
      if (secret.length >= 4) secrets.add(secret);
    },
    text: redactText,
    value: redactValue,
    error(error) {
      if (error instanceof Error) return redactText(error.message, 4_096);
      return redactText(error, 4_096);
    }
  };
}
