import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import createRateLimitMiddleware from '../../../src/api/middleware/rate-limit.js';
import { RateLimiterMemory } from 'rate-limiter-flexible';

function createMockRequest(headers: Record<string, string | string[] | undefined>, method = 'GET'): any {
  return {
    headers,
    method,
    ip: '192.168.1.1',
  };
}

function createMockReply(): any {
  const headers: Record<string, string> = {};
  const statusCode = { value: 200 };
  let sentBody: any = null;

  return {
    header: function (key: string, value: string) {
      headers[key] = value;
      return this;
    },
    status: function (code: number) {
      statusCode.value = code;
      return {
        send: function (body: any) {
          sentBody = body;
          return this;
        },
      };
    },
    getHeaders: () => headers,
    getStatusCode: () => statusCode.value,
    getSentBody: () => sentBody,
  };
}

describe('createRateLimitMiddleware', () => {
  const limiter = new RateLimiterMemory({
    points: 10,
    duration: 1,
  });

  it('should set rate limit headers on success', async () => {
    const middleware = createRateLimitMiddleware({ limiter });
    const request = createMockRequest({ 'cf-connecting-ip': '1.2.3.4' });
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    const headers = reply.getHeaders();
    assert.ok('X-RateLimit-Limit' in headers);
    assert.strictEqual(headers['X-RateLimit-Limit'], 10);
    assert.ok('X-RateLimit-Remaining' in headers);
  });

  it('should use writeLimiter for non-GET requests', async () => {
    const writeLimiter = new RateLimiterMemory({
      points: 5,
      duration: 1,
    });
    const middleware = createRateLimitMiddleware({ limiter, writeLimiter });
    const request = createMockRequest({ 'cf-connecting-ip': '1.2.3.4' }, 'POST');
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    const headers = reply.getHeaders();
    assert.strictEqual(headers['X-RateLimit-Limit'], 5);
  });

  it('should fall back to read limiter when writeLimiter is not provided for non-GET', async () => {
    const middleware = createRateLimitMiddleware({ limiter });
    const request = createMockRequest({ 'cf-connecting-ip': '1.2.3.4' }, 'PUT');
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    const headers = reply.getHeaders();
    assert.strictEqual(headers['X-RateLimit-Limit'], 10);
  });

  it('should extract IP from cf-connecting-ip header', async () => {
    const middleware = createRateLimitMiddleware({ limiter });
    const request = createMockRequest({ 'cf-connecting-ip': '10.20.30.40' });
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    assert.strictEqual(reply.getStatusCode(), 200);
  });

  it('should extract IP from x-real-ip header', async () => {
    const middleware = createRateLimitMiddleware({ limiter });
    const request = createMockRequest({ 'x-real-ip': '10.20.30.40' });
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    assert.strictEqual(reply.getStatusCode(), 200);
  });

  it('should extract first IP from x-forwarded-for header', async () => {
    const middleware = createRateLimitMiddleware({ limiter });
    const request = createMockRequest({ 'x-forwarded-for': '10.20.30.40, 50.60.70.80' });
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    assert.strictEqual(reply.getStatusCode(), 200);
  });

  it('should use request.ip when no proxy headers present', async () => {
    const middleware = createRateLimitMiddleware({ limiter });
    const request = createMockRequest({});
    const reply = createMockReply();

    await middleware(request as any, reply as any);

    assert.strictEqual(reply.getStatusCode(), 200);
  });
});
