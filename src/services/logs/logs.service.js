// Initializes the `logs` service on path `/logs`
const { Logs } = require("./logs.class");
const createModel = require("../../models/logs.model");
const hooks = require("./logs.hooks");
const rateLimit = require("express-rate-limit");

module.exports = function (app) {
  const options = {
    Model: createModel(app),
    paginate: {
      default: 10,
      max: 100,
    },
    multi: true,
  };

  // Initialize our service with any options it requires
  app.use(
    "/logs",
    rateLimit({
      windowMs: 30 * 1000,
      max: 10,
      message: "API rate limit exceeded",
      keyGenerator: function (req) {
        return req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      },
    }),
    new Logs(options, app)
  );

  // Get our initialized service so that we can register hooks
  const service = app.service("logs");

  service.hooks(hooks);
};
