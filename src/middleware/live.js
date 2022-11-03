const vod = require("./vod");
const drive = require("./drive");
const config = require("../../config/config.json");

module.exports = function (app) {
  return async function (req, res, next) {
    const { streamId, path, driveId } = req.body;
    if (!streamId)
      return res.status(400).json({ error: true, msg: "No streamId" });

    if (!path) return res.status(400).json({ error: true, msg: "No Path" });

    let vods;
    await app
      .service("vods")
      .find({
        query: {
          stream_id: streamId,
        },
      })
      .then((data) => {
        vods = data.data;
      })
      .catch((e) => {
        console.error(e);
      });

    if (vods.length == 0)
      return res.status(404).json({ error: true, msg: "No Vod found" });

    const vod_data = vods[0];

    if (driveId == null && config.drive.upload) {
      drive.upload(vod_data.id, path, app, "live");
    } else if (driveId != null) {
      vod_data.drive.push({
        id: res.data.id,
        type: "live",
      });
      await app
        .service("vods")
        .patch(vod_data.id, {
          drive: vod_data.drive,
        })
        .then(() => {
          console.info(`Drive info updated for ${vod_data.id}`);
        })
        .catch((e) => {
          console.error(e);
        });
    }

    //Need to deliver a non 200 http code so it will delete the file
    if (config.youtube.multiTrack) {
      res.status(200).json({ error: false, msg: "Starting upload to youtube" });
      await vod.upload(vod_data.id, app, path, "live");
    } else {
      res.status(404).json({
        error: true,
        msg: "Not Uploading to youtube as per multitrack var",
      });
    }
  };
};
