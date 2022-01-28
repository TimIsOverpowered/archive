const vod = require("./vod");
const twitch = require("./twitch");
const moment = require("moment");
const fs = require("fs");
const config = require("../../config/config.json");
const drive = require("./drive");
const emotes = require("./emotes");

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
    if (!req.body.vodId) return res.status(400).json({ error: true, msg: "No VodId" });

    if (!req.body.type) return res.status(400).json({ error: true, msg: "No type" });

    const exists = await app
      .service("vods")
      .get(req.body.vodId)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      vod.upload(req.body.vodId, app, req.body.path, req.body.type);
      res.status(200).json({ error: false, msg: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(req.body.vodId);
    if (!vodData) return res.status(404).json({ error: true, msg: "No Vod Data" });

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
        date: new Date(vodData.created_at).toLocaleDateString("en-US", {
          timeZone: config.timezone,
        }),
        createdAt: vodData.created_at,
        duration: moment.utc(moment.duration("PT" + vodData.duration.toUpperCase()).asMilliseconds()).format("HH:mm:ss"),
      })
      .then(() => {
        console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
      })
      .catch((e) => {
        console.error(e);
      });

    vod.upload(req.body.vodId, app, req.body.path, req.body.type);
    emotes.save(req.body.vodId, app);
    res.status(200).json({ error: false, msg: "Starting download.." });
  };
};

module.exports.hlsDownload = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId) return res.status(400).json({ error: true, msg: "No VodId" });

    const vodId = req.body.vodId;

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
    if (!vodData) return res.status(404).json({ error: true, msg: "No Vod Data" });

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
        date: new Date(vodData.created_at).toLocaleDateString("en-US", {
          timeZone: config.timezone,
        }),
        createdAt: vodData.created_at,
        duration: moment.utc(moment.duration("PT" + vodData.duration.toUpperCase()).asMilliseconds()).format("HH:mm:ss"),
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
    if (!req.body.vodId) return res.status(400).json({ error: true, msg: "No VodId" });

    let total;
    app
      .service("logs")
      .find({
        vod_id: req.body.vodId,
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
        msg: `Logs already exist for ${req.body.vodId}`,
      });

    vod.getLogs(req.body.vodId, app);
    res.status(200).json({ error: false, msg: "Getting logs.." });
  };
};

module.exports.createVod = function (app) {
  return async function (req, res, next) {
    if (req.body.vodId == null) return res.status(400).json({ error: true, msg: "Missing parameter: Vod id" });
    if (!req.body.title) return res.status(400).json({ error: true, msg: "Missing parameter: Title" });
    if (!req.body.createdAt) return res.status(400).json({ error: true, msg: "Missing parameter: CreatedAt" });
    if (!req.body.duration) return res.status(400).json({ error: true, msg: "Missing parameter: Duration" });

    const exists = await app
      .service("vods")
      .get(req.body.vodId)
      .then(() => true)
      .catch(() => false);

    if (exists) return res.status(400).json({ error: true, msg: `${req.body.vodId} already exists!` });

    await app
      .service("vods")
      .create({
        id: req.body.vodId,
        title: req.body.title,
        date: new Date(req.body.createdAt).toLocaleDateString("en-US", {
          timeZone: config.timezone,
        }),
        createdAt: req.body.createdAt,
        duration: req.body.duration,
        drive: req.body.drive ? [req.body.drive] : []
      })
      .then(() => {
        console.info(`Created vod ${req.body.vodId}`);
        res.status(200).json({ error: false, msg: `${req.body.vodId} Created!` });
      })
      .catch((e) => {
        console.error(e);
        res.status(200).json({ error: true, msg: `Failed to create ${req.body.vodId}!` });
      });
  };
};

module.exports.deleteVod = function (app) {
  return async function (req, res, next) {
    if (req.body.vodId == null) return res.status(400).json({ error: true, msg: "Missing parameter: Vod id" });

    res.status(200).json({ error: false, msg: "Starting deletion process.." });

    await app
      .service("vods")
      .remove(req.body.vodId)
      .then(() => {
        console.info(`Deleted vod for ${req.body.vodId}`);
      })
      .catch((e) => {
        console.error(e);
      });

    await app
      .service("logs")
      .remove(null, {
        query: {
          vod_id: req.body.vodId,
        },
      })
      .then(() => {
        console.info(`Deleted logs for ${req.body.vodId}`);
      })
      .catch((e) => {
        console.error(e);
      });
  };
};

module.exports.reUploadPart = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId) return res.status(400).json({ error: true, msg: "No vod id" });

    if (!req.body.part) return res.status(400).json({ error: true, msg: "No part" });

    if (!req.body.type) return res.status(400).json({ error: true, msg: "No type" });

    res.status(200).json({
      error: false,
      msg: `Reuploading ${req.body.vodId} Vod Part ${req.body.part}`,
    });

    const part = parseInt(req.body.part) - 1;

    const driveVideo = await drive.download(req.body.vodId, req.body.type, app);

    if (!driveVideo) return console.error(`Could not find a download source for ${req.body.vodId}`);

    console.info(`Finished download`);

    if (req.body.type === "live") {
      await vod.liveUploadPart(app, req.body.vodId, driveVideo, config.youtube.splitDuration * part, config.youtube.splitDuration, req.body.part, req.body.type);
    } else {
      await vod.liveUploadPart(app, req.body.vodId, driveVideo, config.youtube.splitDuration * part, config.youtube.splitDuration, req.body.part, req.body.type);
    }
    fs.unlinkSync(driveVideo);
  };
};

module.exports.saveChapters = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId) return res.status(400).json({ error: true, msg: "No vod id" });

    const vodData = await twitch.getVodData(req.body.vodId);
    if (!vodData)
      return res.status(500).json({
        error: true,
        msg: `Failed to get vod data for ${req.body.vodId}`,
      });

    vod.saveChapters(vodData.id, app, moment.duration("PT" + vodData.duration.toUpperCase()).asSeconds());
    res.status(200).json({ error: false, msg: `Saving Chapters for ${req.body.vodId}` });
  };
};

module.exports.saveDuration = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId) return res.status(400).json({ error: true, msg: "No vod id" });

    const vodData = await twitch.getVodData(req.body.vodId);
    if (!vodData)
      return res.status(500).json({
        error: true,
        msg: `Failed to get vod data for ${req.body.vodId}`,
      });

    const exists = await app
      .service("vods")
      .get(req.body.vodId)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      await app
        .service("vods")
        .patch(req.body.vodId, {
          duration: moment.utc(moment.duration("PT" + vodData.duration.toUpperCase()).asSeconds() * 1000).format("HH:mm:ss"),
        })
        .then(() => res.status(200).json({ error: false, msg: "Saved duration!" }))
        .catch(() => res.status(500).json({ error: true, msg: "Failed to save duration!" }));
      return;
    }

    res.status(404).json({ error: true, msg: "Vod does not exist!" });
  };
};
