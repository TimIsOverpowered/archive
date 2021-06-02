const vod = require("./vod");
const config = require("../../config/config.json");

module.exports = function (app) {
  return async function (req, res, next) {
    if (!req.body.driveId)
      return res.status(400).json({ error: true, message: "No driveId" });

    if (!req.body.streamId)
      return res.status(400).json({ error: true, message: "No streamId" });

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

    if (vods.length == 0)
      return res.status(404).json({ error: true, message: "No Vod found" });

    res
      .status(200)
      .json({ error: false, message: "Starting upload to youtube" });
    const vod_data = vods[0];

    await app
      .service("vods")
      .patch(vod_data.id, {
        drive_id: req.body.driveId,
      })
      .catch((e) => {
        console.error(e);
      });

    if (config.multiTrack)
      vod.trimUpload(
        `${config.livePath}/${config.channel.toLowerCase()}/${
          req.body.streamId
        }/${req.body.streamId}.mp4`,
        `${config.channel} ${vod_data.date} Live Vod`,
        false,
        app
      );
  };
};
