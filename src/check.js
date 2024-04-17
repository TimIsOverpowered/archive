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
    vod.download(vodId, app);
  }

  const chatDownloading = app.get(
    `${config.channel}-${vodId}-chat-downloading`
  );

  if (config.chatDownload && !chatDownloading) {
    app.set(`${config.channel}-${vodId}-chat-downloading`, true);
    console.info(`Start Logs download: ${vodId}`);
    vod.downloadLogs(vodId, app);
    emotes.save(vodId, app);
  }

  setTimeout(() => {
    this.checkTwitch(app);
  }, 30000);
};

module.exports.checkKick = async (app) => {
  const kickChannel = config.kick.username;
  const stream = await kick.getStream(app, kickChannel);

  if (stream && stream.data) {
    const streamData = stream.data;
    const streamExists = await app
      .service("streams")
      .get(streamData.id.toString())
      .then(() => true)
      .catch(() => false);

    if (!streamExists) {
      await app
        .service("streams")
        .create({
          id: streamData.id,
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

      await app
        .service("vods")
        .create({
          id: streamData.id,
          title: streamData.session_title,
          createdAt: streamData.created_at,
          platform: "kick",
        })
        .then(() =>
          console.log(
            `${config.channel} has a new kick vod. Creating vod. ${dayjs
              .utc(streamData.createdAt)
              .format("MM-DD-YYYY")}`
          )
        )
        .catch((e) => {
          console.error(e);
        });
    }

    await kick.saveChapters(streamData, app);
  }

  //If Live stream has ended, set is_live to false & get vod data & download vod
  const liveStreams = await app
    .service("streams")
    .find({
      query: {
        is_live: true,
        platform: "kick",
      },
    })
    .then((res) => res.data)
    .catch(() => null);

  if (stream && !stream.data) {
    for (let livestream of liveStreams) {
      await app
        .service("streams")
        .patch(livestream.id, {
          is_live: false,
        })
        .catch((e) => console.error(e));

      let kickVod;
      do {
        kickVod = await kick.getVod(app, kickChannel, livestream.id);
        console.info("Kick stream has ended. Trying to get kick vod..");
        await sleep(1 * 60 * 1000);
      } while (!kickVod);

      await app
        .service("vods")
        .patch(livestream.id, {
          id: kickVod.video.uuid,
          duration: dayjs
            .duration(kickVod.duration, "milliseconds")
            .format("HH:mm:ss"),
        })
        .catch((e) => console.error(e));

      if (config.vodDownload) {
        console.info(`Start Vod download: ${livestream.id}`);
        await vod.upload(livestream.id, app, false, "vod");
      }

      if (config.chatDownload) {
        //console.info(`Start Logs download: ${livestream.id}`);
        //kick.downloadLogs(livestream.id, app, dayjs.utc(kickVod.start_time).toISOString(), kickVod.duration);
        emotes.save(livestream.id, app);
      }
    }
  }

  const kickVods = await kick.getVods(app, kickChannel);
  if (!kickVods)
    return setTimeout(() => {
      this.checkKick(app);
    }, 30000);

  const vodData = kickVods[0];
  if (!vodData)
    return setTimeout(() => {
      this.checkKick(app);
    }, 30000);

  const vodId = vodData.id.toString();
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
        title: vodData.session_title,
        createdAt: vodData.start_time,
        stream_id: vodData.video.uuid,
        duration: dayjs
          .duration(vodData.duration, "milliseconds")
          .format("HH:mm:ss"),
        platform: "kick",
      })
      .then(() =>
        console.log(
          `${config.channel} has a new kick vod. Creating vod. ${dayjs
            .utc(vodData.createdAt)
            .format("MM-DD-YYYY")}`
        )
      )
      .catch((e) => {
        console.error(e);
      });

    //Vods don't come up until after stream on kick
    if (config.vodDownload) {
      console.info(`Start Vod download: ${vodId}`);
      await vod.upload(vodId, app, false, "vod");
    }

    if (config.chatDownload) {
      //console.info(`Start Logs download: ${vodId}`);
      //kick.downloadLogs(vodId, app, dayjs.utc(vodData.start_time).toISOString(), vodData.duration);
      emotes.save(vodId, app);
    }
  }

  setTimeout(() => {
    this.checkKick(app);
  }, 30000);
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
