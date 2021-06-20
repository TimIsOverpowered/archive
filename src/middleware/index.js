const admin = require("./admin");
const logs = require("./logs");
const live = require("./live");
const youtube = require("./youtube");
const twitch = require("./twitch");
const rateLimit = require("express-rate-limit");

module.exports = function (app) {
  app.post("/admin/download", admin.verify(app), admin.download(app));
  app.post("/admin/logs", admin.verify(app), admin.logs(app));
  app.post("/admin/logs/manual", admin.verify(app), admin.manualLogs(app));
  app.post("/admin/dmca", admin.verify(app), admin.dmca(app));
  app.delete("/admin/delete", admin.verify(app), admin.delete(app));
  app.post("/admin/part/dmca", admin.verify(app), admin.partDmca(app));
  app.post("/admin/chapters", admin.verify(app), admin.saveChapters(app));
  app.post("/v2/admin/download", admin.verify(app), admin.downloadv2(app));
  app.post("/v2/admin/reupload", admin.verify(app), admin.reUploadPart(app));
  app.post("/v2/youtube/parts", admin.verify(app), youtube.parts(app));
  app.post("/v2/youtube/chapters", admin.verify(app), youtube.chapters(app));
  app.post("/v2/live", admin.verify(app), live(app));
  app.get(
    "/v2/badges",
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
    twitch.badges(app)
  );
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
