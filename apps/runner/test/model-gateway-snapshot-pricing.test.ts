import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelProfileIdSchema } from '@cloud-harness/contracts';
import { ModelProfileStateRepository } from '../src/model-profile-state-repository.js';
import { SecretKeyring } from '../src/secret-keyring.js';
import { StateStore } from '../src/state-store.js';
// The gateway owns snapshot pricing validation; the runner owns what it exports.
// Importing the gateway parser keeps the two bounds from drifting apart.
import { parsePricing } from '../../model-gateway/src/config.js';

describe('gateway snapshot pricing compatibility', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const step of cleanup.splice(0)) step();
  });

  it('exports contract-valid extreme prices that the gateway snapshot parser accepts', () => {
    const dbPath = join(tmpdir(), `test-snapshot-pricing-${randomBytes(8).toString('hex')}.sqlite`);
    const store = new StateStore(dbPath);
    cleanup.push(() => {
      store.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    });
    const repo = new ModelProfileStateRepository(store.database, new SecretKeyring(1, [{ version: 1, key: randomBytes(32) }]));
    const principal = store.resolvePrincipal({ kind: 'owner', ownerId: 'user-pricing' });
    const credential = repo.createCredential(principal, { label: 'Pricing', provider: 'openai', apiKey: 'sk-pricing-test-key' });
    const pricing = { inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER, outputMicrosPerMillionTokens: 5_000_000_000 };
    const profile = repo.createProfile(principal, {
      profileId: ModelProfileIdSchema.parse('extreme-pricing'),
      displayName: 'Extreme pricing',
      credentialId: credential.id,
      model: 'gpt-5.2',
      apiMode: 'chat-completions',
      pricing,
      limits: { maxInputTokens: 50_000, maxOutputTokens: 2_000, maxCostMicros: 100_000 },
      maxProxyOperations: ['files_read']
    });

    const exported = repo.getExportSnapshot(principal).profiles[profile.activeRevisionId!] as { pricing: unknown };
    expect(exported.pricing).toEqual(pricing);
    expect(parsePricing(exported.pricing, 'pricing', { strictKeys: false, baseDefault: 0 })).toEqual(pricing);
  });
});
