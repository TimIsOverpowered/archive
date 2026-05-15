import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  encrypt,
  decrypt,
  encryptScalar,
  decryptScalar,
  encryptObject,
  decryptObject,
  validateEncryptionKey,
} from '../../src/utils/encryption.js';

describe('Encryption', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateEncryptionKey', () => {
    it('should validate correct 32-byte hex key', () => {
      assert.strictEqual(
        validateEncryptionKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
        true
      );
    });

    it('should reject key that is too short', () => {
      assert.strictEqual(validateEncryptionKey('0123456789abcdef'), false);
    });

    it('should reject key that is too long', () => {
      assert.strictEqual(validateEncryptionKey('0123456789abcdef0123456789abcdef0123'), false);
    });

    it('should reject invalid hex characters', () => {
      assert.strictEqual(validateEncryptionKey('0123456789abcdef0123456789abcdefg'), false);
    });

    it('should reject key with correct length but invalid hex characters', () => {
      assert.strictEqual(validateEncryptionKey('z'.repeat(64)), false);
    });

    it('should reject empty key', () => {
      assert.strictEqual(validateEncryptionKey(''), false);
    });
  });

  describe('encrypt', () => {
    it('should encrypt plaintext and return ciphertext buffer', () => {
      const plaintext = 'sensitive data';
      const result = encrypt(plaintext);

      assert.ok(result instanceof Buffer);
      assert.ok(result instanceof Uint8Array);
    });

    it('should produce different ciphertext for same plaintext (due to random IV)', () => {
      const plaintext = 'same data';
      const result1 = encrypt(plaintext);
      const result2 = encrypt(plaintext);

      assert.notDeepStrictEqual(result1, result2);
    });

    it('should handle empty string', () => {
      const result = encrypt('');
      assert.ok(result.length > 0);
    });

    it('should handle special characters', () => {
      const plaintext = 'special!@#$%^&*()chars';
      const result = encrypt(plaintext);
      assert.ok(result.length > 0);
    });
  });

  describe('decrypt', () => {
    it('should decrypt ciphertext back to original plaintext', () => {
      const original = 'secret message';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);

      assert.strictEqual(decrypted, original);
    });

    it('should handle encrypt-decrypt round-trip', () => {
      const testCases = [
        'simple text',
        'text with spaces and punctuation!',
        'unicode: café',
        'numbers: 12345',
        'mixed: Hello 世界 123',
      ];

      for (const testCase of testCases) {
        const encrypted = encrypt(testCase);
        const decrypted = decrypt(encrypted);
        assert.strictEqual(decrypted, testCase);
      }
    });

    it('should reject tampered ciphertext', () => {
      const original = 'secret';
      const encrypted = encrypt(original);
      const tampered = new Uint8Array(encrypted);
      tampered[tampered.length - 1] = 0xff;

      assert.throws(() => decrypt(tampered));
    });

    it('should reject truncated ciphertext', () => {
      const original = 'secret';
      const encrypted = encrypt(original);
      const truncated = encrypted.subarray(0, 10);

      assert.throws(() => decrypt(truncated));
    });
  });

  describe('encryptScalar and decryptScalar', () => {
    it('should encrypt and decrypt scalar values', () => {
      const original = 'test value';
      const encrypted = encryptScalar(original);
      const decrypted = decryptScalar(encrypted);

      assert.strictEqual(decrypted, original);
    });

    it('should return base64 string', () => {
      const encrypted = encryptScalar('test');
      assert.strictEqual(typeof encrypted, 'string');
      assert.match(encrypted, /^[A-Za-z0-9+/=]+$/);
    });
  });

  describe('encryptObject and decryptObject', () => {
    it('should encrypt and decrypt objects', () => {
      const original = { foo: 'bar', num: 42, arr: [1, 2, 3] };
      const encrypted = encryptObject(original);
      const decrypted = decryptObject<typeof original>(encrypted);

      assert.deepStrictEqual(decrypted, original);
    });

    it('should handle nested objects', () => {
      const original = { nested: { deep: { value: 'test' } } };
      const encrypted = encryptObject(original);
      const decrypted = decryptObject<typeof original>(encrypted);

      assert.deepStrictEqual(decrypted, original);
    });
  });
});
