const vod = require("./vod");
const twitch = require("./twitch");
const kick = require("./kick");
const fs = require("fs");
const config = require("../../config/config.json");
const drive = require("./drive");
const emotes = require("./emotes");
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
dayjs.extend(duration);

module.exports.verify = function (app) {
  return async function (req, res, next) {
    if (!req.headers["authorization"]) {
      res.status(403).json({ error: true, msg: "Missing auth key" });
      return;
    }

    const authKey = req.headers.authorization.split(" ")[1];
    const key = app.get("ADMIN_API_KEY");

    if (key !== authKey) {
      res.status(403).json({ error: true, msg: "Not authorized" });
      return;
    }
    next();
  };
};

module.exports.download = function (app) {
  return async function (req, res, next) {
    const { vodId, type, platform, path } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No VodId" });
    if (!type) return res.status(400).json({ error: true, msg: "No type" });
    if (!platform)
      return res.status(400).json({ error: true, msg: "No platform" });

    const exists = await app
      .service("vods")
      .get(vodId)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      vod.upload(vodId, app, path, type);
      res.status(200).json({ error: false, msg: "Starting download.." });
      return;
    }

    if (platform === "twitch") {
      const vodData = await twitch.getVodData(vodId);
      if (!vodData)
        return res.status(404).json({ error: true, msg: "No Vod Data" });

      if (vodData.user_id !== config.twitch.id)
        return res.status(400).json({
          error: true,
          msg: "This vod belongs to another channel..",
        });

      await app
        .service("vods")
        .create({
          id: vodData.id,
          title: vodData.title,
          createdAt: vodData.created_at,
          duration: dayjs
            .duration(`PT${vodData.duration.toUpperCase()}`)
            .format("HH:mm:ss"),
          stream_id: vodData.stream_id,
          platform: "twitch",
        })
        .then(() => {
          console.info(
            `Created twitch vod ${vodData.id} for ${vodData.user_name}`
          );
        })
        .catch((e) => {
          console.error(e);
        });

      res.status(200).json({ error: false, msg: "Starting download.." });
      emotes.save(vodId, app);
      const vodPath = await vod.upload(vodId, app, path, type, "twitch");
      if (vodPath) fs.unlinkSync(vodPath);
    } else if (platform === "kick") {
      const vodData = await kick.getVod(vodId, config.kick.username);
      if (!vodData)
        return res.status(404).json({ error: true, msg: "No Vod Data" });

      if (vodData.channel_id.toString() !== config.kick.id)
        return res.status(400).json({
          error: true,
          msg: "This vod belongs to another channel..",
        });

      await app
        .service("vods")
        .create({
          id: vodData.id.toString(),
          title: vodData.session_title,
          createdAt: vodData.start_time,
          duration: dayjs
            .duration(vodData.duration, "milliseconds")
            .format("HH:mm:ss"),
          stream_id: vodData.video.uuid,
          platform: "kick",
        })
        .then(() => {
          console.info(
            `Created kick vod ${vodData.id} for ${vodData.user_name}`
          );
        })
        .catch((e) => {
          console.error(e);
        });
      res.status(200).json({ error: false, msg: "Starting download.." });
      emotes.save(vodId, app);
      const vodPath = await vod.upload(vodId, app, path, type, "kick");
      if (vodPath) fs.unlinkSync(vodPath);
    }
  };
};

module.exports.hlsDownload = function (app) {
  return async function (req, res, next) {
    const { vodId } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No VodId" });

    const exists = await app
      .service("vods")
      .get(vodId)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      console.info(`Start Vod download: ${vodId}`);
      vod.download(vodId, app);
      console.info(`Start Logs download: ${vodId}`);
      vod.downloadLogs(vodId, app);
      res.status(200).json({ error: false, msg: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(vodId);
    if (!vodData)
      return res.status(404).json({ error: true, msg: "No Vod Data" });

    if (vodData.user_id !== config.twitch.id)
      return res.status(400).json({
        error: true,
        msg: "This vod belongs to another channel..",
      });

    await app
      .service("vods")
      .create({
        id: vodData.id,
        title: vodData.title,
        createdAt: vodData.created_at,
        duration: dayjs
          .duration(`PT${vodData.duration.toUpperCase()}`)
          .format("HH:mm:ss"),
        stream_id: vodData.stream_id,
      })
      .then(() => {
        console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
      })
      .catch((e) => {
        console.error(e);
      });

    console.info(`Start Vod download: ${vodId}`);
    vod.download(vodId, app);
    console.info(`Start Logs download: ${vodId}`);
    vod.downloadLogs(vodId, app);
    res.status(200).json({ error: false, msg: "Starting download.." });
  };
};

module.exports.logs = function (app) {
  return async function (req, res, next) {
    const { vodId, platform } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No VodId" });
    if (!platform)
      return res.status(400).json({ error: true, msg: "No Platform" });

    let total;
    app
      .service("logs")
      .find({
        query: {
          $limit: 0,
          vod_id: vodId,
        },
      })
      .then((data) => {
        total = data.total;
      })
      .catch((e) => {
        console.error(e);
      });

    if (total > 1)
      return res.status(400).json({
        error: true,
        msg: `Logs already exist for ${vodId}`,
      });

    if (platform === "twitch") {
      vod.getLogs(vodId, app);
      res.status(200).json({ error: false, msg: "Getting logs.." });
    } else if (platform === "kick") {
      const vodData = await kick.getVod(config.kick.username, vodId);
      kick.downloadLogs(vodId, app, dayjs.utc(vodData.start_time).toISOString(), vodData.duration);
      res.status(200).json({ error: false, msg: "Getting logs.." });
    } else {
      res.status(400).json({ error: false, msg: "Platform not supported.." });
    }
  };
};

module.exports.manualLogs = function (app) {
  return async function (req, res, next) {
    const { vodId, path } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No VodId" });
    if (!path) return res.status(400).json({ error: true, msg: "No Path" });

    vod.manualLogs(path, vodId, app);
    res.status(200).json({ error: false, msg: "Getting logs.." });
  };
};

module.exports.createVod = function (app) {
  return async function (req, res, next) {
    const { vodId, title, createdAt, duration, drive, platform } = req.body;
    if (vodId == null)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: Vod id" });
    if (!title)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: Title" });
    if (!createdAt)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: CreatedAt" });
    if (!duration)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: Duration" });
    if (!platform)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: platform" });

    const exists = await app
      .service("vods")
      .get(vodId)
      .then(() => true)
      .catch(() => false);

    if (exists)
      return res
        .status(400)
        .json({ error: true, msg: `${vodId} already exists!` });

    await app
      .service("vods")
      .create({
        id: vodId,
        title: title,
        createdAt: createdAt,
        duration: duration,
        drive: drive ? [drive] : [],
      })
      .then(() => {
        console.info(`Created vod ${vodId}`);
        res.status(200).json({ error: false, msg: `${vodId} Created!` });
      })
      .catch((e) => {
        console.error(e);
        res
          .status(200)
          .json({ error: true, msg: `Failed to create ${vodId}!` });
      });
  };
};

module.exports.deleteVod = function (app) {
  return async function (req, res, next) {
    const { vodId } = req.body;
    if (vodId == null)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: Vod id" });

    res.status(200).json({ error: false, msg: "Starting deletion process.." });

    await app
      .service("vods")
      .remove(vodId)
      .then(() => {
        console.info(`Deleted vod for ${vodId}`);
      })
      .catch((e) => {
        console.error(e);
      });

    await app
      .service("logs")
      .remove(null, {
        query: {
          vod_id: vodId,
        },
      })
      .then(() => {
        console.info(`Deleted logs for ${vodId}`);
      })
      .catch((e) => {
        console.error(e);
      });
  };
};

module.exports.reUploadPart = function (app) {
  return async function (req, res, next) {
    const { vodId, part, type } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!part) return res.status(400).json({ error: true, msg: "No part" });
    if (!type) return res.status(400).json({ error: true, msg: "No type" });

    res.status(200).json({
      error: false,
      msg: `Reuploading ${vodId} Vod Part ${part}`,
    });

    const driveVideo = await drive.download(vodId, type, app);

    if (!driveVideo)
      return console.error(`Could not find a download source for ${vodId}`);

    console.info(`Finished download`);

    if (type === "live") {
      await vod.liveUploadPart(
        app,
        vodId,
        driveVideo,
        config.youtube.splitDuration * parseInt(part) - 1,
        config.youtube.splitDuration,
        part,
        type
      );
    } else {
      await vod.liveUploadPart(
        app,
        vodId,
        driveVideo,
        config.youtube.splitDuration * parseInt(part) - 1,
        config.youtube.splitDuration,
        part,
        type
      );
    }
    fs.unlinkSync(driveVideo);
  };
};

module.exports.saveChapters = function (app) {
  return async function (req, res, next) {
    const { vodId, platform } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!platform)
      return res.status(400).json({ error: true, msg: "No platform" });

    if (platform === "twitch") {
      const vodData = await twitch.getVodData(vodId);
      if (!vodData)
        return res.status(500).json({
          error: true,
          msg: `Failed to get vod data for ${vodId}`,
        });

      vod.saveChapters(
        vodData.id,
        app,
        dayjs.duration(`PT${vodData.duration.toUpperCase()}`).asSeconds()
      );
      res
        .status(200)
        .json({ error: false, msg: `Saving Chapters for ${vodId}` });
    } else if (platform === "kick") {
      //TODO
      res
        .status(200)
        .json({ error: false, msg: `Saving Chapters for ${vodId}` });
    } else {
      res.status(400).json({ error: true, msg: `Platform not supported..` });
    }
  };
};

module.exports.saveDuration = function (app) {
  return async function (req, res, next) {
    const { vodId, platform } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!platform)
      return res.status(400).json({ error: true, msg: "No platform" });

    if (platform === "twitch") {
      const vodData = await twitch.getVodData(vodId);
      if (!vodData)
        return res.status(500).json({
          error: true,
          msg: `Failed to get vod data for ${vodId}`,
        });

      const exists = await app
        .service("vods")
        .get(vodId)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        await app
          .service("vods")
          .patch(vodId, {
            duration: dayjs
              .duration(`PT${vodData.duration.toUpperCase()}`)
              .format("HH:mm:ss"),
          })
          .then(() =>
            res.status(200).json({ error: false, msg: "Saved duration!" })
          )
          .catch(() =>
            res
              .status(500)
              .json({ error: true, msg: "Failed to save duration!" })
          );
        return;
      }
    } else if (platform === "kick") {
      //TODO
      return;
    }

    res.status(404).json({ error: true, msg: "Vod does not exist!" });
  };
};

module.exports.addGame = function (app) {
  return async function (req, res, next) {
    const {
      vod_id,
      start_time,
      end_time,
      video_provider,
      video_id,
      game_id,
      game_name,
      thumbnail_url,
    } = req.body;
    if (vod_id == null)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter vod_id" });
    if (start_time == null)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: start_time" });
    if (end_time == null)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: end_time" });
    if (!video_provider)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: video_provider" });
    if (!video_id)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: video_id" });
    if (!game_id)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: game_id" });
    if (!game_name)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: game_name" });
    if (!thumbnail_url)
      return res
        .status(400)
        .json({ error: true, msg: "Missing parameter: thumbnail_url" });

    const exists = await app
      .service("vods")
      .get(vod_id)
      .then(() => true)
      .catch(() => false);

    if (!exists)
      return res
        .status(400)
        .json({ error: true, msg: `${vod_id} does not exist!` });

    await app
      .service("games")
      .create({
        vodId: vod_id,
        start_time: start_time,
        end_time: end_time,
        video_provider: video_provider,
        video_id: video_id,
        game_id: game_id,
        game_name: game_name,
        thumbnail_url: thumbnail_url,
      })
      .then(() => {
        console.info(`Created ${game_name} in games DB for ${vod_id}`);
        res.status(200).json({
          error: false,
          msg: `Created ${game_name} in games DB for ${vod_id}`,
        });
      })
      .catch((e) => {
        console.error(e);
        res.status(500).json({
          error: true,
          msg: `Failed to create ${game_name} in games DB for ${vod_id}`,
        });
      });
  };
};

module.exports.saveEmotes = function (app) {
  return async function (req, res, next) {
    const { vodId } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No VodId" });

    emotes.save(vodId, app);
    res.status(200).json({ error: false, msg: "Saving emotes.." });
  };
};

module.exports.vodUpload = function (app) {
  return async function (req, res, next) {
    const { vodId, type } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!type) return res.status(400).json({ error: true, msg: "No type" });

    res.status(200).json({
      error: false,
      msg: `Reuploading ${vodId} Vod`,
    });

    let videoPath = `${
      type === "live" ? config.livePath : config.vodPath
    }/${vodId}.mp4`;

    if (!(await fileExists(videoPath))) {
      if (config.drive.upload) {
        videoPath = await drive.download(vodId, type, app);
      } else {
        videoPath = null;
      }
    }

    if (!videoPath)
      return console.error(
        `Could not find a download source for ${req.body.vodId}`
      );

    vod.manualVodUpload(app, vodId, videoPath, type);
  };
};

module.exports.gameUpload = function (app) {
  return async function (req, res, next) {
    const { vodId, type, chapterIndex } = req.body;
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!type) return res.status(400).json({ error: true, msg: "No type" });
    if (chapterIndex == null)
      return res.status(400).json({ error: true, msg: "No chapter" });

    let vod;
    await app
      .service("vods")
      .get(vodId)
      .then((data) => {
        vod = data;
      })
      .catch(() => {});

    if (!vod)
      res.status(404).json({
        error: true,
        msg: "Vod does not exist",
      });

    const game = vod.chapters[chapterIndex];
    if (!game)
      res.status(404).json({
        error: true,
        msg: "Chapter does not exist",
      });

    res.status(200).json({
      error: false,
      msg: `Uploading ${chapter.name} from ${vodId} Vod`,
    });

    let videoPath = `${
      type === "live" ? config.livePath : config.vodPath
    }/${vodId}.mp4`;

    if (!(await fileExists(videoPath))) {
      if (config.drive.upload) {
        videoPath = await drive.download(vodId, type, app);
      } else {
        videoPath = null;
      }
    }

    if (!videoPath)
      return console.error(
        `Could not find a download source for ${req.body.vodId}`
      );

    vod.manualGameUpload(
      app,
      vodId,
      {
        vodId: vodId,
        date: vod.createdAt,
        chapter: game,
      },
      videoPath
    );
  };
};

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};
