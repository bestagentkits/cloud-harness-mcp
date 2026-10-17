import { createHmac } from 'node:crypto';

/**
 * Standard Webhooks signing: `v1,<base64 HMAC-SHA256(key, "{id}.{timestamp}.{body}")>`, where the
 * key is the base64 payload after the `whsec_` prefix. Several secrets (a rotation window) produce
 * space-separated signatures over the same bytes.
 */
export function signWebhook(secrets: readonly string[], id: string, timestampSeconds: number, body: string): string {
  return secrets.map((secret) => {
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
    try {
      const digest = createHmac('sha256', key).update(`${id}.${timestampSeconds}.${body}`, 'utf8').digest('base64');
      return `v1,${digest}`;
    } finally {
      key.fill(0);
    }
  }).join(' ');
}
