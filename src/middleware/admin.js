const vod = require("./vod");
const twitch = require("./twitch");
const moment = require("moment");
const momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);
const fs = require("fs");
const config = require("../../config/config.json");
const webhook = require("./webhook");

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
      vod.upload(req.body.vodId, app, req.body.path);
      res.status(200).json({ error: false, message: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(req.body.vodId);

    await app
      .service("vods")
      .create({
        id: vodData.id,
        title: vodData.title,
        date: new Date(vodData.created_at).toLocaleDateString("en-US", {
          timeZone: config.timezone,
        }),
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

    vod.upload(req.body.vodId, app, req.body.path);
    res.status(200).json({ error: false, message: "Starting download.." });
  };
};

module.exports.downloadv2 = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "Missing vod id.." });

    vod.startDownload(req.body.vodId, app);
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

module.exports.manualLogs = function (app) {
  return async function (req, res, next) {
    if (!req.body.path)
      return res.status(400).json({ error: true, message: "No log path" });

    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    vod.manualLogs(req.body.path, req.body.vodId, app);
    res.status(200).json({ error: false, message: "Starting manual logs.." });
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

    let muteSection = [],
      newVodPath,
      blackoutPath;
    for (let dmca of req.body.receivedClaims) {
      const policyType = dmca.claimPolicy.primaryPolicy.policyType;
      //check if audio
      if (
        policyType === "POLICY_TYPE_GLOBAL_BLOCK" ||
        policyType === "POLICY_TYPE_MOSTLY_GLOBAL_BLOCK" ||
        policyType === "POLICY_TYPE_BLOCK"
      ) {
        if (dmca.type === "CLAIM_TYPE_AUDIO") {
          muteSection.push(
            `volume=0:enable='between(t,${
              dmca.matchDetails.longestMatchStartTimeSeconds
            },${
              parseInt(dmca.matchDetails.longestMatchDurationSeconds) +
              parseInt(dmca.matchDetails.longestMatchStartTimeSeconds)
            })'`
          );
        } else if (dmca.type === "CLAIM_TYPE_VISUAL") {
          console.info(
            `Trying to blackout ${
              blackoutPath ? blackoutPath : vodPath
            }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
          );
          blackoutPath = await vod.blackoutVideo(
            blackoutPath ? blackoutPath : vodPath,
            vodId,
            dmca.matchDetails.longestMatchStartTimeSeconds,
            dmca.matchDetails.longestMatchDurationSeconds,
            parseInt(dmca.matchDetails.longestMatchStartTimeSeconds) +
              parseInt(dmca.matchDetails.longestMatchDurationSeconds)
          );
        } else if (dmca.type === "CLAIM_TYPE_AUDIOVISUAL") {
          muteSection.push(
            `volume=0:enable='between(t,${
              dmca.matchDetails.longestMatchStartTimeSeconds
            },${
              parseInt(dmca.matchDetails.longestMatchDurationSeconds) +
              parseInt(dmca.matchDetails.longestMatchStartTimeSeconds)
            })'`
          );
          console.info(
            `Trying to blackout ${
              blackoutPath ? blackoutPath : vodPath
            }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
          );
          blackoutPath = await vod.blackoutVideo(
            blackoutPath ? blackoutPath : vodPath,
            vodId,
            dmca.matchDetails.longestMatchStartTimeSeconds,
            dmca.matchDetails.longestMatchDurationSeconds,
            parseInt(dmca.matchDetails.longestMatchStartTimeSeconds) +
              parseInt(dmca.matchDetails.longestMatchDurationSeconds)
          );
        }
      }
    }

    if (muteSection.length > 0) {
      console.info(`Trying to mute ${blackoutPath ? blackoutPath : vodPath}`);
      newVodPath = await vod.mute(
        blackoutPath ? blackoutPath : vodPath,
        muteSection,
        vodId
      );
      if (!newVodPath) return console.error("failed to mute video");
      if (blackoutPath) fs.unlinkSync(blackoutPath);
    }

    fs.unlinkSync(vodPath);

    vod.upload(vodId, app, newVodPath ? newVodPath : blackoutPath);
  };
};

module.exports.trim = function (app) {
  return async function (req, res, next) {
    if (!req.body.chapters)
      return res
        .status(400)
        .json({ error: true, msg: "Invalid request: Missing chapters.." });
    if (!req.body.vodId)
      return res
        .status(400)
        .json({ error: true, msg: "Invalid request: Missing vod id.." });

    let vod_data;
    await app
      .service("vods")
      .get(req.body.vodId)
      .then((data) => {
        vod_data = data;
      })
      .catch(() => {});

    if (!vod_data) return console.error("Failed get vod: no VOD in database");

    res.status(200).json({ error: false, msg: "Starting trim process.." });

    const vodPath = await vod.download(req.body.vodId);

    for (let chapter of req.body.chapters) {
      if (!chapter.start) return console.error("Start time missing");
      if (!chapter.end) return console.error("End time missing");
      if (!chapter.title) return console.error("Title missing");

      const trimmedPath = await vod.trim(
        vodPath,
        vod_data.id,
        chapter.start,
        chapter.end
      );

      await vod.trimUpload(trimmedPath, chapter.title);
    }

    fs.unlinkSync(vodPath);
  };
};

module.exports.trimDmca = function (app) {
  return async function (req, res, next) {
    if (!req.body.chapter)
      return res
        .status(400)
        .json({ error: true, msg: "Invalid request: Missing chapter.." });
    if (!req.body.vodId)
      return res
        .status(400)
        .json({ error: true, msg: "Invalid request: Missing vod id.." });

    let vod_data;
    await app
      .service("vods")
      .get(req.body.vodId)
      .then((data) => {
        vod_data = data;
      })
      .catch(() => {});

    if (!vod_data) return console.error("Failed get vod: no VOD in database");

    res.status(200).json({ error: false, msg: "Starting trim dmca process.." });

    const vodId = req.body.vodId;
    const vodPath = await vod.download(vodId);
    const chapter = req.body.chapter;

    if (!chapter.start) return console.error("Start time missing");
    if (!chapter.end) return console.error("End time missing");
    if (!chapter.title) return console.error("Title missing");

    const trimmedPath = await vod.trim(
      vodPath,
      vod_data.id,
      chapter.start,
      chapter.end
    );

    let muteSection = [],
      newVodPath,
      blackoutPath;
    for (let dmca of req.body.receivedClaims) {
      //check if audio
      if (dmca.type === "CLAIM_TYPE_AUDIO") {
        muteSection.push(
          `volume=0:enable='between(t,${
            dmca.matchDetails.longestMatchStartTimeSeconds
          },${
            parseInt(dmca.matchDetails.longestMatchDurationSeconds) +
            parseInt(dmca.matchDetails.longestMatchStartTimeSeconds)
          })'`
        );
      } else if (dmca.type === "CLAIM_TYPE_VISUAL") {
        console.info(
          `Trying to blackout ${
            blackoutPath ? blackoutPath : trimmedPath
          }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
        );
        blackoutPath = await vod.blackoutVideo(
          blackoutPath ? blackoutPath : trimmedPath,
          vodId,
          dmca.matchDetails.longestMatchStartTimeSeconds,
          dmca.matchDetails.longestMatchDurationSeconds,
          parseInt(dmca.matchDetails.longestMatchStartTimeSeconds) +
            parseInt(dmca.matchDetails.longestMatchDurationSeconds)
        );
      } else if (dmca.type === "CLAIM_TYPE_AUDIOVISUAL") {
        muteSection.push(
          `volume=0:enable='between(t,${
            dmca.matchDetails.longestMatchStartTimeSeconds
          },${
            parseInt(dmca.matchDetails.longestMatchDurationSeconds) +
            parseInt(dmca.matchDetails.longestMatchStartTimeSeconds)
          })'`
        );
        console.info(
          `Trying to blackout ${
            blackoutPath ? blackoutPath : vodPath
          }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
        );
        blackoutPath = await vod.blackoutVideo(
          blackoutPath ? blackoutPath : vodPath,
          vodId,
          dmca.matchDetails.longestMatchStartTimeSeconds,
          dmca.matchDetails.longestMatchDurationSeconds,
          parseInt(dmca.matchDetails.longestMatchStartTimeSeconds) +
            parseInt(dmca.matchDetails.longestMatchDurationSeconds)
        );
      }
    }

    if (muteSection.length > 0) {
      console.info(
        `Trying to mute ${blackoutPath ? blackoutPath : trimmedPath}`
      );
      newVodPath = await vod.mute(
        blackoutPath ? blackoutPath : trimmedPath,
        muteSection,
        vodId
      );
      if (!newVodPath) return console.error("failed to mute video");
      if (blackoutPath) fs.unlinkSync(blackoutPath);
    }

    if (!newVodPath && !blackoutPath)
      return console.error(
        "nothing to mute or blackout. don't try to upload.."
      );
    await vod.trimUpload(
      newVodPath ? newVodPath : blackoutPath,
      chapter.title,
      vod_data.date
    );

    fs.unlinkSync(vodPath);
  };
};

module.exports.saveChapters = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    webhook.saveChapters(req.body.vodId, app);
    res
      .status(200)
      .json({ error: false, message: `Saving Chapters for ${req.body.vodId}` });
  };
};
