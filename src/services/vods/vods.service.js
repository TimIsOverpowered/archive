// Initializes the `vods` service on path `/vods`
const { Vods } = require("./vods.class");
const createModel = require("../../models/vods.model");
const hooks = require("./vods.hooks");
const rateLimit = require("express-rate-limit");

module.exports = function (app) {
  const options = {
    Model: createModel(app),
    paginate: app.get("paginate"),
  };

  // Initialize our service with any options it requires
  app.use(
    "/vods",
    rateLimit({
      windowMs: 30 * 1000,
      max: 10,
      message:
        "API rate limit exceeded",
    }),
    new Vods(options, app)
  );

  // Get our initialized service so that we can register hooks
  const service = app.service("vods");

  service.hooks(hooks);
};
