const path = require("path");
const favicon = require("serve-favicon");
const compress = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const logger = require("./logger");

const { feathers } = require("@feathersjs/feathers");
const configuration = require("@feathersjs/configuration");
const express = require("@feathersjs/express");

const middleware = require("./middleware");
const services = require("./services");
const appHooks = require("./app.hooks");
const channels = require("./channels");
const redis = require("./redis");
const google = require("./google");

const sequelize = require("./sequelize");

const app = express(feathers());

// Load app configuration
app.configure(configuration());
app.configure(redis);
google.initializeYt(app);
google.initializeDrive(app);
// Enable security, CORS, compression, favicon and body parsing
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(cors());
app.use(compress());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
const rawBodySaver = function (req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || "utf8");
  }
};
app.use(express.raw({ verify: rawBodySaver(), type: "*/*" }));
app.use(favicon(path.join(app.get("public"), "favicon.ico")));
// Host the public folder
app.use("/", express.static(app.get("public")));

// Set up Plugins and providers
app.configure(express.rest());

app.configure(sequelize);

// Configure other middleware (see `middleware/index.js`)
app.configure(middleware);
// Set up our services (see `services/index.js`)
app.configure(services);
// Set up event channels (see channels.js)
app.configure(channels);

// Configure a middleware for 404s and the error handler
app.use(function (req, res, next) {
  res.status(404).json({ error: true, msg: "Missing route" });
});
app.use(express.errorHandler({ logger }));

app.hooks(appHooks);

module.exports = app;
