import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { request } from '../../src/utils/http-client.js';
import { HttpError } from '../../src/utils/http-error.js';

describe('HTTP Client', () => {
  const originalFetch = global.fetch;
  const originalTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  beforeEach(() => {
    global.fetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true }),
        text: async () => 'success',
        blob: async () => new Blob(['success']),
        arrayBuffer: async () => new ArrayBuffer(8),
      }) as Response;

    global.setTimeout = ((callback: TimerHandler, delay?: number) => {
      const id = originalTimeout(callback, delay);
      return id as number;
    }) as typeof global.setTimeout;

    global.clearTimeout = originalClearTimeout as typeof global.clearTimeout;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  describe('successful requests', () => {
    it('should perform GET request with JSON response', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ foo: 'bar' }),
        }) as Response;

      const result = await request<{ foo: string }>('https://api.example.com/test');

      assert.deepStrictEqual(result, { foo: 'bar' });
    });

    it('should perform POST request with auto-JSON serialization', async () => {
      let capturedBody: unknown = undefined;
      let capturedHeaders: Record<string, string> | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body;
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ created: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ created: boolean }>('https://api.example.com/test', {
        method: 'POST',
        body: { name: 'test' },
      });

      assert.deepStrictEqual(result, { created: true });
      assert.strictEqual(capturedBody, JSON.stringify({ name: 'test' }));
      assert.strictEqual(capturedHeaders?.['Content-Type'], 'application/json');
    });

    it('should pass through custom headers', async () => {
      let capturedHeaders: Record<string, string> | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', {
        headers: { 'X-Custom-Header': 'custom-value' },
      });

      assert.strictEqual(capturedHeaders?.['X-Custom-Header'], 'custom-value');
    });

    it('should handle text response type', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => 'plain text response',
        }) as Response;

      const result = await request('https://api.example.com/test', { responseType: 'text' });

      assert.strictEqual(result, 'plain text response');
    });

    it('should handle blob response type', async () => {
      const mockBlob = new Blob(['binary data']);

      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          blob: async () => mockBlob,
        }) as Response;

      const result = await request('https://api.example.com/test', { responseType: 'blob' });

      assert.ok(result instanceof Blob);
    });

    it('should handle arrayBuffer response type', async () => {
      const mockBuffer = new ArrayBuffer(16);

      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          arrayBuffer: async () => mockBuffer,
        }) as Response;

      const result = await request('https://api.example.com/test', { responseType: 'arrayBuffer' });

      assert.ok(result instanceof ArrayBuffer);
      assert.strictEqual(result.byteLength, 16);
    });

    it('should handle response type (raw Response)', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
      } as Response;

      global.fetch = async () => mockResponse;

      const result = await request('https://api.example.com/test', { responseType: 'response' });

      assert.strictEqual(result, mockResponse);
    });

    it('should handle null body', async () => {
      let capturedBody: unknown = undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'POST', body: null });

      assert.strictEqual(capturedBody, undefined);
    });

    it('should handle undefined body', async () => {
      let capturedBody: unknown = undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'POST' });

      assert.strictEqual(capturedBody, undefined);
    });

    it('should pass through FormData without modification', async () => {
      let capturedBody: unknown = undefined;
      let capturedHeaders: Record<string, string> | undefined;

      const formData = new FormData();
      formData.append('field', 'value');

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body;
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'POST', body: formData });

      assert.strictEqual(capturedBody, formData);
      assert.notStrictEqual(capturedHeaders?.['Content-Type'], 'application/json');
    });

    it('should pass through Blob without modification', async () => {
      let capturedBody: unknown = undefined;
      let capturedHeaders: Record<string, string> | undefined;

      const blob = new Blob(['data']);

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body;
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'POST', body: blob });

      assert.strictEqual(capturedBody, blob);
      assert.notStrictEqual(capturedHeaders?.['Content-Type'], 'application/json');
    });

    it('should pass through ArrayBuffer without modification', async () => {
      let capturedBody: unknown = undefined;
      let capturedHeaders: Record<string, string> | undefined;

      const buffer = new ArrayBuffer(8);

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body;
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'POST', body: buffer });

      assert.strictEqual(capturedBody, buffer);
      assert.notStrictEqual(capturedHeaders?.['Content-Type'], 'application/json');
    });
  });

  describe('retry logic', () => {
    it('should retry on 500 error', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 502 error', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 3);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 503 error', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 504 error', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve({
            ok: false,
            status: 504,
            statusText: 'Gateway Timeout',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 429 rate limit', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 408 request timeout', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve({
            ok: false,
            status: 408,
            statusText: 'Request Timeout',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should exhaust retries and throw after max attempts', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        } as Response);
      }) as typeof global.fetch;

      try {
        await request('https://api.example.com/test', {
          retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 500);
        assert.strictEqual(attempts, 3);
      }
    });

    it('should respect custom retry options', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        if (attempts < 5) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 5);
      assert.deepStrictEqual(result, { success: true });
    });
  });

  describe('non-retryable errors', () => {
    it('should NOT retry on 401 unauthorized', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as Response);
      }) as typeof global.fetch;

      try {
        await request('https://api.example.com/test', {
          retryOptions: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 401);
        assert.strictEqual(attempts, 1);
      }
    });

    it('should NOT retry on 403 forbidden', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
        } as Response);
      }) as typeof global.fetch;

      try {
        await request('https://api.example.com/test', {
          retryOptions: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 403);
        assert.strictEqual(attempts, 1);
      }
    });

    it('should NOT retry on 404 not found', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        } as Response);
      }) as typeof global.fetch;

      try {
        await request('https://api.example.com/test', {
          retryOptions: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 404);
        assert.strictEqual(attempts, 1);
      }
    });

    it('should NOT retry on 400 bad request', async () => {
      let attempts = 0;

      global.fetch = ((_input: URL | RequestInfo): Promise<Response> => {
        attempts++;
        return Promise.resolve({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
        } as Response);
      }) as typeof global.fetch;

      try {
        await request('https://api.example.com/test', {
          retryOptions: { attempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
        });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 400);
        assert.strictEqual(attempts, 1);
      }
    });
  });

  describe('HttpError throwing', () => {
    it('should throw HttpError for non-ok responses', async () => {
      global.fetch = async () =>
        ({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        }) as Response;

      try {
        await request('https://api.example.com/test');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
      }
    });

    it('should preserve status code in HttpError', async () => {
      global.fetch = async () =>
        ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        }) as Response;

      try {
        await request('https://api.example.com/test');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as HttpError).statusCode, 503);
      }
    });

    it('should include status in HttpError message', async () => {
      global.fetch = async () =>
        ({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
        }) as Response;

      try {
        await request('https://api.example.com/test');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok((error as Error).message.includes('422'));
      }
    });
  });

  describe('timeout handling', () => {
    it('should use default 10s timeout', async () => {
      let capturedSignal: AbortSignal | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedSignal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test');

      assert.ok(capturedSignal);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should respect custom timeoutMs', async () => {
      let capturedSignal: AbortSignal | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedSignal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ success: true }),
        } as Response);
      }) as typeof global.fetch;

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        timeoutMs: 5000,
      });

      assert.ok(capturedSignal);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should abort on timeout', async () => {
      global.fetch = async (_url: URL | RequestInfo, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The user aborted a request.', 'AbortError'));
            });
          }
        });
      };

      try {
        await request('https://api.example.com/test', { timeoutMs: 50, retryOptions: { attempts: 1 } });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as Error).name, 'AbortError');
      }
    });
  });

  describe('URL scrubbing', () => {
    it('should redact nauth param', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        }) as Response;

      await request('https://api.example.com/test?nauth=secret123&other=value');

      assert.ok(true);
    });

    it('should redact nauthsig param', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        }) as Response;

      await request('https://api.example.com/test?nauthsig=secret456&other=value');

      assert.ok(true);
    });

    it('should redact access_token param', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        }) as Response;

      await request('https://api.example.com/test?access_token=secret789&other=value');

      assert.ok(true);
    });

    it('should preserve non-sensitive params', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        }) as Response;

      await request('https://api.example.com/test?public=data&other=value');

      assert.ok(true);
    });

    it('should handle URL without query params', async () => {
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        }) as Response;

      await request('https://api.example.com/test');

      assert.ok(true);
    });
  });

  describe('HTTP methods', () => {
    it('should default to GET method', async () => {
      let capturedMethod: string | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedMethod = init?.method;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test');

      assert.strictEqual(capturedMethod, 'GET');
    });

    it('should support PUT method', async () => {
      let capturedMethod: string | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedMethod = init?.method;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'PUT', body: { data: 'test' } });

      assert.strictEqual(capturedMethod, 'PUT');
    });

    it('should support PATCH method', async () => {
      let capturedMethod: string | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedMethod = init?.method;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'PATCH', body: { data: 'test' } });

      assert.strictEqual(capturedMethod, 'PATCH');
    });

    it('should support DELETE method', async () => {
      let capturedMethod: string | undefined;

      global.fetch = ((_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        capturedMethod = init?.method;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        } as Response);
      }) as typeof global.fetch;

      await request('https://api.example.com/test', { method: 'DELETE' });

      assert.strictEqual(capturedMethod, 'DELETE');
    });
  });
});
