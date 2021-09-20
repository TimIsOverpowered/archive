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
      windowMs: 5 * 1000,
      max: 20,
      message: "API rate limit exceeded",
      keyGenerator: function (req) {
        //for cloudflare
        //return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        return req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      },
    }),
    new Vods(options, app)
  );

  // Get our initialized service so that we can register hooks
  const service = app.service("vods");

  service.hooks(hooks);
};
