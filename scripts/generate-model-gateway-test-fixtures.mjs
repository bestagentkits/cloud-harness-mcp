import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outputRoot = resolve(process.argv[2] ?? join(process.cwd(), '.cloud-harness-test-fixtures', 'model-gateway'));
const keyPath = join(outputRoot, 'server-key.pem');
const certificatePath = join(outputRoot, 'server-cert.pem');
const credentialPath = join(outputRoot, 'provider-api-key');

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
await writeFile(credentialPath, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
const generated = spawnSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
  '-subj', '/CN=fake-provider',
  '-addext', 'subjectAltName=DNS:fake-provider,DNS:localhost,IP:127.0.0.1',
  '-keyout', keyPath,
  '-out', certificatePath
], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
if (generated.status !== 0) {
  throw new Error(`openssl could not generate test-only TLS fixtures: ${generated.stderr.trim()}`);
}
// The parent stays owner-only; mounted files must be readable by the image's non-root UID on Linux CI.
await Promise.all([chmod(keyPath, 0o444), chmod(certificatePath, 0o444), chmod(credentialPath, 0o444)]);
console.log(`model-gateway-test-fixtures=${outputRoot}`);
