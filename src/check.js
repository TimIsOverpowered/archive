const twitch = require("./middleware/twitch");
const config = require("../config/config.json");
const vod = require("./middleware/vod");
const emotes = require("./middleware/emotes");
const fs = require("fs");

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};

module.exports.check = async (app) => {
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

  const streamExists = await app
    .service("streams")
    .get(stream[0].id)
    .then(() => true)
    .catch(() => false);

  if (!streamExists)
    await app
      .service("streams")
      .create({
        id: stream[0].id,
        started_at: stream[0].started_at,
      })
      .then(() =>
        console.log(
          `${config.channel} stream online. Created Stream. ${stream[0].started_at}`
        )
      )
      .catch((e) => {
        console.error(e);
      });

  const vodData = await twitch.getLatestVodData(twitchId);

  if (!vodData)
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  if (vodData.stream_id !== stream[0].id)
    return setTimeout(() => {
      this.check(app);
    }, 30000);

  const vodId = vodData.id;
  const vodExists = await app
    .service("vods")
    .get(vodId)
    .then(() => true)
    .catch(() => false);

  if (!vodExists) {
    await app
      .service("vods")
      .create({
        id: vodId,
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

  const redisClient = app.get("redisClient");

  const vodDownloading = await redisClient
    .get(`${config.channel}-vod-downloading`)
    .then((data) => data)
    .catch(() => false);

  if (config.vodDownload && !vodDownloading) {
    redisClient.set(`${config.channel}-vod-downloading`, 1);
    const dir = `${config.vodPath}/${vodId}`;
    if (await fileExists(dir))
      await fs.promises.rm(dir, {
        recursive: true,
      });
    console.info(`Start Vod download: ${vodId}`);
    vod.download(vodId, app);
  }

  const chatDownloading = await redisClient
    .get(`${config.channel}-chat-downloading`)
    .then((data) => data)
    .catch(() => false);

  if (config.chatDownload && !chatDownloading) {
    redisClient.set(`${config.channel}-chat-downloading`, 1);
    console.info(`Start Logs download: ${vodId}`);
    vod.downloadLogs(vodId, app);
    emotes.save(vodId, app);
  }

  setTimeout(() => {
    this.check(app);
  }, 30000);
};
