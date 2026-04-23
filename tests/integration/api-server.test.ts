import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { buildTestServer } from '../helpers/build-test-server.js';
import type { FastifyInstance } from 'fastify';

describe('Integration: API Server', () => {
  let server: FastifyInstance;

  before(async () => {
    const { server: s } = await buildTestServer();
    server = s;

    server.get('/test', () => ({ status: 'ok' }));
    server.get('/test/error', () => {
      throw new Error('test error');
    });

    server.setNotFoundHandler((_request, reply) => {
      return reply.status(404).send({ error: { message: 'Route not found', statusCode: 404 } });
    });

    await server.ready();
  });

  after(async () => {
    await server.close();
  });

  it('should return 200 for registered routes', async () => {
    const res = await server.inject({ method: 'GET', url: '/test' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
  });

  it('should return 404 for unregistered routes', async () => {
    const res = await server.inject({ method: 'GET', url: '/nonexistent' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.message, 'Route not found');
  });

  it('should handle errors via error handler', async () => {
    const res = await server.inject({ method: 'GET', url: '/test/error' });
    assert.strictEqual(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.message, 'Internal server error');
  });
});
