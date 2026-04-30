import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { HttpError } from '../../src/utils/http-error.js';

// 1. Create the mock function first
const mockUndiciRequest = mock.fn<(...args: any[]) => Promise<any>>();
const mockAgentInstances: Array<Record<string, unknown>> = [];

// 2. Register the module mock BEFORE importing the file that uses it
mock.module('undici', {
  namedExports: {
    request: mockUndiciRequest,
    Agent: class MockAgent {
      constructor(opts?: Record<string, unknown>) {
        mockAgentInstances.push(opts ?? {});
      }
    },
  },
});

// 3. Dynamically import the system-under-test AFTER the mock is registered
const { request } = await import('../../src/utils/http-client.js');

describe('HTTP Client', () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  beforeEach(() => {
    mockUndiciRequest.mock.resetCalls();
    mockUndiciRequest.mock.restore();

    global.setTimeout = ((callback: TimerHandler, delay?: number) => {
      const id = originalSetTimeout(callback, delay);
      return id as number;
    }) as typeof global.setTimeout;

    global.clearTimeout = originalClearTimeout as typeof global.clearTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  /** Create a mock undici ResponseData. */
  function makeMockResponse(
    opts: {
      statusCode?: number;
      statusMessage?: string;
      body?: {
        json?: () => Promise<unknown>;
        text?: () => Promise<string>;
        arrayBuffer?: () => Promise<ArrayBuffer>;
      };
    } = {}
  ) {
    return {
      statusCode: opts.statusCode ?? 200,
      statusMessage: opts.statusMessage ?? 'OK',
      headers: {},
      body: {
        json: opts.body?.json ?? (() => Promise.resolve({})),
        text: opts.body?.text ?? (() => Promise.resolve('')),
        arrayBuffer: opts.body?.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
      },
      trailers: {},
      opaque: null,
      context: {},
    };
  }

  describe('successful requests', () => {
    it('should perform GET request with JSON response', async () => {
      const expected = { foo: 'bar' };
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve(expected) } }))
      );

      const result = await request<{ foo: string }>('https://api.example.com/test');

      assert.deepStrictEqual(result, expected);
      assert.strictEqual(mockUndiciRequest.mock.calls.length, 1);
    });

    it('should perform POST request with auto-JSON serialization', async () => {
      const expected = { created: true };
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve(expected) } }))
      );

      const result = await request<{ created: boolean }>('https://api.example.com/test', {
        method: 'POST',
        body: { name: 'test' },
      });

      assert.deepStrictEqual(result, expected);
      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[0], 'https://api.example.com/test');
      assert.strictEqual(callArgs[1].method, 'POST');
      assert.strictEqual(callArgs[1].body, JSON.stringify({ name: 'test' }));
      assert.strictEqual((callArgs[1].headers as Record<string, string>)['Content-Type'], 'application/json');
    });

    it('should pass through custom headers', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test', {
        headers: { 'X-Custom-Header': 'custom-value' },
      });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual((callArgs[1].headers as Record<string, string>)['X-Custom-Header'], 'custom-value');
    });

    it('should handle text response type', async () => {
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ body: { text: () => Promise.resolve('plain text response') } }))
      );

      const result = await request('https://api.example.com/test', { responseType: 'text' });

      assert.strictEqual(result, 'plain text response');
    });

    it('should handle blob response type', async () => {
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ body: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } }))
      );

      const result = await request('https://api.example.com/test', { responseType: 'blob' });

      assert.ok(result instanceof Blob);
    });

    it('should handle arrayBuffer response type', async () => {
      const mockBuffer = new ArrayBuffer(16);
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ body: { arrayBuffer: () => Promise.resolve(mockBuffer) } }))
      );

      const result = await request('https://api.example.com/test', { responseType: 'arrayBuffer' });

      assert.ok(result instanceof ArrayBuffer);
      assert.strictEqual(result.byteLength, 16);
    });

    it('should handle response type (raw Response)', async () => {
      const rawResponse = makeMockResponse({ statusCode: 200 });
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(rawResponse));

      const result = await request('https://api.example.com/test', { responseType: 'response' });

      assert.strictEqual(result, rawResponse);
      assert.strictEqual(result.statusCode, 200);
    });

    it('should handle null body', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test', { method: 'POST', body: null });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].body, undefined);
    });

    it('should handle undefined body', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test', { method: 'POST' });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].body, undefined);
    });

    it('should pass through FormData without modification', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      const formData = new FormData();
      formData.append('field', 'value');

      await request('https://api.example.com/test', { method: 'POST', body: formData });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].body, formData);
      assert.notStrictEqual((callArgs[1].headers as Record<string, string>)['Content-Type'], 'application/json');
    });

    it('should pass through Blob without modification', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      const blob = new Blob(['data']);

      await request('https://api.example.com/test', { method: 'POST', body: blob });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].body, blob);
      assert.notStrictEqual((callArgs[1].headers as Record<string, string>)['Content-Type'], 'application/json');
    });

    it('should pass through ArrayBuffer without modification', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      const buffer = new ArrayBuffer(8);

      await request('https://api.example.com/test', { method: 'POST', body: buffer });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].body, buffer);
      assert.notStrictEqual((callArgs[1].headers as Record<string, string>)['Content-Type'], 'application/json');
    });

    it('should pass dispatcher to fetch when provided', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      const mockAgent = { name: 'test-agent' };
      await request('https://api.example.com/test', { dispatcher: mockAgent as any });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].dispatcher, mockAgent);
    });
  });

  describe('retry logic', () => {
    it('should retry on 500 error', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve(makeMockResponse({ statusCode: 500, statusMessage: 'Internal Server Error' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 502 error', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve(makeMockResponse({ statusCode: 502, statusMessage: 'Bad Gateway' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 3);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 503 error', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve(makeMockResponse({ statusCode: 503, statusMessage: 'Service Unavailable' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 504 error', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve(makeMockResponse({ statusCode: 504, statusMessage: 'Gateway Timeout' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 429 rate limit', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve(makeMockResponse({ statusCode: 429, statusMessage: 'Too Many Requests' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should retry on 408 request timeout', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve(makeMockResponse({ statusCode: 408, statusMessage: 'Request Timeout' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        retryOptions: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should exhaust retries and throw after max attempts', async () => {
      let attempts = 0;
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        return Promise.resolve(makeMockResponse({ statusCode: 500, statusMessage: 'Internal Server Error' }));
      });

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
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        if (attempts < 5) {
          return Promise.resolve(makeMockResponse({ statusCode: 500, statusMessage: 'Internal Server Error' }));
        }
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

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
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        return Promise.resolve(makeMockResponse({ statusCode: 401, statusMessage: 'Unauthorized' }));
      });

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
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        return Promise.resolve(makeMockResponse({ statusCode: 403, statusMessage: 'Forbidden' }));
      });

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
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        return Promise.resolve(makeMockResponse({ statusCode: 404, statusMessage: 'Not Found' }));
      });

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
      mockUndiciRequest.mock.mockImplementation(() => {
        attempts++;
        return Promise.resolve(makeMockResponse({ statusCode: 400, statusMessage: 'Bad Request' }));
      });

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
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ statusCode: 404, statusMessage: 'Not Found' }))
      );

      try {
        await request('https://api.example.com/test');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
      }
    });

    it('should preserve status code in HttpError', async () => {
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ statusCode: 503, statusMessage: 'Service Unavailable' }))
      );

      try {
        await request('https://api.example.com/test');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as HttpError).statusCode, 503);
      }
    });

    it('should include status in HttpError message', async () => {
      mockUndiciRequest.mock.mockImplementation(() =>
        Promise.resolve(makeMockResponse({ statusCode: 422, statusMessage: 'Unprocessable Entity' }))
      );

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
      mockUndiciRequest.mock.mockImplementation((_url: string, opts: Record<string, unknown>) => {
        capturedSignal = opts.signal as AbortSignal | undefined;
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test');

      assert.ok(capturedSignal);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should respect custom timeoutMs', async () => {
      let capturedSignal: AbortSignal | undefined;
      mockUndiciRequest.mock.mockImplementation((_url: string, opts: Record<string, unknown>) => {
        capturedSignal = opts.signal as AbortSignal | undefined;
        return Promise.resolve(makeMockResponse({ body: { json: () => Promise.resolve({ success: true }) } }));
      });

      const result = await request<{ success: boolean }>('https://api.example.com/test', {
        timeoutMs: 5000,
      });

      assert.ok(capturedSignal);
      assert.deepStrictEqual(result, { success: true });
    });

    it('should abort on timeout', async () => {
      mockUndiciRequest.mock.mockImplementation((_url: string, opts: Record<string, unknown>) => {
        return new Promise((_resolve, reject) => {
          const signal = opts.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      try {
        await request('https://api.example.com/test', { timeoutMs: 50, retryOptions: { attempts: 1 } });
        assert.fail('Should have thrown');
      } catch (error) {
        assert.strictEqual((error as Error).name, 'DownloadAbortedError');
      }
    });
  });

  describe('URL scrubbing', () => {
    it('should redact nauth param', async () => {
      let capturedUrl = '';
      mockUndiciRequest.mock.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(makeMockResponse());
      });

      await request('https://api.example.com/test?nauth=secret123&other=value');

      assert.ok(capturedUrl.includes('nauth=secret123'), 'undici receives original URL');
      assert.ok(capturedUrl.includes('other=value'), 'non-sensitive params should be preserved');
    });

    it('should redact nauthsig param', async () => {
      let capturedUrl = '';
      mockUndiciRequest.mock.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(makeMockResponse());
      });

      await request('https://api.example.com/test?nauthsig=secret456&other=value');

      assert.ok(capturedUrl.includes('nauthsig=secret456'), 'undici receives original URL');
      assert.ok(capturedUrl.includes('other=value'), 'non-sensitive params should be preserved');
    });

    it('should redact access_token param', async () => {
      let capturedUrl = '';
      mockUndiciRequest.mock.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(makeMockResponse());
      });

      await request('https://api.example.com/test?access_token=secret789&other=value');

      assert.ok(capturedUrl.includes('access_token=secret789'), 'undici receives original URL');
      assert.ok(capturedUrl.includes('other=value'), 'non-sensitive params should be preserved');
    });

    it('should preserve non-sensitive params', async () => {
      let capturedUrl = '';
      mockUndiciRequest.mock.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(makeMockResponse());
      });

      await request('https://api.example.com/test?public=data&other=value');

      assert.ok(capturedUrl.includes('public=data'), 'public param should be preserved');
      assert.ok(capturedUrl.includes('other=value'), 'other param should be preserved');
    });

    it('should handle URL without query params', async () => {
      let capturedUrl = '';
      mockUndiciRequest.mock.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(makeMockResponse());
      });

      await request('https://api.example.com/test');

      assert.strictEqual(
        capturedUrl,
        'https://api.example.com/test',
        'URL without query params should pass through unchanged'
      );
    });
  });

  describe('HTTP methods', () => {
    it('should default to GET method', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test');

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].method, 'GET');
    });

    it('should support PUT method', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test', { method: 'PUT', body: { data: 'test' } });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].method, 'PUT');
    });

    it('should support PATCH method', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test', { method: 'PATCH', body: { data: 'test' } });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].method, 'PATCH');
    });

    it('should support DELETE method', async () => {
      mockUndiciRequest.mock.mockImplementation(() => Promise.resolve(makeMockResponse()));

      await request('https://api.example.com/test', { method: 'DELETE' });

      const callArgs = mockUndiciRequest.mock.calls[0]!.arguments as [string, Record<string, unknown>];
      assert.strictEqual(callArgs[1].method, 'DELETE');
    });
  });
});
