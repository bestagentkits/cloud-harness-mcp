import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type SecretContext = {
  principalId: string;
  environmentId: string;
  name: string;
  version: number;
};

export type EncryptedSecret = {
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export type SecretKeyConfig = {
  version: number;
  key: Buffer | string;
};

function associatedData(context: SecretContext): Buffer {
  return Buffer.from(JSON.stringify([
    context.principalId,
    context.environmentId,
    context.name,
    context.version
  ]), 'utf8');
}

function decodeKey(value: Buffer | string): Buffer {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('secret key must decode to exactly 32 bytes');
  return key;
}

export class SecretKeyring {
  readonly activeVersion: number;
  private readonly keys = new Map<number, Buffer>();

  constructor(activeVersion: number, configuredKeys: SecretKeyConfig[]) {
    if (!Number.isSafeInteger(activeVersion) || activeVersion < 1) throw new Error('invalid active secret key version');
    for (const configured of configuredKeys) {
      if (!Number.isSafeInteger(configured.version) || configured.version < 1) throw new Error('invalid secret key version');
      if (this.keys.has(configured.version)) throw new Error(`duplicate secret key version ${configured.version}`);
      this.keys.set(configured.version, decodeKey(configured.key));
    }
    if (!this.keys.has(activeVersion)) throw new Error(`active secret key version ${activeVersion} is unavailable`);
    this.activeVersion = activeVersion;
  }

  encrypt(value: string | Uint8Array, context: SecretContext): EncryptedSecret {
    const plaintext = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    try {
      return this.encryptBuffer(plaintext, context);
    } finally {
      plaintext.fill(0);
    }
  }

  verify(encrypted: EncryptedSecret, context: SecretContext): void {
    const plaintext = this.decryptBuffer(encrypted, context);
    plaintext.fill(0);
  }

  decrypt(encrypted: EncryptedSecret, context: SecretContext): string {
    const plaintext = this.decryptBuffer(encrypted, context);
    try { return plaintext.toString('utf8'); }
    finally { plaintext.fill(0); }
  }

  assertAvailableVersions(versions: Iterable<number>): void {
    for (const version of versions) {
      if (!this.keys.has(version)) throw new Error(`unknown secret key version ${version}`);
    }
  }

  reencrypt(encrypted: EncryptedSecret, context: SecretContext): EncryptedSecret {
    const plaintext = this.decryptBuffer(encrypted, context);
    try {
      return this.encryptBuffer(plaintext, context);
    } finally {
      plaintext.fill(0);
    }
  }

  close(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  private encryptBuffer(plaintext: Buffer, context: SecretContext): EncryptedSecret {
    const key = this.keys.get(this.activeVersion)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(associatedData(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { keyVersion: this.activeVersion, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  private decryptBuffer(encrypted: EncryptedSecret, context: SecretContext): Buffer {
    const key = this.keys.get(encrypted.keyVersion);
    if (!key) throw new Error(`unknown secret key version ${encrypted.keyVersion}`);
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce, { authTagLength: 16 });
    decipher.setAAD(associatedData(context));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  }
}
