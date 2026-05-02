import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { defaultCircuitBreaker } from '../../src/utils/circuit-breaker';

describe('Circuit Breaker', () => {
  beforeEach(() => {
    defaultCircuitBreaker.clearAllCircuits();
  });

  afterEach(() => {
    defaultCircuitBreaker.clearAllCircuits();
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
    });
  });

  describe('recordFailure', () => {
    it('should not open circuit before threshold', () => {
      for (let i = 0; i < 4; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
        assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
      }
    });

    it('should open circuit after reaching threshold', () => {
      for (let i = 0; i < 5; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
      }
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'open');
    });

    it('should use custom threshold', () => {
      const opts = { failureThreshold: 3 };
      defaultCircuitBreaker.recordFailure('test-key', opts);
      defaultCircuitBreaker.recordFailure('test-key', opts);
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
      defaultCircuitBreaker.recordFailure('test-key', opts);
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'open');
    });

    it('should increment failureCount', () => {
      defaultCircuitBreaker.recordFailure('test-key');
      defaultCircuitBreaker.recordFailure('test-key');
      defaultCircuitBreaker.recordFailure('test-key');
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
    });

    it('should update lastFailureTime', () => {
      defaultCircuitBreaker.recordFailure('test-key');
    });
  });

  describe('recordSuccess', () => {
    it('should reset circuit to closed', () => {
      for (let i = 0; i < 5; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
      }
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'open');

      defaultCircuitBreaker.recordSuccess('test-key');
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
    });

    it('should reset failure count', () => {
      for (let i = 0; i < 3; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
      }
      defaultCircuitBreaker.recordSuccess('test-key');
      defaultCircuitBreaker.recordFailure('test-key');
      defaultCircuitBreaker.recordFailure('test-key');
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
    });

    it('should recover from half-open state', () => {
      for (let i = 0; i < 5; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
      }
      // Wait for recovery timeout
      defaultCircuitBreaker.recordSuccess('test-key');
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
    });
  });

  describe('half-open recovery', () => {
    it('should transition to half-open after recovery timeout', () => {
      defaultCircuitBreaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      defaultCircuitBreaker.recordFailure('test-key', opts);
      defaultCircuitBreaker.recordFailure('test-key', opts);
      assert.strictEqual(defaultCircuitBreaker.getState('test-key', opts), 'open');

      // Wait for recovery timeout
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(defaultCircuitBreaker.getState('test-key', opts), 'half-open');
    });

    it('should stay open before recovery timeout', () => {
      defaultCircuitBreaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 5000 };
      defaultCircuitBreaker.recordFailure('test-key', opts);
      defaultCircuitBreaker.recordFailure('test-key', opts);
      assert.strictEqual(defaultCircuitBreaker.getState('test-key', opts), 'open');

      // Wait a short time but not enough for recovery
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(defaultCircuitBreaker.getState('test-key', opts), 'open');
    });
  });

  describe('isCircuitOpen', () => {
    it('should return false when closed', () => {
      assert.strictEqual(defaultCircuitBreaker.isCircuitOpen('test-key'), false);
    });

    it('should return true when open', () => {
      for (let i = 0; i < 5; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
      }
      assert.strictEqual(defaultCircuitBreaker.isCircuitOpen('test-key'), true);
    });

    it('should return false when half-open', () => {
      defaultCircuitBreaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      defaultCircuitBreaker.recordFailure('test-key', opts);
      defaultCircuitBreaker.recordFailure('test-key', opts);

      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(defaultCircuitBreaker.getState('test-key', opts), 'half-open');
      assert.strictEqual(defaultCircuitBreaker.isCircuitOpen('test-key', opts), false);
    });
  });

  describe('isCircuitHalfOpen', () => {
    it('should return false when closed', () => {
      assert.strictEqual(defaultCircuitBreaker.isCircuitHalfOpen('test-key'), false);
    });

    it('should return false when open', () => {
      for (let i = 0; i < 5; i++) {
        defaultCircuitBreaker.recordFailure('test-key');
      }
      assert.strictEqual(defaultCircuitBreaker.isCircuitHalfOpen('test-key'), false);
    });

    it('should return true when half-open', () => {
      defaultCircuitBreaker.clearAllCircuits();
      const opts = { failureThreshold: 2, recoveryTimeout: 50 };
      defaultCircuitBreaker.recordFailure('test-key', opts);
      defaultCircuitBreaker.recordFailure('test-key', opts);

      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }

      assert.strictEqual(defaultCircuitBreaker.getState('test-key', opts), 'half-open');
      assert.strictEqual(defaultCircuitBreaker.isCircuitHalfOpen('test-key', opts), true);
    });
  });

  describe('clearCircuit', () => {
    it('should remove circuit from cache', () => {
      defaultCircuitBreaker.recordFailure('test-key');
      defaultCircuitBreaker.clearAllCircuits();
      assert.strictEqual(defaultCircuitBreaker.getState('test-key'), 'closed');
    });
  });

  describe('different keys are independent', () => {
    it('should track failures separately', () => {
      defaultCircuitBreaker.recordFailure('key-a');
      defaultCircuitBreaker.recordFailure('key-a');
      defaultCircuitBreaker.recordFailure('key-a');
      defaultCircuitBreaker.recordFailure('key-a');
      defaultCircuitBreaker.recordFailure('key-a');

      assert.strictEqual(defaultCircuitBreaker.getState('key-a'), 'open');
      assert.strictEqual(defaultCircuitBreaker.getState('key-b'), 'closed');
    });
  });
});
