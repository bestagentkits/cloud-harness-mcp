import { describe, expect, it } from 'vitest';
import { SecretKeyring } from '../src/secret-keyring.js';

const context = { principalId: 'principal-a', environmentId: 'environment-a', name: 'API_TOKEN', version: 1 };

describe('SecretKeyring', () => {
  it('binds ciphertext to all associated-data fields', () => {
    const keyring = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 1) }]);
    const encrypted = keyring.encrypt('highly-sensitive-value', context);
    expect(() => keyring.verify(encrypted, context)).not.toThrow();
    expect(() => keyring.verify(encrypted, { ...context, principalId: 'principal-b' })).toThrow();
    expect(() => keyring.verify(encrypted, { ...context, environmentId: 'environment-b' })).toThrow();
    expect(() => keyring.verify(encrypted, { ...context, name: 'OTHER_TOKEN' })).toThrow();
    expect(() => keyring.verify(encrypted, { ...context, version: 2 })).toThrow();
    keyring.close();
  });

  it('decrypts retained versions only for re-encryption and fails closed for unknown keys', () => {
    const old = new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(32, 1) }]);
    const encrypted = old.encrypt('rotate-me', context);
    old.close();

    const mixed = new SecretKeyring(2, [
      { version: 1, key: Buffer.alloc(32, 1) },
      { version: 2, key: Buffer.alloc(32, 2) }
    ]);
    expect(() => mixed.verify(encrypted, context)).not.toThrow();
    const reencrypted = mixed.reencrypt(encrypted, context);
    expect(reencrypted.keyVersion).toBe(2);
    expect(() => mixed.verify(reencrypted, context)).not.toThrow();
    mixed.close();

    const activeOnly = new SecretKeyring(2, [{ version: 2, key: Buffer.alloc(32, 2) }]);
    expect(() => activeOnly.verify(encrypted, context)).toThrow('unknown secret key version 1');
    activeOnly.close();
  });

  it('requires one available active 256-bit key and unique versions', () => {
    expect(() => new SecretKeyring(2, [{ version: 1, key: Buffer.alloc(32) }])).toThrow('active secret key version 2 is unavailable');
    expect(() => new SecretKeyring(1, [{ version: 1, key: Buffer.alloc(31) }])).toThrow('exactly 32 bytes');
    expect(() => new SecretKeyring(1, [
      { version: 1, key: Buffer.alloc(32) }, { version: 1, key: Buffer.alloc(32) }
    ])).toThrow('duplicate secret key version');
  });
});
