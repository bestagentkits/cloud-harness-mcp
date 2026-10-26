import { setNonce } from 'get-nonce';

/**
 * The API serves `index.html` with a fresh per-response nonce in the CSP `style-src`
 * directive and on `<meta property="csp-nonce">` (Vite's `html.cspNonce`). Radix's scroll
 * lock injects a `<style>` element through `react-style-singleton`, which reads the nonce
 * from `get-nonce`; without it the browser would block that style under the strict CSP.
 * Scripts never need the nonce: `script-src` stays `'self'`.
 */
export function installCspNonce(doc: Document = document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  // Browsers hide the `nonce` content attribute after parsing; the IDL property keeps it.
  const nonce = meta?.nonce || meta?.getAttribute('nonce') || undefined;
  if (nonce && !nonce.startsWith('__')) setNonce(nonce);
  return nonce;
}
