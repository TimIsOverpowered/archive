const webhook = require('./webhook');

module.exports = function (app) {
  app.get("/twitch/webhook/*", webhook.verify(app));
  app.post("/twitch/webhook/stream/:userId", webhook.stream(app));
};
