import crypto from 'node:crypto';
import { getEncryptionKeyBuffer } from '../config/env.js';
import { Encryption } from '../constants.js';

const ALGORITHM = 'aes-256-gcm';

export function validateEncryptionKey(key: string): boolean {
  if (key == null || key === '') return false;
  if (key.length !== Encryption.KEY_LENGTH * 2) return false;
  return /^[0-9a-fA-F]+$/.test(key);
}

export function encrypt(plaintext: string): Buffer {
  const key = getEncryptionKeyBuffer();
  const iv = crypto.randomBytes(Encryption.IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);

  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined;
}

export function decrypt(ciphertext: Uint8Array): string {
  const key = getEncryptionKeyBuffer();

  // Extract IV (first 12 bytes), auth tag (next 16 bytes), and actual ciphertext
  if (ciphertext.length < Encryption.IV_LENGTH + Encryption.AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext length');
  }

  const iv = Buffer.from(ciphertext.subarray(0, Encryption.IV_LENGTH));
  const authTag = Buffer.from(
    ciphertext.subarray(Encryption.IV_LENGTH, Encryption.IV_LENGTH + Encryption.AUTH_TAG_LENGTH)
  );
  const encryptedData = ciphertext.subarray(Encryption.IV_LENGTH + Encryption.AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

export function encryptObject(obj: object): string {
  return encryptScalar(JSON.stringify(obj));
}

export function decryptObject<T>(encryptedBase64: string): T {
  const ciphertext = Buffer.from(encryptedBase64, 'base64');
  const plaintext = decrypt(ciphertext);
  return JSON.parse(plaintext) as T;
}

export function encryptScalar(value: string): string {
  return encrypt(value).toString('base64');
}

export function decryptScalar(encryptedBase64: string): string {
  const ciphertext = Buffer.from(encryptedBase64, 'base64');
  return decrypt(ciphertext);
}
