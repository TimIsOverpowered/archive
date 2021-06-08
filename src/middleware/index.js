const admin = require("./admin");
const logs = require("./logs");
const live = require("./live");
const rateLimit = require("express-rate-limit");

module.exports = function (app) {
  app.post("/admin/logs", admin.verify(app), admin.logs(app));
  app.delete("/admin/delete", admin.verify(app), admin.delete(app));
  app.post("/admin/chapters", admin.verify(app), admin.saveChapters(app));
  app.post("/v2/live", admin.verify(app), live(app));
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
