const assert = require('assert');
const app = require('../../src/app');

describe('\'vods\' service', () => {
  it('registered the service', () => {
    const service = app.service('vods');

    assert.ok(service, 'Registered the service');
  });
});
