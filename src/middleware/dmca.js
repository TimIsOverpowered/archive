const config = require("../../config/config.json");
const ffmpeg = require("fluent-ffmpeg");
const drive = require("./drive");
const youtube = require("./youtube");
const vod = require("./vod");
const kick = require("./kick");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const mute = async (vodPath, muteSection, vodId) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const filePath = path.normalize(
      `${path.dirname(vodPath)}/${vodId}-muted.mp4`
    );
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
        resolve(filePath);
      })
      .saveToFile(filePath);
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

const blackoutVideo = async (vodPath, vodId, start, duration, end) => {
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
  const textPath = path.normalize(`${path.dirname(vodPath)}/${vodId}-list.txt`);
  fs.writeFileSync(
    textPath,
    `file '${start_video_path}'\nfile '${trim_clip_path}'\nfile '${end_video_path}'`
  );
  return textPath;
};

const concat = async (vodId, list) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const filePath = path.normalize(
      `${path.dirname(list)}/${vodId}-trimmed.mp4`
    );
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
        resolve(filePath);
      })
      .saveToFile(filePath);
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
    const filePath = path.normalize(
      `${path.dirname(vodPath)}/${vodId}-start.mp4`
    );
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
        resolve(filePath);
      })
      .saveToFile(filePath);
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
    const filePath = path.normalize(
      `${path.dirname(vodPath)}/${vodId}-clip.mp4`
    );
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
        resolve(filePath);
      })
      .saveToFile(filePath);
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
    const filePath = path.normalize(
      `${path.dirname(clipPath)}/${vodId}-clip-muted.mp4`
    );
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
        resolve(filePath);
      })
      .saveToFile(filePath);
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
    const filePath = path.normalize(
      `${path.dirname(vodPath)}/${vodId}-end.mp4`
    );
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
        resolve(filePath);
      })
      .saveToFile(filePath);
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
  return async function (req, res, next) {
    const { vodId, type, receivedClaims, platform } = req.body;

    if (!receivedClaims)
      return res.status(400).json({ error: true, msg: "No claims" });
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!type) return res.status(400).json({ error: true, msg: "No type" });
    if (!platform)
      return res.status(400).json({ error: true, msg: "No platform" });

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

    let videoPath =
      type === "live"
        ? `${config.livePath}/${config.twitch.username}/${vod_data.stream_id}.mp4`
        : `${config.vodPath}/${vodId}.mp4`;

    if (!(await fileExists(videoPath))) {
      if (config.drive.upload) {
        videoPath = await drive.download(vodId, type, app);
      } else if (type === "vod") {
        if (platform === "twitch") {
          vodPath = await vod.mp4Download(vodId);
        } else if (platform === "kick") {
          vodPath = await kick.download(vodId);
        }
      } else {
        videoPath = null;
      }
    }

    if (!videoPath)
      return console.error(`Could not find a download source for ${vodId}`);

    let muteSection = [],
      newVodPath,
      blackoutPath;
    for (let dmca of receivedClaims) {
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
              blackoutPath ? blackoutPath : videoPath
            }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
          );
          blackoutPath = await blackoutVideo(
            blackoutPath ? blackoutPath : videoPath,
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
              blackoutPath ? blackoutPath : videoPath
            }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
          );
          blackoutPath = await blackoutVideo(
            blackoutPath ? blackoutPath : videoPath,
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
      console.info(`Trying to mute ${blackoutPath ? blackoutPath : videoPath}`);
      newVodPath = await mute(
        blackoutPath ? blackoutPath : videoPath,
        muteSection,
        vodId
      );
      if (!newVodPath) return console.error("failed to mute video");
    }

    vod.upload(vodId, app, newVodPath, type, platform);
  };
};

module.exports.part = function (app) {
  return async function (req, res, next) {
    const { vodId, part, type, receivedClaims } = req.body;

    if (!receivedClaims)
      return res.status(400).json({ error: true, msg: "No claims" });
    if (!vodId) return res.status(400).json({ error: true, msg: "No vod id" });
    if (!part) return res.status(400).json({ error: true, msg: "No part" });
    if (!type) return res.status(400).json({ error: true, msg: "No type" });

    res.status(200).json({
      error: false,
      msg: `Trimming DMCA Content from ${vodId} Vod Part ${part}`,
    });

    let vod_data;
    await app
      .service("vods")
      .get(vodId)
      .then((data) => {
        vod_data = data;
      })
      .catch(() => {});

    if (!vod_data) return console.error("Failed get vod: no VOD in database");

    let videoPath =
      type === "live"
        ? `${config.livePath}/${config.twitch.username}/${vod_data.stream_id}.mp4`
        : `${config.vodPath}/${vodId}.mp4`;

    if (!(await fileExists(videoPath))) {
      if (config.drive.upload) {
        videoPath = await drive.download(vodId, type, app);
      } else if (type === "vod") {
        videoPath = await vod.mp4Download(vodId);
      } else {
        videoPath = null;
      }
    }

    if (!videoPath)
      return console.error(`Could not find a download source for ${vodId}`);

    const trimmedPath = await vod.trim(
      videoPath,
      vodId,
      config.youtube.splitDuration * (parseInt(part) - 1),
      config.youtube.splitDuration
    );

    if (!trimmedPath)
      return console.error(`Failed Trim for ${vodId} Part ${part}`);

    console.info("Finished Trim..");

    let muteSection = [],
      newVodPath,
      blackoutPath;
    for (let dmca of receivedClaims) {
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
          blackoutPath = await blackoutVideo(
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
              blackoutPath ? blackoutPath : trimmedPath
            }. Claim: ${JSON.stringify(dmca.asset.metadata)}`
          );
          blackoutPath = await blackoutVideo(
            blackoutPath ? blackoutPath : trimmedPath,
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
      console.info(
        `Trying to mute ${blackoutPath ? blackoutPath : trimmedPath}`
      );
      newVodPath = await mute(
        blackoutPath ? blackoutPath : trimmedPath,
        muteSection,
        vodId
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
          type === "vod"
            ? `${config.channel} VOD - ${dayjs(vod_data.createdAt)
                .tz(config.timezone)
                .format("MMMM DD YYYY")
                .toUpperCase()} Part ${part}`
            : `${config.channel} Live VOD - ${dayjs(vod_data.createdAt)
                .tz(config.timezone)
                .format("MMMM DD YYYY")
                .toUpperCase()} Part ${part}`,
        public:
          config.youtube.multiTrack && type === "live"
            ? true
            : !config.youtube.multiTrack && type === "vod"
            ? true
            : false,
        vod: vod_data,
        part: part,
        type: type,
      },
      app
    );

    if (blackoutPath) fs.unlinkSync(blackoutPath);
  };
};

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};
