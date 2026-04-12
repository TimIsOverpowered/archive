import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256 requires exactly 32 bytes
const IV_LENGTH = 12; // Recommended for GCM mode
const AUTH_TAG_LENGTH = 16;

export function validateEncryptionKey(key: string): boolean {
  if (!key) return false;
  if (key.length !== KEY_LENGTH * 2) return false; // Hex is double the byte length
  try {
    Buffer.from(key, 'hex');
    return true;
  } catch {
    return false;
  }
}

export function getKeyBuffer(): Buffer {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key || !validateEncryptionKey(key)) {
    throw new Error('ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string');
  }
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext: string): { ciphertext: Uint8Array } {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]);

  return { ciphertext: combined };
}

export function decrypt(ciphertext: Uint8Array): string {
  const key = getKeyBuffer();

  // Extract IV (first 12 bytes), auth tag (next 16 bytes), and actual ciphertext
  if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext length');
  }

  const iv = Buffer.from(ciphertext.subarray(0, IV_LENGTH));
  const authTag = Buffer.from(ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
  const encryptedData = Buffer.from(ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH)).toString('base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(Buffer.from(encryptedData, 'base64'));
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

export function encryptObject(obj: object): string {
  const plaintext = JSON.stringify(obj);
  const { ciphertext } = encrypt(plaintext);
  return Buffer.from(ciphertext).toString('base64');
}

export function decryptObject<T>(encryptedBase64: string): T {
  const ciphertext = Buffer.from(encryptedBase64, 'base64');
  const plaintext = decrypt(ciphertext);
  return JSON.parse(plaintext) as T;
}

export function encryptScalar(value: string): string {
  const { ciphertext } = encrypt(value);
  return Buffer.from(ciphertext).toString('base64');
}

export function decryptScalar(encryptedBase64: string): string {
  const ciphertext = Buffer.from(encryptedBase64, 'base64');
  return decrypt(ciphertext);
}
