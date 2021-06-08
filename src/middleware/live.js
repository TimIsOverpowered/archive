const config = require("../../config/config.json");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");

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

    const vod_data = vods[0];

    const duration = await getDuration(
      `${config.livePath}/${config.channel.toLowerCase()}/${
        req.body.streamId
      }/${req.body.streamId}.mp4`
    );

    await app
      .service("vods")
      .patch(vod_data.id, {
        drive_id: req.body.driveId,
        duration: duration,
      })
      .catch((e) => {
        console.error(e);
      });

    res
      .status(200)
      .json({
        error: false,
        message: `Added Drive Id: ${req.body.drive_id} to vod ${vod_data.id}`,
      });

    await fs.promises
      .rmdir(
        `${config.livePath}/${config.channel.toLowerCase()}/${
          req.body.streamId
        }`,
        {
          recursive: true,
        }
      )
      .catch((e) => console.error(e));
  };
};

const getDuration = async (video) => {
  let duration;
  await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(video, (err, metadata) => {
      if (err) {
        console.error(err);
        return reject();
      }
      duration = metadata.format.duration;
      resolve();
    });
  });
  return duration;
};
