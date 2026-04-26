import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractErrorDetails, createErrorContext, throwOnHttpError } from '../../src/utils/error.js';
import { ZodError } from 'zod';

describe('extractErrorDetails', () => {
  it('should extract message and stack from Error instance', () => {
    const error = new Error('test error message');
    const result = extractErrorDetails(error);

    assert.strictEqual(result.message, 'test error message');
    assert.ok(result.stack);
    assert.ok(result.stack.includes('Error'));
  });

  it('should extract message only from string', () => {
    const result = extractErrorDetails('string error');

    assert.strictEqual(result.message, 'string error');
    assert.strictEqual(result.stack, undefined);
  });

  it('should extract message from object with message property', () => {
    const error = { message: 'object error', code: 500 };
    const result = extractErrorDetails(error);

    assert.strictEqual(result.message, 'object error');
    assert.strictEqual(result.stack, undefined);
  });

  it('should stringify object without message property', () => {
    const error = { code: 500, reason: 'server failure' };
    const result = extractErrorDetails(error);

    assert.ok(result.message.includes('code'));
    assert.ok(result.message.includes('server failure'));
  });

  it('should handle ZodError with validation issues', () => {
    const zodErr = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['user', 'name'],
        message: 'Expected string, received number',
        input: 123,
      },
    ]);

    const result = extractErrorDetails(zodErr);

    assert.ok(result.message.startsWith('Validation Error:'));
    assert.ok(result.message.includes('user.name'));
    assert.ok(result.message.includes('Expected string, received number'));
  });

  it('should handle ZodError with multiple issues', () => {
    const zodErr = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['email'],
        message: 'Expected string',
        input: 123,
      },
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['name'],
        message: 'Expected string',
        input: null,
      },
    ]);

    const result = extractErrorDetails(zodErr);

    assert.ok(result.message.includes('email'));
    assert.ok(result.message.includes('name'));
  });

  it('should handle ZodError with empty path', () => {
    const zodErr = new ZodError([
      {
        code: 'custom',
        path: [],
        message: 'Root level validation failed',
        input: null,
      },
    ]);

    const result = extractErrorDetails(zodErr);

    assert.ok(result.message.includes('Root level validation failed'));
  });

  it('should return unknown error message for unhandled types', () => {
    const result = extractErrorDetails(null);

    assert.strictEqual(result.message, 'Unknown error occurred');
  });

  it('should return unknown error message for numbers', () => {
    const result = extractErrorDetails(42);

    assert.strictEqual(result.message, 'Unknown error occurred');
  });

  it('should return unknown error message for arrays', () => {
    const result = extractErrorDetails(['error1', 'error2']);

    assert.strictEqual(result.message, 'Unknown error occurred');
  });

  it('should return unknown error message for booleans', () => {
    const result = extractErrorDetails(true);

    assert.strictEqual(result.message, 'Unknown error occurred');
  });

  it('should handle undefined', () => {
    const result = extractErrorDetails(undefined);

    assert.strictEqual(result.message, 'Unknown error occurred');
  });

  it('should handle empty object', () => {
    const result = extractErrorDetails({});

    assert.strictEqual(result.message, '{}');
  });

  it('should handle object with non-string message', () => {
    const error = { message: 404, name: 'NotFoundError' };
    const result = extractErrorDetails(error);

    assert.strictEqual(result.message, '404');
  });

  it('should preserve stack trace from Error', () => {
    const error = new Error('stack trace test');
    const result = extractErrorDetails(error);

    assert.ok(result.stack);
    assert.ok(result.stack!.includes('error.test.ts'));
  });
});

describe('createErrorContext', () => {
  it('should create context with error message from Error', () => {
    const error = new Error('test error');
    const result = createErrorContext(error);

    assert.deepStrictEqual(result, { error: 'test error' });
  });

  it('should create context with error message from string', () => {
    const result = createErrorContext('string error');

    assert.deepStrictEqual(result, { error: 'string error' });
  });

  it('should include additional context', () => {
    const error = new Error('test error');
    const result = createErrorContext(error, { userId: '123', action: 'update' });

    assert.strictEqual(result.error, 'test error');
    assert.strictEqual(result.userId, '123');
    assert.strictEqual(result.action, 'update');
  });

  it('should not override error field from additional context', () => {
    const error = new Error('original');
    const result = createErrorContext(error, { error: 'overridden' });

    assert.strictEqual(result.error, 'original');
  });

  it('should handle null additional context', () => {
    const error = new Error('test');
    const result = createErrorContext(error, undefined);

    assert.deepStrictEqual(result, { error: 'test' });
  });

  it('should handle ZodError in context', () => {
    const zodErr = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['field'],
        message: 'Expected string',
        input: 123,
      },
    ]);

    const result = createErrorContext(zodErr, { route: '/api/test' });

    assert.ok(result.error.startsWith('Validation Error:'));
    assert.strictEqual(result.route, '/api/test');
  });
});

describe('throwOnHttpError', () => {
  it('should not throw when response is ok', () => {
    const response = { ok: true, status: 200, statusText: 'OK' } as Response;

    assert.doesNotThrow(() => throwOnHttpError(response));
  });

  it('should not throw for 2xx status codes', () => {
    const response = { ok: true, status: 201, statusText: 'Created' } as Response;

    assert.doesNotThrow(() => throwOnHttpError(response));
  });

  it('should throw when response is not ok', () => {
    const response = { ok: false, status: 404, statusText: 'Not Found' } as Response;

    assert.throws(() => throwOnHttpError(response), { message: 'HTTP request failed with status 404 Not Found' });
  });

  it('should throw with custom context', () => {
    const response = { ok: false, status: 500, statusText: 'Internal Server Error' } as Response;

    assert.throws(() => throwOnHttpError(response, 'Upload to S3'), {
      message: 'Upload to S3 failed with status 500 Internal Server Error',
    });
  });

  it('should throw with empty context when not provided', () => {
    const response = { ok: false, status: 502, statusText: 'Bad Gateway' } as Response;

    assert.throws(() => throwOnHttpError(response), { message: 'HTTP request failed with status 502 Bad Gateway' });
  });

  it('should assert response type on success', () => {
    const response = { ok: true, status: 200, statusText: 'OK' } as Response;

    assert.doesNotThrow(() => {
      throwOnHttpError(response);
      // After assertion, response should be typed as Response
      assert.strictEqual(response.status, 200);
    });
  });
});
