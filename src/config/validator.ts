import { validateEncryptionKey } from '../utils/encryption';

export function validateEnvironment(): void {
    if (!process.env.META_DATABASE_URL) throw new Error('META_DATABASE_URL is required');
    
    if (!validateEncryptionKey(process.env.ENCRYPTION_MASTER_KEY || '')) {
        throw new Error(
            'ENCRYPTION_MASTER_KEY must be set and exactly 32 characters (64 hex chars for AES-256)'
        );
    }

    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');

    if (!process.env.REDIS_URL) {
        console.warn('REDIS_URL not set - queues will fail to connect');
    }
}
