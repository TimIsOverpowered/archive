const twitch = require("./middleware/twitch");
const kick = require("./middleware/kick");
const config = require("../config/config.json");
const vod = require("./middleware/vod");
const emotes = require("./middleware/emotes");
const fs = require("fs");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};

module.exports.checkTwitch = async (app) => {
  const twitchId = config.twitch.id;
  const stream = await twitch.getStream(twitchId);

  if (!stream)
    return setTimeout(() => {
      this.checkTwitch(app);
    }, 30000);

  if (!stream[0])
    return setTimeout(() => {
      this.checkTwitch(app);
    }, 30000);

  const streamExists = await app
    .service("streams")
    .get(stream.id)
    .then(() => true)
    .catch(() => false);

  if (!streamExists)
    await app
      .service("streams")
      .create({
        id: stream[0].id,
        started_at: stream[0].started_at,
        platform: "twitch",
        is_live: true,
      })
      .then(() =>
        console.log(
          `${config.channel} twitch stream online. Created Stream. ${stream[0].started_at}`
        )
      )
      .catch((e) => {
        console.error(e);
      });

  const vodData = await twitch.getLatestVodData(twitchId);

  if (!vodData)
    return setTimeout(() => {
      this.checkTwitch(app);
    }, 30000);

  if (vodData.stream_id !== stream[0].id)
    return setTimeout(() => {
      this.checkTwitch(app);
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
        createdAt: vodData.created_at,
        stream_id: vodData.stream_id,
        platform: "twitch",
      })
      .then(() =>
        console.log(
          `${config.channel} has a new twitch vod. Creating vod. ${dayjs
            .utc(vodData.createdAt)
            .format("MM-DD-YYYY")}`
        )
      )
      .catch((e) => {
        console.error(e);
      });
  }

  const vodDownloading = app.get(`${config.channel}-${vodId}-vod-downloading`);

  if (config.vodDownload && !vodDownloading) {
    app.set(`${config.channel}-${vodId}-vod-downloading`, true);
    const dir = `${config.vodPath}/${vodId}`;
    if (await fileExists(dir))
      await fs.promises.rm(dir, {
        recursive: true,
      });
    console.info(`Start Vod download: ${vodId}`);
    vod.download(vodId, app, 0, 1, true);
  }

  const chatDownloading = app.get(
    `${config.channel}-${vodId}-chat-downloading`
  );

  if (config.chatDownload && !chatDownloading) {
    //app.set(`${config.channel}-${vodId}-chat-downloading`, true);
    //console.info(`Start Logs download: ${vodId}`);
    //vod.downloadLogs(vodId, app);
    emotes.save(vodId, app);
  }

  setTimeout(() => {
    this.checkTwitch(app);
  }, 30000);
};

module.exports.checkKick = async (app) => {
  const kickChannel = config.kick.username;
  const stream = await kick.getStream(app, kickChannel);

  if (!stream)
    return setTimeout(() => {
      this.checkKick(app);
    }, 30000);

  if (!stream.data)
    return setTimeout(() => {
      this.checkKick(app);
    }, 30000);

  const streamData = stream.data;
  const streamId = streamData.id.toString();

  const streamExists = await app
    .service("streams")
    .get(streamId)
    .then(() => true)
    .catch(() => false);

  if (!streamExists)
    await app
      .service("streams")
      .create({
        id: streamId,
        started_at: streamData.created_at,
        platform: "kick",
        is_live: true,
      })
      .then(() =>
        console.log(
          `${config.channel} kick stream online. Created Stream. ${streamData.created_at}`
        )
      )
      .catch((e) => {
        console.error(e);
      });

  const vodData = await kick.getVod(app, kickChannel, streamId);

  if (!vodData)
    return setTimeout(() => {
      this.checkKick(app);
    }, 30000);

  const vodExists = await app
    .service("vods")
    .get(streamId)
    .then(() => true)
    .catch(() => false);

  if (!vodExists) {
    await app
      .service("vods")
      .create({
        id: streamId,
        title: streamData.session_title,
        createdAt: streamData.created_at,
        platform: "kick",
      })
      .then(() =>
        console.log(
          `${config.channel} has a new kick vod. Creating vod. ${dayjs
            .utc(streamData.created_at)
            .format("MM-DD-YYYY")}`
        )
      )
      .catch((e) => {
        console.error(e);
      });
  }

  const vodDownloading = app.get(`${config.channel}-${streamId}-vod-downloading`);

  if (config.vodDownload && !vodDownloading) {
    app.set(`${config.channel}-${streamId}-vod-downloading`, true);
    const dir = `${config.vodPath}/${streamId}`;
    if (await fileExists(dir))
      await fs.promises.rm(dir, {
        recursive: true,
      });
    console.info(`Start Vod download: ${streamId}`);
    await kick.downloadHLS(streamId, app, vodData.source);
  }

  const chatDownloading = app.get(
    `${config.channel}-${streamId}-chat-downloading`
  );

  if (config.chatDownload && !chatDownloading) {
    //app.set(`${config.channel}-${streamId}-chat-downloading`, true);
    //console.info(`Start Logs download: ${streamId}`);
    //kick.downloadLogs(streamId, app);
    emotes.save(streamId, app);
  }

  setTimeout(() => {
    this.checkKick(app);
  }, 30000);
};