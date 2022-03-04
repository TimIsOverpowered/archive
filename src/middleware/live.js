const vod = require("./vod");
const config = require("../../config/config.json");
const fs = require("fs");

module.exports = function (app) {
  return async function (req, res, next) {
    if (!req.body.driveId) return res.status(400).json({ error: true, msg: "No driveId" });

    if (!req.body.streamId) return res.status(400).json({ error: true, msg: "No streamId" });

    if (!req.body.path) return res.status(400).json({ error: true, msg: "No Path" });

    let vods;
    await app
      .service("vods")
      .find({
        query: {
          stream_id: req.body.streamId,
        },
      })
      .then((data) => {
        vods = data.data;
      })
      .catch((e) => {
        console.error(e);
      });

    if (vods.length == 0) return res.status(404).json({ error: true, msg: "No Vod found" });

    res.status(200).json({ error: false, msg: "Starting upload to youtube" });
    const vod_data = vods[0];

    vod_data.drive.push({
      id: req.body.driveId,
      type: "live",
    });

    await app
      .service("vods")
      .patch(vod_data.id, {
        drive: vod_data.drive,
      })
      .catch((e) => {
        console.error(e);
      });

    if (config.youtube.multiTrack) await vod.upload(vod_data.id, app, req.body.path, "live");
  };
};
