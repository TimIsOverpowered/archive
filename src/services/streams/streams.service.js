// Initializes the `streams` service on path `/streams`
const { Streams } = require('./streams.class');
const createModel = require('../../models/streams.model');
const hooks = require('./streams.hooks');

module.exports = function (app) {
  const options = {
    Model: createModel(app),
    paginate: app.get('paginate')
  };

  // Initialize our service with any options it requires
  app.use('/streams', new Streams(options, app));

  // Get our initialized service so that we can register hooks
  const service = app.service('streams');

  service.hooks(hooks);
};
