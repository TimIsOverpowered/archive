const twitch = require("./middleware/twitch");
const config = require("../config/config.json");
const vod = require("./middleware/vod");
const fs = require("fs");

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};

module.exports.check = async (app) => {
  const redisClient = app.get("redisClient");
  const downloading = await redisClient
    .get(`${config.channel}-downloading`)
    .then(() => true)
    .catch(() => false);
  if (downloading)
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  const twitchId = config.twitch.id;
  const stream = await twitch.getStream(twitchId);

  if (!stream)
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  if (!stream[0])
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  const vodData = await twitch.getLatestVodData(twitchId);

  if (!vodData)
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  if (vodData.stream_id !== stream[0].id)
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  const vodExists = await app
    .service("vods")
    .get(vodData.id)
    .then(() => true)
    .catch(() => false);

  if (!vodExists) {
    await app
      .service("vods")
      .create({
        id: vodData.id,
        title: vodData.title,
        date: new Date(vodData.created_at).toLocaleDateString("en-US", {
          timeZone: config.timezone,
        }),
        createdAt: vodData.created_at,
        stream_id: vodData.stream_id,
      })
      .then(() =>
        console.log(
          `${
            config.channel
          } went online. Creating vod. ${new Date().toLocaleDateString()}`
        )
      )
      .catch((e) => {
        console.error(e);
      });
  }

  const dir = `${config.vodPath}/${vodData.id}`;
  if (await fileExists(dir))
    await fs.promises.rmdir(dir, {
      recursive: true,
      force: true,
    });
  vod.startDownload(vodData.id, app);

  setTimeout(() => {
    this.check(app);
  }, 30000);
};
