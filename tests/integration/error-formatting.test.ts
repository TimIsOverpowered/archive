import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { buildTestServer } from '../helpers/build-test-server.js';
import type { FastifyInstance } from 'fastify';
import { HttpError, badRequest, internalServerError } from '../../src/utils/http-error.js';
import { TenantNotFoundError, VodNotFoundError } from '../../src/utils/domain-errors.js';

describe('Integration: Error Response Formatting', () => {
  let server: FastifyInstance;

  before(async () => {
    const { server: s } = await buildTestServer();
    server = s;

    server.get('/http-error/client', () => {
      throw badRequest('invalid input');
    });

    server.get('/http-error/server', () => {
      throw internalServerError('something broke');
    });

    server.get('/domain-error/tenant', () => {
      throw new TenantNotFoundError('abc-123');
    });

    server.get('/domain-error/vod', () => {
      throw new VodNotFoundError(42, 'upload');
    });

    server.get('/generic-error', () => {
      throw new Error('unexpected crash');
    });

    server.get('/error-with-code', () => {
      throw new HttpError(422, 'validation failed', 'VALIDATION_ERROR');
    });

    await server.ready();
  });

  after(async () => {
    await server.close();
  });

  it('should format HttpError 400 with client message', async () => {
    const res = await server.inject({ method: 'GET', url: '/http-error/client' });
    assert.strictEqual(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.statusCode, 400);
    assert.strictEqual(body.message, 'invalid input');
    assert.strictEqual(body.code, 'INTERNAL_SERVER_ERROR');
  });

  it('should format HttpError 500 as internal server error', async () => {
    const res = await server.inject({ method: 'GET', url: '/http-error/server' });
    assert.strictEqual(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.statusCode, 500);
    assert.strictEqual(body.message, 'Internal server error');
    assert.strictEqual(body.code, 'INTERNAL_SERVER_ERROR');
  });

  it('should format DomainError with statusCode and message', async () => {
    const res = await server.inject({ method: 'GET', url: '/domain-error/tenant' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.statusCode, 404);
    assert.ok(body.message.includes('Tenant not found'));
    assert.strictEqual(body.code, 'INTERNAL_SERVER_ERROR');
  });

  it('should format VodNotFoundError with context', async () => {
    const res = await server.inject({ method: 'GET', url: '/domain-error/vod' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.statusCode, 404);
    assert.ok(body.message.includes('VOD not found'));
    assert.strictEqual(body.code, 'INTERNAL_SERVER_ERROR');
  });

  it('should format generic Error with message for 500', async () => {
    const res = await server.inject({ method: 'GET', url: '/generic-error' });
    assert.strictEqual(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.statusCode, 500);
    assert.strictEqual(body.message, 'Internal server error');
    assert.strictEqual(body.code, 'INTERNAL_SERVER_ERROR');
  });

  it('should preserve custom HttpError code', async () => {
    const res = await server.inject({ method: 'GET', url: '/error-with-code' });
    assert.strictEqual(res.statusCode, 422);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.statusCode, 422);
    assert.strictEqual(body.message, 'validation failed');
    assert.strictEqual(body.code, 'INTERNAL_SERVER_ERROR');
  });
});
