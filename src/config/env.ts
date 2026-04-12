import { z } from 'zod';

export const AppConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().min(1).max(65535).default(3030),
  HOST: z.string().default('0.0.0.0'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  META_DATABASE_URL: z.string().min(1, 'META_DATABASE_URL is required'),
  ENCRYPTION_MASTER_KEY: z.string().refine((val) => {
    if (!val) return false;
    if (val.length !== 64) return false;
    return /^[0-9a-fA-F]+$/.test(val);
  }, 'ENCRYPTION_MASTER_KEY must be a valid 32-byte hex string'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DISABLE_REDIS_CACHE: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
  CLEAR_QUEUES_ON_STARTUP: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
  STATS_CACHE_TTL: z.coerce.number().default(60),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

let cachedConfig: AppConfig | null = null;

export function loadAppConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  try {
    cachedConfig = AppConfigSchema.parse(process.env);
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
      throw new Error(`Config validation failed: ${errorMessages}`);
    }
    throw error;
  }
}

export function getAppConfig(): AppConfig {
  return cachedConfig || loadAppConfig();
}

export function clearConfigCache(): void {
  cachedConfig = null;
}
