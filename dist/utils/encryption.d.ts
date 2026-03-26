export declare function validateEncryptionKey(key: string): boolean;
export declare function getKeyBuffer(): Buffer;
export declare function encrypt(plaintext: string): {
    ciphertext: Uint8Array;
    iv: Uint8Array;
};
export declare function decrypt(ciphertext: Uint8Array): string;
export declare function encryptObject(obj: object): string;
export declare function decryptObject<T>(encryptedBase64: string): T;
export declare function encryptScalar(value: string): string;
export declare function decryptScalar(encryptedBase64: string): string;
//# sourceMappingURL=encryption.d.ts.map