const assert = require('assert');
const app = require('../../src/app');

describe('\'streams\' service', () => {
  it('registered the service', () => {
    const service = app.service('streams');

    assert.ok(service, 'Registered the service');
  });
});
