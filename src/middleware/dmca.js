const config = require("../../config/config.json");
const ffmpeg = require("fluent-ffmpeg");
const drive = require("./drive");
const youtube = require("./youtube");
const vod = require("./vod");

module.exports.mute = async (vodPath, muteSection, vodId) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .videoCodec("copy")
      .audioFilters(muteSection)
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `MUTE VIDEO PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${path.dirname(vodPath)}/${vodId}-muted.mp4`);
      })
      .saveToFile(`${path.dirname(vodPath)}/${vodId}-muted.mp4`);
  })
    .then((result) => {
      returnPath = result;
      console.info("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return returnPath;
};

module.exports.blackoutVideo = async (vodPath, vodId, start, duration, end) => {
  const start_video_path = await getStartVideo(vodPath, vodId, start);
  if (!start_video_path) {
    console.error("failed to get start video");
    return null;
  }
  const clip_path = await getClip(vodPath, vodId, start, duration);
  if (!clip_path) {
    console.error("failed to get clip");
    return null;
  }
  const trim_clip_path = await getTrimmedClip(clip_path, vodId);
  if (!trim_clip_path) {
    console.error("failed to get trimmed clip");
    return null;
  }
  const end_video_path = await getEndVideo(vodPath, vodId, end);
  if (!end_video_path) {
    console.error("failed to get end video");
    return null;
  }
  const list = await getTextList(
    vodId,
    start_video_path,
    trim_clip_path,
    end_video_path,
    vodPath
  );
  if (!list) {
    console.error("failed to get text list");
    return null;
  }
  const returnPath = await concat(vodId, list);
  if (!returnPath) {
    console.error("failed to concat");
    return null;
  }
  fs.unlinkSync(start_video_path);
  fs.unlinkSync(trim_clip_path);
  fs.unlinkSync(end_video_path);
  fs.unlinkSync(list);
  fs.unlinkSync(clip_path);
  return returnPath;
};

const getTextList = async (
  vodId,
  start_video_path,
  trim_clip_path,
  end_video_path,
  vodPath
) => {
  const textPath = `${path.dirname(vodPath)}/${vodId}-list.txt`;
  await writeFile(
    textPath,
    `file '${start_video_path}'\nfile '${trim_clip_path}'\nfile '${end_video_path}'`
  ).catch((e) => {
    console.error(e);
  });
  return textPath;
};

const concat = async (vodId, list) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(list);
    ffmpeg_process
      .inputOptions(["-f concat", "-safe 0"])
      .videoCodec("copy")
      .audioCodec("copy")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `CONCAT PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${path.dirname(list)}/${vodId}-trimmed.mp4`);
      })
      .saveToFile(`${path.dirname(list)}/${vodId}-trimmed.mp4`);
  })
    .then((result) => {
      returnPath = result;
      console.info("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return returnPath;
};

const getStartVideo = async (vodPath, vodId, start) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .duration(start)
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `GET START VIDEO PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${path.dirname(vodPath)}/${vodId}-start.mp4`);
      })
      .saveToFile(`${path.dirname(vodPath)}/${vodId}-start.mp4`);
  })
    .then((result) => {
      returnPath = result;
      console.info("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return returnPath;
};

const getClip = async (vodPath, vodId, start, duration) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .seekOutput(start)
      .duration(duration)
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `GET CLIP PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${path.dirname(vodPath)}/${vodId}-clip.mp4`);
      })
      .saveToFile(`${path.dirname(vodPath)}/${vodId}-clip.mp4`);
  })
    .then((result) => {
      returnPath = result;
      console.info("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return returnPath;
};

const getTrimmedClip = async (clipPath, vodId) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(clipPath);
    ffmpeg_process
      .audioCodec("copy")
      .videoFilter("geq=0:128:128")
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `GET TRIMMED CLIP PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${path.dirname(clipPath)}/${vodId}-clip-muted.mp4`);
      })
      .saveToFile(`${path.dirname(clipPath)}/${vodId}-clip-muted.mp4`);
  })
    .then((result) => {
      returnPath = result;
      console.info("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return returnPath;
};

const getEndVideo = async (vodPath, vodId, end) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .seekOutput(end)
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `GET END VIDEO PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${path.dirname(vodPath)}/${vodId}-end.mp4`);
      })
      .saveToFile(`${path.dirname(vodPath)}/${vodId}-end.mp4`);
  })
    .then((result) => {
      returnPath = result;
      console.info("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return returnPath;
};

module.exports = function (app) {
  const _this = this;
  return async function (req, res, next) {
    if (!req.body.receivedClaims)
      return res.status(400).json({ error: true, msg: "No claims" });

    if (!req.body.vodId)
      return res.status(400).json({ error: true, msg: "No vod id" });

    if (!req.body.type)
      return res.status(400).json({ error: true, msg: "No type" });

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
      msg: `Muting the DMCA content for ${vodId}...`,
    });

    const vodPath = await drive.download(req.body.vodId, req.body.type, app);

    if (!vodPath)
      return console.error(
        `Could not find a download source for ${req.body.vodId}`
      );

    console.info(`Finished download: ${vodId}`);

    let muteSection = [],
      newVodPath,
      blackoutPath;
    for (let dmca of req.body.receivedClaims) {
      const policyType = dmca.claimPolicy.primaryPolicy.policyType;
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
          blackoutPath = await _this.blackoutVideo(
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
          blackoutPath = await _this.blackoutVideo(
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
      newVodPath = await _this.mute(
        blackoutPath ? blackoutPath : vodPath,
        muteSection,
        vodId
      );
      if (!newVodPath) return console.error("failed to mute video");
    }

    vod.upload(vodId, app, newVodPath, req.body.type);
  };
};

module.exports.part = function (app) {
  const _this = this;
  return async function (req, res, next) {
    if (!req.body.receivedClaims)
      return res.status(400).json({ error: true, msg: "No claims" });

    if (!req.body.vodId)
      return res.status(400).json({ error: true, msg: "No vod id" });

    if (!req.body.part)
      return res.status(400).json({ error: true, msg: "No part" });

    if (!req.body.type)
      return res.status(400).json({ error: true, msg: "No type" });

    res.status(200).json({
      error: false,
      msg: `Trimming DMCA Content from ${req.body.vodId} Vod Part ${req.body.part}`,
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

    const driveVideo = await drive.download(req.body.vodId, req.body.type, app);
    if (!driveVideo)
      return console.error(
        `Could not find a download source for ${req.body.vodId}`
      );

    const trimmedPath = await _this.trim(
      driveVideo,
      req.body.vodId,
      config.youtube.splitDuration * (parseInt(req.body.part) - 1),
      config.youtube.splitDuration
    );

    console.info("Finished download..");

    fs.unlinkSync(driveVideo);

    let muteSection = [],
      newVodPath,
      blackoutPath;
    for (let dmca of req.body.receivedClaims) {
      const policyType = dmca.claimPolicy.primaryPolicy.policyType;
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
              blackoutPath ? blackoutPath : trimmedPath
            }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
          );
          blackoutPath = await _this.blackoutVideo(
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
          blackoutPath = await _this.blackoutVideo(
            blackoutPath ? blackoutPath : trimmedPath,
            req.body.vodId,
            dmca.matchDetails.longestMatchStartTimeSeconds,
            dmca.matchDetails.longestMatchDurationSeconds,
            parseInt(dmca.matchDetails.longestMatchStartTimeSeconds) +
              parseInt(dmca.matchDetails.longestMatchDurationSeconds)
          );
        }
      }
    }

    if (muteSection.length > 0) {
      console.info(
        `Trying to mute ${blackoutPath ? blackoutPath : trimmedPath}`
      );
      newVodPath = await _this.mute(
        blackoutPath ? blackoutPath : trimmedPath,
        muteSection,
        req.body.vodId
      );
      if (!newVodPath) return console.error("failed to mute video");

      fs.unlinkSync(trimmedPath);
    }

    if (!newVodPath && !blackoutPath)
      return console.error(
        "nothing to mute or blackout. don't try to upload.."
      );

    await youtube.upload(
      {
        path: newVodPath ? newVodPath : blackoutPath,
        title:
          req.body.type === "vod"
            ? `${config.channel} ${vod_data.date} Vod Part ${req.body.part}`
            : `${config.channel} ${vod_data.date} Live Vod Part ${req.body.part}`,
        public:
          config.youtube.multiTrack && req.body.type === "live"
            ? true
            : !config.youtube.multiTrack && req.body.type === "vod"
            ? true
            : false,
        vod: vod_data,
        part: req.body.part,
        type: req.body.type,
      },
      app
    );

    if (blackoutPath) fs.unlinkSync(blackoutPath);
  };
};
