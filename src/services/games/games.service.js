// Initializes the `games` service on path `/games`
const { Games } = require('./games.class');
const createModel = require('../../models/games.model');
const hooks = require('./games.hooks');

module.exports = function (app) {
  const options = {
    Model: createModel(app),
    paginate: app.get('paginate')
  };

  // Initialize our service with any options it requires
  app.use('/games', new Games(options, app));

  // Get our initialized service so that we can register hooks
  const service = app.service('games');

  service.hooks(hooks);
};
