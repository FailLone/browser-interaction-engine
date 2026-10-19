import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { snapshotSchema, type SessionSnapshot } from './snapshot.js';

/**
 * A 32-byte key given as 64 hex characters or base64; anything else is taken as a passphrase
 * and hashed. Keys come from the host (environment, secret manager), never from the repository.
 */
export function keyFrom(secret: string | Buffer): Buffer {
  if (Buffer.isBuffer(secret)) {
    if (secret.length !== 32) throw new Error('Key must be 32 bytes');
    return secret;
  }
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  const b64 = Buffer.from(secret, 'base64');
  if (b64.length === 32 && /^[A-Za-z0-9+/]+=*$/.test(secret)) return b64;
  if (secret.length < 16) throw new Error('Key is too short');
  return createHash('sha256').update(secret).digest();
}

/** AES-256-GCM: 12-byte IV, 16-byte tag, ciphertext. Tampered or wrongly keyed data throws. */
export function seal(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}
export function unseal(sealed: Buffer, key: Buffer): Buffer {
  if (sealed.length < 29) throw new Error('Sealed data is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

/** Snapshots at rest, encrypted with this project's own key (never the exporter's). */
export class Vault {
  private readonly key: Buffer;
  constructor(key: string | Buffer) {
    this.key = keyFrom(key);
  }
  seal(snapshot: SessionSnapshot) {
    return seal(Buffer.from(JSON.stringify(snapshotSchema.parse(snapshot))), this.key);
  }
  open(sealed: Buffer): SessionSnapshot {
    return snapshotSchema.parse(JSON.parse(unseal(sealed, this.key).toString('utf8')));
  }
}
