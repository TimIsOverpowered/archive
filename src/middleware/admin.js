const vod = require("./vod");
const twitch = require("./twitch");
const moment = require("moment");
const momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);
const fs = require("fs");
const config = require("../../config/config.json");
const drive = require("./drive");

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

    if (!req.body.type)
      return res.status(400).json({ error: true, message: "No type" });

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
      vod.upload(req.body.vodId, app, req.body.path, req.body.type);
      res.status(200).json({ error: false, message: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(req.body.vodId);
    if (!vodData)
      return res.status(404).json({ error: true, message: "No Vod Data" });

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

    vod.upload(req.body.vodId, app, req.body.path, req.body.type);
    res.status(200).json({ error: false, message: "Starting download.." });
  };
};

module.exports.downloadv2 = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "Missing vod id.." });

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
      vod.startDownload(req.body.vodId, app, req.body.path);
      res.status(200).json({ error: false, message: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(req.body.vodId);
    if (!vodData) return console.error("No vod data");

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

    if (!req.body.type)
      return res.status(400).json({ error: true, message: "No type" });

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

    let vodPath = await vod.download(req.body.vodId);
    if (!vodPath) vodPath = await drive.download(req.body.vodId, req.body.type);

    if (!vodPath)
      return console.error(
        `Could not find a download source for ${req.body.vodId}`
      );

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

    vod.upload(
      vodId,
      app,
      newVodPath ? newVodPath : blackoutPath,
      req.body.type
    );
  };
};

module.exports.saveChapters = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    const vodData = await twitch.getVodData(req.body.vodId);
    if (!vodData)
      return res.status(500).json({
        error: true,
        message: `Failed to get vod data for ${req.body.vodId}`,
      });

    vod.saveChapters(
      vodData.id,
      app,
      moment.duration("PT" + vodData.duration.toUpperCase()).asSeconds()
    );
    res
      .status(200)
      .json({ error: false, message: `Saving Chapters for ${req.body.vodId}` });
  };
};

module.exports.reUploadPart = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    if (!req.body.part)
      return res.status(400).json({ error: true, message: "No part" });

    if (!req.body.type)
      return res.status(400).json({ error: true, message: "No type" });

    res.status(200).json({
      error: false,
      message: `Reuploading ${req.body.vodId} Vod Part ${req.body.part}`,
    });

    const part = parseInt(req.body.part) - 1;

    const mp4Video = req.body.path
      ? req.body.path
      : await vod.download(req.body.vodId);

    if (mp4Video) {
      await vod.liveUploadPart(
        app,
        req.body.vodId,
        mp4Video,
        config.splitDuration * part,
        config.splitDuration,
        req.body.part,
        req.body.type
      );
      fs.unlinkSync(mp4Video);
    } else {
      const driveVideo = await drive.download(req.body.vodId, req.body.type);
      if (!driveVideo)
        return console.error(
          `Could not find a download source for ${req.body.vodId}`
        );
      await vod.liveUploadPart(
        app,
        req.body.vodId,
        driveVideo,
        config.splitDuration * part,
        config.splitDuration,
        req.body.part,
        req.body.type
      );

      fs.unlinkSync(driveVideo);
    }
  };
};

module.exports.partDmca = function (app) {
  return async function (req, res, next) {
    if (!req.body.receivedClaims)
      return res.status(400).json({ error: true, message: "No claims" });

    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No vod id" });

    if (!req.body.part)
      return res.status(400).json({ error: true, message: "No part" });

    if (!req.body.type)
      return res.status(400).json({ error: true, message: "No type" });

    res.status(200).json({
      error: false,
      message: `Trimming DMCA Content from ${req.body.vodId} Vod Part ${req.body.part}`,
    });

    let vod_data;
    await app
      .service("vods")
      .get(req.body.vodId)
      .then((data) => {
        vod_data = data;
      })
      .catch(() => {});

    if (!vod_data) return console.error("Failed get vod: no VOD in database");

    const mp4Video = await vod.download(req.body.vodId);
    if (mp4Video) {
      trimmedPath = await vod.trim(
        mp4Video,
        req.body.vodId,
        config.splitDuration * (parseInt(req.body.part) - 1),
        config.splitDuration
      );
      fs.unlinkSync(mp4Video);
    } else {
      const driveVideo = await drive.download(req.body.vodId, req.body.type);
      if (!driveVideo)
        return console.error(
          `Could not find a download source for ${req.body.vodId}`
        );
      trimmedPath = await vod.trim(
        driveVideo,
        req.body.vodId,
        config.splitDuration * (parseInt(req.body.part) - 1),
        config.splitDuration
      );

      fs.unlinkSync(driveVideo);
    }

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
          req.body.vodId,
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
            blackoutPath ? blackoutPath : trimmedPath
          }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
        );
        blackoutPath = await vod.blackoutVideo(
          blackoutPath ? blackoutPath : trimmedPath,
          req.body.vodId,
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
        req.body.vodId
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
      `${config.channel} ${vod_data.date} Vod Part ${req.body.part}`,
      {
        vod: vod_data,
        part: req.body.part,
        type: req.body.type,
      },
      app
    );

    fs.unlinkSync(newVodPath ? newVodPath : blackoutPath);
    fs.unlinkSync(trimmedPath);
  };
};

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};
