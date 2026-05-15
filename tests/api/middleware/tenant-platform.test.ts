import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  tenantMiddleware,
  platformValidationMiddleware,
  asTenantPlatformContext,
} from '../../../src/api/middleware/tenant-platform.js';
import { PLATFORMS } from '../../../src/types/platforms.js';
import { HttpError } from '../../../src/utils/http-error.js';

function makeMockTenantConfig(overrides: Record<string, any> = {}): any {
  return {
    id: 'tenant-1',
    displayName: 'Test Streamer',
    createdAt: new Date(),
    twitch: { enabled: true, auth: 'token', username: 'testuser' },
    kick: { enabled: false, username: 'testkick' },
    database: { name: 'test' },
    settings: { domainName: 'example.com', timezone: 'UTC', saveMP4: true, saveHLS: false },
    ...overrides,
  };
}

describe('tenantMiddleware', () => {
  it('should throw 404 when tenantId is not provided', async () => {
    const request = { params: {} };

    try {
      await tenantMiddleware(request as any);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.strictEqual(error.statusCode, 404);
      assert.strictEqual(error.code, 'NOT_FOUND');
      assert.strictEqual(error.message, 'Tenant ID not provided');
    }
  });

  it('should throw 404 when tenant is not found in config', async () => {
    const request = { params: { tenantId: 'non-existent' } };

    try {
      await tenantMiddleware(request as any);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.strictEqual(error.statusCode, 404);
      assert.strictEqual(error.code, 'NOT_FOUND');
      assert.strictEqual(error.message, 'Tenant not found');
    }
  });
});

describe('platformValidationMiddleware', () => {
  it('should throw 400 when platform is not provided', async () => {
    const request = { body: {}, tenant: null };

    try {
      await platformValidationMiddleware(request as any);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.strictEqual(error.statusCode, 400);
      assert.strictEqual(error.code, 'BAD_REQUEST');
      assert.strictEqual(error.message, 'Platform is required');
    }
  });

  it('should throw 400 when platform is not enabled for tenant', async () => {
    const tenantConfig = makeMockTenantConfig({ twitch: { enabled: false } });
    const request = {
      body: { platform: 'twitch' },
      tenant: { config: tenantConfig },
    };

    try {
      await platformValidationMiddleware(request as any);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.strictEqual(error.statusCode, 400);
      assert.strictEqual(error.code, 'BAD_REQUEST');
      assert.ok(error.message.includes('not enabled'));
    }
  });

  it('should set platform on tenant context when valid', async () => {
    const tenantConfig = makeMockTenantConfig();
    const request = {
      body: { platform: 'twitch' },
      tenant: { config: tenantConfig },
    };

    await platformValidationMiddleware(request as any);

    assert.strictEqual((request.tenant as any).platform, PLATFORMS.TWITCH);
  });

  it('should handle case-insensitive platform input', async () => {
    const tenantConfig = makeMockTenantConfig();
    const request = {
      body: { platform: 'TWITCH' },
      tenant: { config: tenantConfig },
    };

    await platformValidationMiddleware(request as any);

    assert.strictEqual((request.tenant as any).platform, PLATFORMS.TWITCH);
  });

  it('should throw 500 when tenant context is missing', async () => {
    const request = {
      body: { platform: 'twitch' },
      tenant: null,
    };

    try {
      await platformValidationMiddleware(request as any);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.strictEqual(error.statusCode, 500);
      assert.strictEqual(error.code, 'INTERNAL_SERVER_ERROR');
      assert.strictEqual(error.message, 'Tenant context not found');
    }
  });

  it('should validate kick platform when enabled', async () => {
    const tenantConfig = makeMockTenantConfig({ kick: { enabled: true } });
    const request = {
      body: { platform: 'kick' },
      tenant: { config: tenantConfig },
    };

    await platformValidationMiddleware(request as any);

    assert.strictEqual((request.tenant as any).platform, PLATFORMS.KICK);
  });
});

describe('asTenantPlatformContext', () => {
  it('should cast TenantContext to TenantPlatformContext', () => {
    const ctx = {
      tenantId: 'test',
      config: makeMockTenantConfig(),
      platform: PLATFORMS.TWITCH,
    };
    const result = asTenantPlatformContext(ctx as any);
    assert.strictEqual(result.platform, PLATFORMS.TWITCH);
  });

  it('should preserve all context properties', () => {
    const ctx = {
      tenantId: 'test-123',
      config: makeMockTenantConfig(),
      platform: PLATFORMS.KICK,
    };
    const result = asTenantPlatformContext(ctx as any);
    assert.strictEqual(result.tenantId, 'test-123');
    assert.strictEqual(result.platform, PLATFORMS.KICK);
  });
});
