import { expect } from 'chai';
import { encrypt, decrypt, encryptScalar, decryptScalar, encryptObject, decryptObject, validateEncryptionKey } from '../../src/utils/encryption';

describe('Encryption', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', // 32 bytes hex (64 chars)
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateEncryptionKey', () => {
    it('should validate correct 32-byte hex key', () => {
      expect(validateEncryptionKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).to.be.true;
    });

    it('should reject key that is too short', () => {
      expect(validateEncryptionKey('0123456789abcdef')).to.be.false;
    });

    it('should reject key that is too long', () => {
      expect(validateEncryptionKey('0123456789abcdef0123456789abcdef0123')).to.be.false;
    });

    it('should reject invalid hex characters', () => {
      expect(validateEncryptionKey('0123456789abcdef0123456789abcdefg')).to.be.false;
    });

    it('should reject empty key', () => {
      expect(validateEncryptionKey('')).to.be.false;
    });
  });

  describe('encrypt', () => {
    it('should encrypt plaintext and return ciphertext', () => {
      const plaintext = 'sensitive data';
      const result = encrypt(plaintext);

      expect(result).to.have.property('ciphertext');
      expect(result.ciphertext).to.be.an('Uint8Array');
    });

    it('should produce different ciphertext for same plaintext (due to random IV)', () => {
      const plaintext = 'same data';
      const result1 = encrypt(plaintext);
      const result2 = encrypt(plaintext);

      expect(result1.ciphertext).to.not.deep.equal(result2.ciphertext);
    });

    it('should handle empty string', () => {
      const result = encrypt('');
      expect(result.ciphertext).to.exist;
    });

    it('should handle special characters', () => {
      const plaintext = 'special!@#$%^&*()chars';
      const result = encrypt(plaintext);
      expect(result.ciphertext).to.exist;
    });
  });

  describe('decrypt', () => {
    it('should decrypt ciphertext back to original plaintext', () => {
      const original = 'secret message';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted.ciphertext);

      expect(decrypted).to.equal(original);
    });

    it('should handle encrypt-decrypt round-trip', () => {
      const testCases = ['simple text', 'text with spaces and punctuation!', 'unicode: café', 'numbers: 12345', 'mixed: Hello 世界 123'];

      for (const testCase of testCases) {
        const encrypted = encrypt(testCase);
        const decrypted = decrypt(encrypted.ciphertext);
        expect(decrypted).to.equal(testCase);
      }
    });

    it('should reject tampered ciphertext', () => {
      const original = 'secret';
      const encrypted = encrypt(original);
      const tampered = new Uint8Array(encrypted.ciphertext);
      tampered[tampered.length - 1] = 0xff;

      expect(() => decrypt(tampered)).to.throw();
    });

    it('should reject truncated ciphertext', () => {
      const original = 'secret';
      const encrypted = encrypt(original);
      const truncated = encrypted.ciphertext.slice(0, 10);

      expect(() => decrypt(truncated)).to.throw();
    });
  });

  describe('encryptScalar and decryptScalar', () => {
    it('should encrypt and decrypt scalar values', () => {
      const original = 'test value';
      const encrypted = encryptScalar(original);
      const decrypted = decryptScalar(encrypted);

      expect(decrypted).to.equal(original);
    });

    it('should return base64 string', () => {
      const encrypted = encryptScalar('test');
      expect(typeof encrypted).to.equal('string');
      expect(encrypted).to.match(/^[A-Za-z0-9+/=]+$/);
    });
  });

  describe('encryptObject and decryptObject', () => {
    it('should encrypt and decrypt objects', () => {
      const original = { foo: 'bar', num: 42, arr: [1, 2, 3] };
      const encrypted = encryptObject(original);
      const decrypted = decryptObject<typeof original>(encrypted);

      expect(decrypted).to.deep.equal(original);
    });

    it('should handle nested objects', () => {
      const original = { nested: { deep: { value: 'test' } } };
      const encrypted = encryptObject(original);
      const decrypted = decryptObject<typeof original>(encrypted);

      expect(decrypted).to.deep.equal(original);
    });
  });
});
