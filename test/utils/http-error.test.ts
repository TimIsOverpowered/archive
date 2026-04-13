import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { HttpError, badRequest, notFound, serviceUnavailable, internalServerError } from '../../src/utils/http-error.js';

describe('HttpError', () => {
  describe('constructor', () => {
    it('should create HttpError with correct status code', () => {
      const error = new HttpError(404, 'Resource not found');

      assert.strictEqual(error.statusCode, 404);
    });

    it('should create HttpError with correct message', () => {
      const error = new HttpError(500, 'Internal server error');

      assert.strictEqual(error.message, 'Internal server error');
    });

    it('should have HttpError name', () => {
      const error = new HttpError(400, 'Bad request');

      assert.strictEqual(error.name, 'HttpError');
    });

    it('should be instance of Error', () => {
      const error = new HttpError(403, 'Forbidden');

      assert.ok(error instanceof Error);
    });

    it('should be instance of HttpError', () => {
      const error = new HttpError(401, 'Unauthorized');

      assert.ok(error instanceof HttpError);
    });
  });

  describe('badRequest helper', () => {
    it('should throw HttpError with 400 status code', () => {
      try {
        badRequest('Invalid request parameters');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 400);
        assert.strictEqual((error as Error).message, 'Invalid request parameters');
      }
    });

    it('should always throw (never returns)', () => {
      let threw = false;
      try {
        badRequest('test');
      } catch {
        threw = true;
      }
      assert.ok(threw);
    });
  });

  describe('notFound helper', () => {
    it('should throw HttpError with 404 status code', () => {
      try {
        notFound('Resource not found');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 404);
        assert.strictEqual((error as Error).message, 'Resource not found');
      }
    });
  });

  describe('serviceUnavailable helper', () => {
    it('should throw HttpError with 503 status code', () => {
      try {
        serviceUnavailable('Service temporarily unavailable');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 503);
        assert.strictEqual((error as Error).message, 'Service temporarily unavailable');
      }
    });
  });

  describe('internalServerError helper', () => {
    it('should throw HttpError with 500 status code', () => {
      try {
        internalServerError('An unexpected error occurred');
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.strictEqual((error as HttpError).statusCode, 500);
        assert.strictEqual((error as Error).message, 'An unexpected error occurred');
      }
    });
  });

  describe('error properties', () => {
    it('should preserve stack trace', () => {
      const error = new HttpError(500, 'Test error');

      assert.ok(error.stack);
      assert.ok(error.stack.includes('HttpError'));
    });

    it('should work with error instanceof checks', () => {
      const error = new HttpError(404, 'Not found');

      if (error instanceof HttpError) {
        assert.strictEqual(error.statusCode, 404);
      } else {
        assert.fail('Should be instance of HttpError');
      }
    });

    it('should work with error instanceof Error checks', () => {
      const error = new HttpError(404, 'Not found');

      if (error instanceof Error) {
        assert.strictEqual(error.message, 'Not found');
      } else {
        assert.fail('Should be instance of Error');
      }
    });
  });

  describe('various status codes', () => {
    it('should support 1xx status codes', () => {
      const error = new HttpError(100, 'Continue');
      assert.strictEqual(error.statusCode, 100);
    });

    it('should support 2xx status codes', () => {
      const error = new HttpError(201, 'Created');
      assert.strictEqual(error.statusCode, 201);
    });

    it('should support 3xx status codes', () => {
      const error = new HttpError(301, 'Moved Permanently');
      assert.strictEqual(error.statusCode, 301);
    });

    it('should support 4xx status codes', () => {
      const error = new HttpError(422, 'Unprocessable Entity');
      assert.strictEqual(error.statusCode, 422);
    });

    it('should support 5xx status codes', () => {
      const error = new HttpError(502, 'Bad Gateway');
      assert.strictEqual(error.statusCode, 502);
    });
  });
});
