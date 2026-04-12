import { expect } from 'chai';
import { loadAppConfig, getAppConfig, clearConfigCache } from './app-config.js';

describe('App Config Loader', () => {
  const originalEnv = process.env;
  const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars = 32 bytes

  const setupBaseEnv = () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgresql://test',
      REDIS_URL: 'redis://localhost',
      META_DATABASE_URL: 'postgresql://meta',
      ENCRYPTION_MASTER_KEY: validKey,
    };
    clearConfigCache();
  };

  afterEach(() => {
    process.env = originalEnv;
    clearConfigCache();
  });

  describe('required fields', () => {
    beforeEach(() => setupBaseEnv());

    it('should throw when DATABASE_URL is missing', () => {
      delete process.env.DATABASE_URL;
      expect(() => loadAppConfig()).to.throw('DATABASE_URL');
    });

    it('should throw when REDIS_URL is missing', () => {
      process.env.DATABASE_URL = 'postgresql://test';
      delete process.env.REDIS_URL;
      expect(() => loadAppConfig()).to.throw('REDIS_URL');
    });

    it('should throw when META_DATABASE_URL is missing', () => {
      process.env.DATABASE_URL = 'postgresql://test';
      process.env.REDIS_URL = 'redis://localhost';
      delete process.env.META_DATABASE_URL;
      expect(() => loadAppConfig()).to.throw('META_DATABASE_URL');
    });

    it('should throw when ENCRYPTION_MASTER_KEY is missing', () => {
      process.env.DATABASE_URL = 'postgresql://test';
      process.env.REDIS_URL = 'redis://localhost';
      process.env.META_DATABASE_URL = 'postgresql://meta';
      delete process.env.ENCRYPTION_MASTER_KEY;
      expect(() => loadAppConfig()).to.throw('ENCRYPTION_MASTER_KEY');
    });

    it('should throw when ENCRYPTION_MASTER_KEY is invalid', () => {
      process.env.DATABASE_URL = 'postgresql://test';
      process.env.REDIS_URL = 'redis://localhost';
      process.env.META_DATABASE_URL = 'postgresql://meta';
      process.env.ENCRYPTION_MASTER_KEY = 'invalid';
      expect(() => loadAppConfig()).to.throw('ENCRYPTION_MASTER_KEY');
    });
  });

  describe('optional fields with defaults', () => {
    beforeEach(() => setupBaseEnv());

    it('should apply default for NODE_ENV', () => {
      delete process.env.NODE_ENV;
      const config = loadAppConfig();
      expect(config.NODE_ENV).to.equal('development');
    });

    it('should use provided NODE_ENV', () => {
      process.env.NODE_ENV = 'production';
      const config = loadAppConfig();
      expect(config.NODE_ENV).to.equal('production');
    });

    it('should apply default for PORT', () => {
      delete process.env.PORT;
      const config = loadAppConfig();
      expect(config.PORT).to.equal(3030);
    });

    it('should use provided PORT', () => {
      process.env.PORT = '8080';
      const config = loadAppConfig();
      expect(config.PORT).to.equal(8080);
    });

    it('should apply default for LOG_LEVEL', () => {
      delete process.env.LOG_LEVEL;
      const config = loadAppConfig();
      expect(config.LOG_LEVEL).to.equal('info');
    });

    it('should use provided LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'debug';
      const config = loadAppConfig();
      expect(config.LOG_LEVEL).to.equal('debug');
    });

    it('should apply default for WORKER_CONCURRENCY', () => {
      delete process.env.WORKER_CONCURRENCY;
      const config = loadAppConfig();
      expect(config.WORKER_CONCURRENCY).to.equal(4);
    });

    it('should use provided WORKER_CONCURRENCY', () => {
      process.env.WORKER_CONCURRENCY = '8';
      const config = loadAppConfig();
      expect(config.WORKER_CONCURRENCY).to.equal(8);
    });
  });

  describe('field types', () => {
    beforeEach(() => {
      setupBaseEnv();
      process.env.NODE_ENV = 'test';
      process.env.PORT = '3000';
      process.env.LOG_LEVEL = 'debug';
      process.env.WORKER_CONCURRENCY = '8';
    });

    it('should parse PORT as number', () => {
      const config = loadAppConfig();
      expect(config.PORT).to.equal(3000);
      expect(typeof config.PORT).to.equal('number');
    });

    it('should parse WORKER_CONCURRENCY as number', () => {
      const config = loadAppConfig();
      expect(config.WORKER_CONCURRENCY).to.equal(8);
      expect(typeof config.WORKER_CONCURRENCY).to.equal('number');
    });

    it('should parse DISABLE_REDIS_CACHE as boolean', () => {
      process.env.DISABLE_REDIS_CACHE = 'true';
      const config = loadAppConfig();
      expect(config.DISABLE_REDIS_CACHE).to.be.true;
    });

    it('should keep string fields as strings', () => {
      const config = loadAppConfig();
      expect(typeof config.NODE_ENV).to.equal('string');
      expect(typeof config.DATABASE_URL).to.equal('string');
      expect(typeof config.REDIS_URL).to.equal('string');
      expect(typeof config.HOST).to.equal('string');
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      setupBaseEnv();
      process.env.NODE_ENV = 'test';
    });

    it('should reject invalid PORT (non-numeric)', () => {
      process.env.PORT = 'not-a-number';
      expect(() => loadAppConfig()).to.throw();
    });

    it('should reject PORT out of range', () => {
      process.env.PORT = '99999';
      expect(() => loadAppConfig()).to.throw('PORT');
    });

    it('should accept valid PORT at boundary', () => {
      process.env.PORT = '1';
      const config = loadAppConfig();
      expect(config.PORT).to.equal(1);
    });

    it('should accept valid PORT at upper boundary', () => {
      process.env.PORT = '65535';
      const config = loadAppConfig();
      expect(config.PORT).to.equal(65535);
    });

    it('should reject invalid NODE_ENV', () => {
      process.env.NODE_ENV = 'invalid' as any;
      expect(() => loadAppConfig()).to.throw();
    });

    it('should reject invalid LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'invalid' as any;
      expect(() => loadAppConfig()).to.throw();
    });
  });

  describe('caching', () => {
    beforeEach(() => setupBaseEnv());

    it('should cache config after first load', () => {
      const config1 = loadAppConfig();
      const config2 = getAppConfig();
      expect(config1).to.equal(config2);
    });

    it('should allow cache clear', () => {
      process.env.PORT = '9999';
      const config = loadAppConfig();
      expect(config.PORT).to.equal(9999);
    });
  });
});
