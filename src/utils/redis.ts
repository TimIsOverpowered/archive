import Redis from 'ioredis';

export async function connectWithBackoff(
    url: string,
    maxAttempts = 6
): Promise<Redis> {
    let attempt = 0;
    let delay = 2000;

    while (attempt < maxAttempts) {
        try {
            const client = new Redis(url);
            
            await client.ping();
            
            return client;
        } catch (error: any) {
            attempt++;
            if (attempt >= maxAttempts) throw error;

            console.log(`Redis connection failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }

    throw new Error('Failed to connect to Redis after all attempts');
}
