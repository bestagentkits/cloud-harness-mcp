import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { HarnessError } from '@cloud-harness/contracts';

function isPrivate(address: string): boolean {
  if (address === '::1' || address === '0.0.0.0' || address === '::') return true;
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  const normalized = address.toLowerCase();
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export async function validateRepositoryUrl(raw: string, allowedHosts: string[]): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HarnessError('INVALID_INPUT', 'repositoryUrl must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new HarnessError('INVALID_INPUT', 'only credential-free HTTPS repository URLs on port 443 are allowed');
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) throw new HarnessError('FORBIDDEN', 'repository host is not allowlisted', 403);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivate(address))) {
    throw new HarnessError('FORBIDDEN', 'repository host resolves to a forbidden network', 403);
  }
  return url;
}
