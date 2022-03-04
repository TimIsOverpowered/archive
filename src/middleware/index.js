const admin = require("./admin");
const logs = require("./logs");
const live = require("./live");
const youtube = require("./youtube");
const twitch = require("./twitch");
const { limiter } = require("./rateLimit");
const dmca = require("./dmca");
const search = require("./search");

module.exports = function (app) {
  app.post("/admin/download", limiter(app), admin.verify(app), admin.download(app));
  app.post("/admin/hls/download", limiter(app), admin.verify(app), admin.hlsDownload(app));
  app.post("/admin/logs", limiter(app), admin.verify(app), admin.logs(app));
  app.post("/admin/logs/manual", limiter(app), admin.verify(app), admin.manualLogs(app));
  app.post("/admin/dmca", limiter(app), admin.verify(app), dmca(app));
  app.post("/admin/create", limiter(app), admin.verify(app), admin.createVod(app));
  app.delete("/admin/delete", limiter(app), admin.verify(app), admin.deleteVod(app));
  app.post("/admin/part/dmca", limiter(app), admin.verify(app), dmca.part(app));
  app.post("/admin/chapters", limiter(app), admin.verify(app), admin.saveChapters(app));
  app.post("/admin/duration", limiter(app), admin.verify(app), admin.saveDuration(app));
  app.post("/admin/reupload", limiter(app), admin.verify(app), admin.reUploadPart(app));
  app.post("/admin/youtube/parts", limiter(app), admin.verify(app), youtube.parts(app));
  app.post("/admin/youtube/chapters", limiter(app), admin.verify(app), youtube.chapters(app));
  app.post("/v2/live", limiter(app), admin.verify(app), live(app));
  app.get("/v2/badges", limiter(app), twitch.badges(app));
  app.get("/v1/vods/:vodId/comments", limiter(app), logs(app));
  app.post("/search", limiter(app), search(app));
};
