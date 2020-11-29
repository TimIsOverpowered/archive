const vod = require("./vod");
const twitch = require("./twitch");
const moment = require("moment");
const momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);
const fs = require("fs");

module.exports.verify = function (app) {
  return async function (req, res, next) {
    if (!req.headers["authorization"]) {
      res.status(403).json({ error: true, message: "Missing auth key" });
      return;
    }

    const authKey = req.headers.authorization.split(" ")[1];
    const key = app.get("ADMIN_API_KEY");

    if (key !== authKey) {
      res.status(403).json({ error: true, message: "Not authorized" });
      return;
    }
    next();
  };
};

module.exports.download = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No VodId" });

    let exists;
    await app
      .service("vods")
      .get(req.body.vodId)
      .then(() => {
        exists = true;
      })
      .catch(() => {
        exists = false;
      });
    if (exists) {
      vod.upload(req.body.vodId, app);
      res.status(200).json({ error: false, message: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(req.body.vodId);

    await app
      .service("vods")
      .create({
        id: vodData.id,
        title: vodData.title,
        date: new Date(vodData.created_at).toLocaleDateString(),
        createdAt: vodData.created_at,
        duration: moment
          .duration("PT" + vodData.duration.toUpperCase())
          .format("HH:mm:ss", { trim: false }),
      })
      .then(() => {
        console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
      })
      .catch((e) => {
        console.error(e);
      });

    vod.upload(req.body.vodId, app);
    res.status(200).json({ error: false, message: "Starting download.." });
  };
};

module.exports.logs = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No VodId" });

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
        message: `Logs already exist for ${req.body.vodId}`,
      });

    vod.getLogs(req.body.vodId, app);
    res.status(200).json({ error: false, message: "Getting logs.." });
  };
};

module.exports.delete = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No VodId" });

    res
      .status(200)
      .json({ error: false, message: "Starting deletion process.." });

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

module.exports.dmca = function (app) {
  return async function (req, res, next) {
    if (!req.body.receivedClaims)
      return res.status(400).json({ error: true, message: "No claims" });

    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    const vodId = req.body.vodId;

    let vod_data;
    await app
      .service("vods")
      .get(vodId)
      .then((data) => {
        vod_data = data;
      })
      .catch(() => {});

    if (!vod_data)
      return console.error("Failed to download video: no VOD in database");

    res.status(200).json({
      error: false,
      message: `Muting the DMCA content for ${vodId}...`,
    });

    const vodPath = await vod.download(vodId);

    let muteSection = [];
    for (let dmca of req.body.receivedClaims) {
      const policyType = dmca.claimPolicy.primaryPolicy.policyType;
      if (
        policyType === "POLICY_TYPE_GLOBAL_BLOCK" ||
        policyType === "POLICY_TYPE_MOSTLY_GLOBAL_BLOCK" ||
        policyType === "POLICY_TYPE_BLOCK"
      ) {
        muteSection.push(
          `volume=0:enable='between(t,${
            dmca.matchDetails.longestMatchStartTimeSeconds
          },${
            dmca.matchDetails.longestMatchDurationSeconds +
            dmca.matchDetails.longestMatchStartTimeSeconds
          })'`
        );
      }
    }

    console.info(`Trying to mute ${vodPath}`);
    const newVodPath = await vod.mute(vodPath, muteSection, vodId);

    if (!newVodPath) return console.error("failed to mute video");
    fs.unlinkSync(vodPath);

    const duration = moment.duration(vod_data.duration).asSeconds();

    if (duration > 43200) {
      let paths = await vod.splitVideo(newVodPath, duration, vodId);

      if (!paths)
        return console.error("Something went wrong trying to split the video");

      for (let i = 0; i < paths.length; i++) {
        let chapters = [];
        if (vod_data.chapters) {
          for (let chapter of vod_data.chapters) {
            const chapterDuration = moment
              .duration(chapter.duration)
              .asSeconds();
            if (chapterDuration > 43200 * i) {
              chapter.duration = moment
                .utc((chapterDuration - 43200 * i) * 1000)
                .format("HH:mm:ss");
            }
            chapters.push(chapter);
          }
        }
        const data = {
          path: paths[i],
          title: `${vod_data.title} (${vod_data.date} VOD) PART ${i + 1}`,
          date: vod_data.date,
          chapters: chapters,
          vodId: vodId,
        };
        await vod.uploadVideo(data, app, true);
      }
      return;
    }

    const data = {
      path: newVodPath,
      title: `${vod_data.title} (${vod_data.date} VOD)`,
      date: vod_data.date,
      chapters: vod_data.chapters,
      vodId: vodId,
    };

    await vod.uploadVideo(data, app, true);
  };
};

module.exports.dmcaVideo = function (app) {
  return async function (req, res, next) {
    if (!req.body.receivedClaims)
      return res.status(400).json({ error: true, message: "No claims" });

    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    const vodId = req.body.vodId;

    let vod_data;
    await app
      .service("vods")
      .get(vodId)
      .then((data) => {
        vod_data = data;
      })
      .catch(() => {});

    if (!vod_data)
      return console.error("Failed to download video: no VOD in database");

    res.status(200).json({
      error: false,
      message: `Trimming the DMCA video content for ${vodId}...`,
    });

    const vodPath = await vod.download(vodId);

    let newVodPath;
    for (let dmca of req.body.receivedClaims) {
      const policyType = dmca.claimPolicy.primaryPolicy.policyType;
      if (
        policyType === "POLICY_TYPE_GLOBAL_BLOCK" ||
        policyType === "POLICY_TYPE_MOSTLY_GLOBAL_BLOCK" ||
        policyType === "POLICY_TYPE_BLOCK"
      ) {
        console.info(
          `Trying to trim ${vodPath}. Claim: ${JSON.stringify(
            dmca.asset.metadata
          )}`
        );
        newVodPath = await vod.trim(
          vodPath,
          vodId,
          dmca.matchDetails.longestMatchStartTimeSeconds,
          dmca.matchDetails.longestMatchDurationSeconds,
          parseInt(dmca.matchDetails.longestMatchStartTimeSeconds) +
            parseInt(dmca.matchDetails.longestMatchDurationSeconds)
        );
      }
    }

    if (!newVodPath) return;

    const duration = moment.duration(vod_data.duration).asSeconds();

    if (duration > 43200) {
      let paths = await vod.splitVideo(newVodPath, duration, vodId);

      if (!paths)
        return console.error("Something went wrong trying to split the video");

      for (let i = 0; i < paths.length; i++) {
        let chapters = [];
        if (vod_data.chapters) {
          for (let chapter of vod_data.chapters) {
            const chapterDuration = moment
              .duration(chapter.duration)
              .asSeconds();
            if (chapterDuration > 43200 * i) {
              chapter.duration = moment
                .utc((chapterDuration - 43200 * i) * 1000)
                .format("HH:mm:ss");
            }
            chapters.push(chapter);
          }
        }
        const data = {
          path: paths[i],
          title: `${vod_data.title} (${vod_data.date} VOD) PART ${i + 1}`,
          date: vod_data.date,
          chapters: chapters,
          vodId: vodId,
        };
        await vod.uploadVideo(data, app, true);
      }
      return;
    }

    const data = {
      path: newVodPath,
      title: `${vod_data.title} (${vod_data.date} VOD)`,
      date: vod_data.date,
      chapters: vod_data.chapters,
      vodId: vodId,
    };

    await vod.uploadVideo(data, app, true);
  };
};
