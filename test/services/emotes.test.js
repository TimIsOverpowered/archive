const assert = require('assert');
const app = require('../../src/app');

describe('\'emotes\' service', () => {
  it('registered the service', () => {
    const service = app.service('emotes');

    assert.ok(service, 'Registered the service');
  });
});
