"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEncryptionKey = validateEncryptionKey;
exports.getKeyBuffer = getKeyBuffer;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.encryptObject = encryptObject;
exports.decryptObject = decryptObject;
exports.encryptScalar = encryptScalar;
exports.decryptScalar = decryptScalar;
const crypto_1 = __importDefault(require("crypto"));
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256 requires exactly 32 bytes
const IV_LENGTH = 12; // Recommended for GCM mode
const AUTH_TAG_LENGTH = 16;
function validateEncryptionKey(key) {
    if (!key)
        return false;
    if (key.length !== KEY_LENGTH * 2)
        return false; // Hex is double the byte length
    try {
        Buffer.from(key, 'hex');
        return true;
    }
    catch {
        return false;
    }
}
function getKeyBuffer() {
    const key = process.env.ENCRYPTION_MASTER_KEY;
    if (!key || !validateEncryptionKey(key)) {
        throw new Error('ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string');
    }
    return Buffer.from(key, 'hex');
}
function encrypt(plaintext) {
    const key = getKeyBuffer();
    const iv = crypto_1.default.randomBytes(IV_LENGTH);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    // Prepend IV and auth tag to ciphertext for storage
    const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]);
    return {
        ciphertext: combined,
        iv: iv.subarray(),
    };
}
function decrypt(ciphertext) {
    const key = getKeyBuffer();
    // Extract IV (first 12 bytes), auth tag (next 16 bytes), and actual ciphertext
    if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('Invalid ciphertext length');
    }
    const iv = Buffer.from(ciphertext.subarray(0, IV_LENGTH));
    const authTag = Buffer.from(ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
    const encryptedData = Buffer.from(ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH)).toString('base64');
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(Buffer.from(encryptedData, 'base64'));
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}
function encryptObject(obj) {
    const plaintext = JSON.stringify(obj);
    const { ciphertext } = encrypt(plaintext);
    return Buffer.from(ciphertext).toString('base64');
}
function decryptObject(encryptedBase64) {
    const ciphertext = Buffer.from(encryptedBase64, 'base64');
    const plaintext = decrypt(ciphertext);
    return JSON.parse(plaintext);
}
function encryptScalar(value) {
    const { ciphertext } = encrypt(value);
    return Buffer.from(ciphertext).toString('base64');
}
function decryptScalar(encryptedBase64) {
    const ciphertext = Buffer.from(encryptedBase64, 'base64');
    return decrypt(ciphertext);
}
//# sourceMappingURL=encryption.js.map