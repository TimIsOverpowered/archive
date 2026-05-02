import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { loadApiConfig, getApiConfig, clearConfigCache } from './app-config.js';

describe('API Config Loader', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  const setupBaseEnv = () => {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    process.env.REDIS_URL = 'redis://localhost';
    process.env.META_DATABASE_URL = 'postgresql://meta';
    process.env.PGBOUNCER_URL = 'postgresql://bouncer';
    process.env.ENCRYPTION_MASTER_KEY = validKey;
    clearConfigCache();
  };

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    clearConfigCache();
  });

  describe('required fields', () => {
    beforeEach(() => {
      clearConfigCache();
      setupBaseEnv();
    });

    it('should throw when REDIS_URL is missing', () => {
      delete process.env.REDIS_URL;
      assert.throws(() => loadApiConfig(), /REDIS_URL/);
    });

    it('should throw when META_DATABASE_URL is missing', () => {
      process.env.REDIS_URL = 'redis://localhost';
      delete process.env.META_DATABASE_URL;
      assert.throws(() => loadApiConfig(), /META_DATABASE_URL/);
    });

    it('should throw when ENCRYPTION_MASTER_KEY is missing', () => {
      process.env.REDIS_URL = 'redis://localhost';
      process.env.META_DATABASE_URL = 'postgresql://meta';
      delete process.env.ENCRYPTION_MASTER_KEY;
      assert.throws(() => loadApiConfig(), /ENCRYPTION_MASTER_KEY/);
    });

    it('should throw when ENCRYPTION_MASTER_KEY is invalid', () => {
      process.env.REDIS_URL = 'redis://localhost';
      process.env.META_DATABASE_URL = 'postgresql://meta';
      process.env.ENCRYPTION_MASTER_KEY = 'invalid';
      assert.throws(() => loadApiConfig(), /ENCRYPTION_MASTER_KEY/);
    });
  });

  describe('optional fields with defaults', () => {
    beforeEach(() => { setupBaseEnv(); });

    it('should apply default for NODE_ENV', () => {
      delete process.env.NODE_ENV;
      const config = loadApiConfig();
      assert.strictEqual(config.NODE_ENV, 'development');
    });

    it('should use provided NODE_ENV', () => {
      process.env.NODE_ENV = 'production';
      const config = loadApiConfig();
      assert.strictEqual(config.NODE_ENV, 'production');
    });

    it('should apply default for PORT', () => {
      delete process.env.PORT;
      const config = loadApiConfig();
      assert.strictEqual(config.PORT, 3030);
    });

    it('should use provided PORT', () => {
      process.env.PORT = '8080';
      const config = loadApiConfig();
      assert.strictEqual(config.PORT, 8080);
    });

    it('should apply default for LOG_LEVEL', () => {
      delete process.env.LOG_LEVEL;
      const config = loadApiConfig();
      assert.strictEqual(config.LOG_LEVEL, 'info');
    });

    it('should use provided LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'debug';
      const config = loadApiConfig();
      assert.strictEqual(config.LOG_LEVEL, 'debug');
    });
  });

  describe('field types', () => {
    beforeEach(() => {
      setupBaseEnv();
      process.env.NODE_ENV = 'test';
      process.env.PORT = '3000';
      process.env.LOG_LEVEL = 'debug';
    });

    it('should parse PORT as number', () => {
      const config = loadApiConfig();
      assert.strictEqual(config.PORT, 3000);
      assert.strictEqual(typeof config.PORT, 'number');
    });

    it('should parse DISABLE_REDIS_CACHE as boolean', () => {
      process.env.DISABLE_REDIS_CACHE = 'true';
      const config = loadApiConfig();
      assert.strictEqual(config.DISABLE_REDIS_CACHE, true);
    });

    it('should keep string fields as strings', () => {
      const config = loadApiConfig();
      assert.strictEqual(typeof config.NODE_ENV, 'string');
      assert.strictEqual(typeof config.REDIS_URL, 'string');
      assert.strictEqual(typeof config.HOST, 'string');
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      setupBaseEnv();
      process.env.NODE_ENV = 'test';
    });

    it('should reject invalid PORT (non-numeric)', () => {
      process.env.PORT = 'not-a-number';
      assert.throws(() => loadApiConfig());
    });

    it('should reject PORT out of range', () => {
      process.env.PORT = '99999';
      assert.throws(() => loadApiConfig(), /PORT/);
    });

    it('should accept valid PORT at boundary', () => {
      process.env.PORT = '1';
      const config = loadApiConfig();
      assert.strictEqual(config.PORT, 1);
    });

    it('should accept valid PORT at upper boundary', () => {
      process.env.PORT = '65535';
      const config = loadApiConfig();
      assert.strictEqual(config.PORT, 65535);
    });

    it('should reject invalid NODE_ENV', () => {
      process.env.NODE_ENV = 'invalid';
      assert.throws(() => loadApiConfig());
    });

    it('should reject invalid LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'invalid';
      assert.throws(() => loadApiConfig());
    });
  });

  describe('caching', () => {
    beforeEach(() => { setupBaseEnv(); });

    it('should cache config after first load', () => {
      const config1 = loadApiConfig();
      const config2 = getApiConfig();
      assert.strictEqual(config1, config2);
    });

    it('should allow cache clear', () => {
      process.env.PORT = '9999';
      const config = loadApiConfig();
      assert.strictEqual(config.PORT, 9999);
    });
  });
});
