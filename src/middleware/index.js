const webhook = require("./webhook");
const admin = require("./admin");

module.exports = function (app) {
  app.get("/twitch/webhook/*", webhook.verify(app));
  app.post("/twitch/webhook/stream/:userId", webhook.stream(app));
  app.post("/admin/download", admin.verify(app), admin.download(app));
  app.post("/admin/logs", admin.verify(app), admin.logs(app));
};
