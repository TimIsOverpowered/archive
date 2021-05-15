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
  app.post("/admin/part/dmca", admin.verify(app), admin.partDmca(app));
  app.post("/admin/chapters", admin.verify(app), admin.saveChapters(app));
  app.post("/v2/admin/download", admin.verify(app), admin.downloadv2(app));
  app.post("/v2/admin/reupload", admin.verify(app), admin.reUploadPart(app));
  app.get(
    "/v1/vods/:vodId/comments",
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

    logs(app)
  );
};
