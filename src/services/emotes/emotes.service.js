// Initializes the `emotes` service on path `/emotes`
const { Emotes } = require('./emotes.class');
const createModel = require('../../models/emotes.model');
const hooks = require('./emotes.hooks');

module.exports = function (app) {
  const options = {
    Model: createModel(app),
    paginate: app.get('paginate')
  };

  // Initialize our service with any options it requires
  app.use('/emotes', new Emotes(options, app));

  // Get our initialized service so that we can register hooks
  const service = app.service('emotes');

  service.hooks(hooks);
};
