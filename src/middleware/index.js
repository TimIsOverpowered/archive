const admin = require("./admin");
const logs = require("./logs");
const live = require("./live");
const youtube = require("./youtube");
const twitch = require("./twitch");
const { limiter } = require("./rateLimit");
const dmca = require("./dmca");
const search = require("./search");

module.exports = function (app) {
  app.post("/admin/download", admin.verify(app), admin.download(app));
  app.post("/admin/logs", admin.verify(app), admin.logs(app));
  app.post("/admin/dmca", admin.verify(app), dmca(app));
  app.delete("/admin/delete", admin.verify(app), admin.delete(app));
  app.post("/admin/part/dmca", admin.verify(app), dmca.part(app));
  app.post("/admin/chapters", admin.verify(app), admin.saveChapters(app));
  app.post("/admin/duration", admin.verify(app), admin.saveDuration(app));
  app.post("/admin/reupload", admin.verify(app), admin.reUploadPart(app));
  app.post("/youtube/parts", admin.verify(app), youtube.parts(app));
  app.post("/youtube/chapters", admin.verify(app), youtube.chapters(app));
  app.post("/v2/live", admin.verify(app), live(app));
  app.get("/v2/badges", limiter(app), twitch.badges(app));
  app.get("/v1/vods/:vodId/comments", limiter(app), logs(app));
  app.post("/search", limiter(app), search(app));
};
