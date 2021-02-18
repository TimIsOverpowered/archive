const webhook = require("./webhook");
const admin = require("./admin");
const logs = require("./logs");
const rateLimit = require("express-rate-limit");

module.exports = function (app) {
  app.get("/twitch/webhook/*", webhook.verify(app));
  app.post("/twitch/webhook/stream/:userId", webhook.stream(app));
  app.post("/admin/download", admin.verify(app), admin.download(app));
  app.post("/admin/logs", admin.verify(app), admin.logs(app));
  app.post("/admin/logs/manual", admin.verify(app), admin.manualLogs(app));
  app.post("/admin/dmca", admin.verify(app), admin.dmca(app));
  app.delete("/admin/delete", admin.verify(app), admin.delete(app));
  app.post("/admin/trim", admin.verify(app), admin.trim(app));
  app.post("/admin/trim/dmca", admin.verify(app), admin.trimDmca(app));
  app.get(
    "/v1/vods/:vodId/comments",
    rateLimit({
      windowMs: 30 * 1000,
      max: 10,
      message: "API rate limit exceeded",
      keyGenerator: function (req) {
        //for cloudflare
        //return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        return req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      },
    }),
    logs(app)
  );
};
