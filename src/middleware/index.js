const webhook = require("./webhook");
const admin = require("./admin");

module.exports = function (app) {
  app.get("/twitch/webhook/*", webhook.verify(app));
  app.post("/twitch/webhook/stream/:userId", webhook.stream(app));
  app.post("/admin/download", admin.verify(app), admin.download(app));
  app.post("/admin/logs", admin.verify(app), admin.logs(app));
  app.post("/admin/logs/manual", admin.verify(app), admin.manualLogs(app));
  app.post("/admin/dmca", admin.verify(app), admin.dmca(app));
  app.delete("/admin/delete", admin.verify(app), admin.delete(app));
  app.post("/admin/trim", admin.verify(app), admin.trim(app));
};
