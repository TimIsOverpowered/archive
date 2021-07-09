const ffmpeg = require("fluent-ffmpeg");
const twitch = require("./twitch");
const config = require("../../config/config.json");
const util = require("util");
const fs = require("fs");
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const readline = require("readline");
const { google } = require("googleapis");
const moment = require("moment");
const momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);
const OAuth2 = google.auth.OAuth2;
const path = require("path");
const HLS = require("hls-parser");
const axios = require("axios");
const oauth2Client = new OAuth2(
  config.google.client_id,
  config.google.client_secret,
  config.google.redirect_url
);
oauth2Client.on("tokens", (tokens) => {
  if (tokens.refresh_token) {
    config.youtube.refresh_token = tokens.refresh_token;
  }
  config.youtube.access_token = tokens.access_token;
  fs.writeFile(
    path.resolve(__dirname, "../../config/config.json"),
    JSON.stringify(config, null, 4),
    (err) => {
      if (err) return console.error(err);
      console.info("Refreshed Youtube Token");
    }
  );
  oauth2Client.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
  });
});
const drive = require("./drive");
const youtube = require("./youtube");

process.on('unhandledRejection', function(reason, p){
  console.log("Possibly Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

module.exports.upload = async (
  vodId,
  app,
  manualPath = false,
  type = "vod"
) => {
  let vod;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod = data;
    })
    .catch(() => {});

  if (!vod)
    return console.error("Failed to download video: no VOD in database");

  let vodPath = manualPath ? manualPath : await drive.download(vodId, type, app);

  if (!vodPath)
    return console.error(`Could not find a download source for ${vodId}`);

  /*
  const resolution = await this.getResolution(vodPath);

  if (!resolution)
    console.error(`Could not find resolution of video... ${vodPath}`);

  if (resolution && resolution.width < 1920 && resolution.height < 1080) {
    console.info(`Original video: ${vodPath} resolution is not normal. ${resolution.width}x${resolution.height}`);
    vodPath = await this.upscale(vodId, vodPath);
  }*/

  if (config.perGameUpload) {
    for (let chapter of vod.chapters) {
      console.info(`Trimming ${chapter.name} from ${vod.id} ${vod.date}`);
      const trimmedPath = await this.trim(
        vodPath,
        vodId,
        chapter.start,
        chapter.end
      );

      if (!trimmedPath) return console.error("Trim failed");

      if (chapter.end > config.splitDuration) {
        let paths = await this.splitVideo(trimmedPath, chapter.end, vodId);
        if (!paths)
          return console.error(
            "Something went wrong trying to split the trimmed video"
          );

        for (let i = 0; i < paths.length; i++) {
          await this.trimUpload(
            paths[i],
            `${config.channel} plays ${chapter.name} ${vod.date} PART ${i + 1}`
          );
        }
      } else {
        await this.trimUpload(
          trimmedPath,
          `${config.channel} plays ${chapter.name} ${vod.date}`
        );
      }
    }
  }

  const duration = await getDuration(vodPath);

  if (duration > config.splitDuration) {
    let paths = await this.splitVideo(vodPath, duration, vodId);

    if (!paths)
      return console.error("Something went wrong trying to split the video");

    for (let i = 0; i < paths.length; i++) {
      const data = {
        path: paths[i],
        title:
          type === "vod"
            ? `${config.channel} ${vod.date} Vod PART ${i + 1}`
            : `${config.channel} ${vod.date} Live Vod PART ${i + 1}`,
        type: type,
        vod: vod,
        part: i + 1,
      };
      await this.uploadVideo(data, app);
    }
    await youtube.saveChapters(vodId, app, type);
    setTimeout(async () => {
      await youtube.saveParts(vodId, app, type);
    }, 30000);
    fs.unlinkSync(vodPath);
    return;
  }

  const data = {
    path: vodPath,
    title:
      type === "vod"
        ? `${config.channel} ${vod.date} Vod`
        : `${config.channel} ${vod.date} Live Vod`,
    vod: vod,
    type: type,
  };

  await this.uploadVideo(data, app);
  await youtube.saveChapters(vodId, app, type);
};

module.exports.liveUploadPart = async (
  app,
  vodId,
  m3u8Path,
  start,
  end,
  part,
  type = "vod"
) => {
  let vod;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod = data;
    })
    .catch(() => {});

  if (!vod)
    return console.error("Failed in liveUploadPart: no VOD in database");

  console.info(
    `Trimming ${vod.id} ${vod.date} | Start time: ${start} | Duration: ${end}`
  );
  let trimmedPath = await this.trimHLS(m3u8Path, vodId, start, end);

  if (!trimmedPath) return console.error("Trim failed");

  /*
  const resolution = await this.getResolution(trimmedPath);

  if (!resolution)
    console.error(`Could not find resolution of video... ${trimmedPath}`);

  if (resolution && resolution.width < 1920 && resolution.height < 1080) {
    console.info(`Original video: ${trimmedPath} resolution is not normal. ${resolution.width}x${resolution.height}`);
    trimmedPath = await this.upscale(vodId, trimmedPath);
  }*/

  await this.trimUpload(
    trimmedPath,
    type === "vod"
      ? `${config.channel} ${vod.date} Vod Part ${part}`
      : `${config.channel} ${vod.date} Live Vod Part ${part}`,
    {
      vod: vod,
      part: part,
      type: type,
    },
    app
  );
};

module.exports.splitVideo = async (vodPath, duration, vodId) => {
  console.log(`Trying to split ${vodPath} with duration ${duration}`);
  const paths = [];
  for (let start = 0; start < duration; start += config.splitDuration) {
    await new Promise((resolve, reject) => {
      let cut = duration - start;
      if (cut > config.splitDuration) {
        cut = config.splitDuration;
      }
      const ffmpeg_process = ffmpeg(vodPath);
      ffmpeg_process
        .seekOutput(start)
        .duration(cut)
        .videoCodec("copy")
        .audioCodec("copy")
        .toFormat("mp4")
        .on("progress", (progress) => {
          if ((process.env.NODE_ENV || "").trim() !== "production") {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0, null);
            process.stdout.write(
              `SPLIT VIDEO PROGRESS: ${Math.round(progress.percent)}%`
            );
          }
        })
        .on("start", (cmd) => {
          console.info(`Splitting ${vodPath}. ${cut + start} / ${duration}`);
        })
        .on("error", function (err) {
          ffmpeg_process.kill("SIGKILL");
          reject(err);
        })
        .on("end", function () {
          resolve(`${config.vodPath}/${start}-${vodId}.mp4`);
        })
        .saveToFile(`${config.vodPath}/${start}-${vodId}.mp4`);
    })
      .then((path) => {
        paths.push(path);
        console.log("\n");
      })
      .catch((e) => {
        console.error("\nffmpeg error occurred: " + e);
      });
  }
  return paths;
};

module.exports.upscale = async (vodId, ogPath) => {
  console.info(`Upscaling video ${ogPath} to 1080p`);
  let path;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(ogPath);
    ffmpeg_process
      .videoCodec("libx264")
      .outputOptions(["-vf scale=1920x1080:flags=lanczos"])
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `UPSCALE VIDEO PROGRESS: ${Math.round(progress.percent)}%`
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
        resolve(`${config.vodPath}/${vodId}-upscaled.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-upscaled.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

module.exports.mute = async (vodPath, muteSection, vodId) => {
  let path;
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
        resolve(`${config.vodPath}/${vodId}-muted.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-muted.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

module.exports.trim = async (vodPath, vodId, start, end) => {
  let path;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .seekOutput(start)
      .videoCodec("copy")
      .audioCodec("copy")
      .duration(end)
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `TRIM VIDEO PROGRESS: ${Math.round(progress.percent)}%`
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
        resolve(`${config.vodPath}/${vodId}-${start}-${end}.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-${start}-${end}.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

module.exports.trimHLS = async (vodPath, vodId, start, end) => {
  let path;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .seekOutput(start)
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions([
        "-bsf:a aac_adtstoasc",
        "-copyts",
        "-start_at_zero",
        `-t ${end}`,
      ])
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `TRIM HLS VIDEO PROGRESS: ${Math.round(progress.percent)}%`
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
        resolve(`${config.vodPath}/${vodId}-${start}-${end}.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-${start}-${end}.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
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
    end_video_path
  );
  if (!list) {
    console.error("failed to get text list");
    return null;
  }
  const path = await concat(vodId, list);
  if (!path) {
    console.error("failed to concat");
    return null;
  }
  fs.unlinkSync(start_video_path);
  fs.unlinkSync(trim_clip_path);
  fs.unlinkSync(end_video_path);
  fs.unlinkSync(list);
  return path;
};

const getTextList = async (
  vodId,
  start_video_path,
  trim_clip_path,
  end_video_path
) => {
  const textPath = `${config.vodPath}/${vodId}-list.txt`;
  await writeFile(
    textPath,
    `file '${start_video_path}'\nfile '${trim_clip_path}'\nfile '${end_video_path}'`
  ).catch((e) => {
    console.error(e);
  });
  return textPath;
};

const concat = async (vodId, list) => {
  let path;
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
        resolve(`${config.vodPath}/${vodId}-trimmed.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-trimmed.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

const getStartVideo = async (vodPath, vodId, start) => {
  let path;
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
        resolve(`${config.vodPath}/${vodId}-start.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-start.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

const getClip = async (vodPath, vodId, start, duration) => {
  let path;
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
        resolve(`${config.vodPath}/${vodId}-clip.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-clip.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

const getTrimmedClip = async (clipPath, vodId) => {
  let path;
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
        resolve(`${config.vodPath}/${vodId}-clip-muted.mp4`);
        fs.unlinkSync(clipPath);
      })
      .saveToFile(`${config.vodPath}/${vodId}-clip-muted.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

const getEndVideo = async (vodPath, vodId, end) => {
  let path;
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
        resolve(`${config.vodPath}/${vodId}-end.mp4`);
      })
      .saveToFile(`${config.vodPath}/${vodId}-end.mp4`);
  })
    .then((result) => {
      path = result;
      console.log("\n");
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
    });
  return path;
};

module.exports.download = async (vodId) => {
  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig) return console.error(`failed to get token/sig for ${vodId}`);

  let m3u8 = await twitch.getM3u8(vodId, tokenSig.value, tokenSig.signature);
  if (!m3u8) return console.error("failed to get m3u8");

  m3u8 = twitch.getParsedM3u8(m3u8);
  if (!m3u8) return console.error("failed to parse m3u8");

  const vodPath = `${config.vodPath}/${vodId}.mp4`;

  await downloadAsMP4(m3u8, vodPath)
    .then(() => {
      console.log("\n");
    })
    .catch((e) => {
      return console.error("\nffmpeg error occurred: " + e);
    });

  return vodPath;
};

const downloadAsMP4 = async (m3u8, path) => {
  return new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(m3u8);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions(["-bsf:a aac_adtstoasc", "-copyts", "-start_at_zero"])
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `DOWNLOAD PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        console.info(`Starting m3u8 download for ${m3u8} in ${path}`);
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve();
      })
      .saveToFile(path);
  });
};

module.exports.uploadVideo = async (data, app) => {
  oauth2Client.credentials = config.youtube;
  const youtube = google.youtube("v3");
  await youtube.search.list({
    auth: oauth2Client,
    part: "id,snippet",
    q: "Check if token is valid",
  });
  console.log(data);
  /* Change once they fix this problem, not being able to update using getTokenInfo?
  await oauth2Client
    .getTokenInfo(config.youtube.access_token)
    .catch(async (e) => {
    });*/
  await new Promise((resolve, reject) => {
    setTimeout(async () => {
      const fileSize = fs.statSync(data.path).size;
      const title = data.vod.title.replace(/>|</ig, '');
      let description =
        `VOD TITLE: ${title}\nChat Replay: https://${
          config.domain_name
        }/${data.type === "live" ? "live" : "vods"}/${data.vod.id}\n` +
        config.youtube_description;
      const res = await youtube.videos.insert(
        {
          auth: oauth2Client,
          part: "id,snippet,status",
          notifySubscribers: true,
          requestBody: {
            snippet: {
              title: data.title,
              description: description,
              categoryId: "20",
            },
            status: {
              privacyStatus: config.youtube_public_vid ? "public" : "unlisted",
            },
          },
          media: {
            body: fs.createReadStream(data.path),
          },
        },
        {
          onUploadProgress: (evt) => {
            if ((process.env.NODE_ENV || "").trim() !== "production") {
              const progress = (evt.bytesRead / fileSize) * 100;
              readline.clearLine(process.stdout, 0);
              readline.cursorTo(process.stdout, 0, null);
              process.stdout.write(`UPLOAD PROGRESS: ${Math.round(progress)}%`);
            }
          },
        }
      );
      console.log("\n\n");
      console.log(res.data);

      let vod_youtube;
      await app.service("vods")
      .get(data.vod.id)
      .then(newData => {
        vod_youtube = newData.youtube;
      })
      .catch(e => {
        console.error(e);
      });

      if(!vod_youtube) 
        return console.error("Could not find youtube data...");

      let videoIndex;
      for (let i = 0; i < youtube.length; i++) {
        const youtube_data = vod_youtube[i];
        if (data.type !== youtube_data.type) continue;
        if (data.part != null) {
          if (data.part === parseInt(youtube_data.part)) {
            videoIndex = i;
            break;
          }
        } else {
          videoIndex = i;
          break;
        }
      }

      if (videoIndex == undefined) {
        vod_youtube.push(
          data.part != null
            ? {
                id: res.data.id,
                type: data.type,
                duration: await getDuration(data.path),
                part: data.part,
                thumbnail_url: res.data.snippet.thumbnails.medium.url,
              }
            : {
                id: res.data.id,
                type: data.type,
                duration: await getDuration(data.path),
                thumbnail_url: res.data.snippet.thumbnails.medium.url,
              }
        );
      } else {
        vod_youtube[videoIndex] =
          data.part != null
            ? {
                id: res.data.id,
                type: data.type,
                duration: await getDuration(data.path),
                part: data.part,
                thumbnail_url: res.data.snippet.thumbnails.medium.url,
              }
            : {
                id: res.data.id,
                type: data.type,
                duration: await getDuration(data.path),
                thumbnail_url: res.data.snippet.thumbnails.medium.url,
              };
      }

      await app
        .service("vods")
        .patch(data.vod.id, {
          youtube: vod_youtube,
          thumbnail_url: res.data.snippet.thumbnails.medium.url,
        })
        .then(() => {
          console.info(`Saved youtube data in DB for vod ${data.vod.id}`);
        })
        .catch((e) => {
          console.error(e);
        });

      fs.unlinkSync(data.path);
      this.addComment(
        res.data.id,
        data.vod.id,
        data.part != null ? data.part : false,
        data.type
      );
      resolve();
    }, 1000);
  });
};

module.exports.trimUpload = async (path, title, data = false, app = null) => {
  oauth2Client.credentials = config.youtube;
  const youtube = google.youtube("v3");
  await youtube.search.list({
    auth: oauth2Client,
    part: "id,snippet",
    q: "Check if token is valid",
  });
  /* Change once they fix this problem, not being able to update using getTokenInfo?
  await oauth2Client
    .getTokenInfo(config.youtube.access_token)
    .catch(async (e) => {
    });*/
  await new Promise((resolve, reject) => {
    setTimeout(async () => {
      const fileSize = fs.statSync(path).size;
      const res = await youtube.videos.insert(
        {
          auth: oauth2Client,
          part: "id,snippet,status",
          notifySubscribers: true,
          requestBody: {
            snippet: {
              title: title,
              description: data
                ? `VOD TITLE: ${data.vod.title}\nChat Replay: https://${
                    config.domain_name
                  }/${data.type === "live" ? "live" : "vods"}/${
                    data.vod.id
                  }\n` + config.youtube_description
                : config.youtube_description,
              categoryId: "20",
            },
            status: {
              privacyStatus: "public",
            },
          },
          media: {
            body: fs.createReadStream(path),
          },
        },
        {
          onUploadProgress: (evt) => {
            if ((process.env.NODE_ENV || "").trim() !== "production") {
              const progress = (evt.bytesRead / fileSize) * 100;
              readline.clearLine(process.stdout, 0);
              readline.cursorTo(process.stdout, 0, null);
              process.stdout.write(`UPLOAD PROGRESS: ${Math.round(progress)}%`);
            }
          },
        }
      );
      console.log("\n\n");
      console.log(res.data);

      if (!data) {
        fs.unlinkSync(path);
        return resolve();
      }

      let vod_youtube;
      await app.service("vods")
      .get(data.vod.id)
      .then(newData => {
        vod_youtube = newData.youtube;
      })
      .catch(e => {
        console.error(e);
      });

      if(!vod_youtube) 
        return console.error("Could not find youtube data...");

      let indexOfPart;
      for (let i = 0; i < youtube.length; i++) {
        const youtube_data = vod_youtube[i];
        if (data.type !== youtube_data.type) continue;
        if (data.part !== parseInt(youtube_data.part)) continue;
        indexOfPart = i;
        break;
      }

      if (indexOfPart == undefined) {
        vod_youtube.push({
          id: res.data.id,
          type: data.type,
          duration: await getDuration(path),
          part: data.part,
          thumbnail_url: res.data.snippet.thumbnails.medium.url,
        });
      } else {
        vod_youtube[indexOfPart] = {
          id: res.data.id,
          type: data.type,
          duration: await getDuration(path),
          part: data.part,
          thumbnail_url: res.data.snippet.thumbnails.medium.url,
        };
      }

      await app
        .service("vods")
        .patch(data.vod.id, {
          youtube: vod_youtube,
          thumbnail_url: res.data.snippet.thumbnails.medium.url,
        })
        .then(() => {
          console.info(`Saved youtube data in DB for vod ${data.vod.id}`);
        })
        .catch((e) => {
          console.error(e);
        });
      this.addComment(res.data.id, data.vod.id, data.part, data.type);

      fs.unlinkSync(path);
      resolve();
    }, 1000);
  });
};

module.exports.addComment = async (videoId, vodId, part = false, type) => {
  const youtube = google.youtube("v3");
  const res = await youtube.commentThreads.insert({
    auth: oauth2Client,
    part: "id,snippet",
    requestBody: {
      snippet: {
        topLevelComment: {
          snippet: {
            textOriginal: part
              ? `${config.domain_name}/${
                  type === "vod" ? "vods" : "live"
                }/${vodId}?part=${part}`
              : `${config.domain_name}/${
                  type === "vod" ? "vods" : "live"
                }/${vodId}`,
            videoId: videoId,
          },
        },
      },
    },
  });
  console.log(res.data);
};

module.exports.getLogs = async (vodId, app) => {
  console.log(`Saving logs for ${vodId}`);
  //check if offline.
  let start_time = new Date();
  let comments = [];
  let response = await twitch.fetchComments(vodId);

  for (let comment of response.comments) {
    if (await commentExists(comment._id, app)) continue;
    comments.push({
      id: comment._id,
      vod_id: vodId,
      display_name: comment.commenter.display_name,
      content_offset_seconds: comment.content_offset_seconds,
      message: comment.message.fragments,
      user_badges: comment.message.user_badges,
      user_color: comment.message.user_color,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
  }

  let cursor = response._next;
  let howMany = 1;
  while (cursor) {
    if ((process.env.NODE_ENV || "").trim() !== "production") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0, null);
      process.stdout.write(
        `Current Log position: ${moment
          .utc(response.comments[0].content_offset_seconds * 1000)
          .format("HH:mm:ss")}`
      );
    }
    response = await twitch.fetchNextComments(vodId, cursor);
    if (!response) {
      console.info(`No more comments left due to vod ${vodId} being deleted..`);
      break;
    }
    for (let comment of response.comments) {
      if (await commentExists(comment._id, app)) continue;
      if (comments.length >= 2500) {
        await app
          .service("logs")
          .create(comments)
          .then(() => {
            if ((process.env.NODE_ENV || "").trim() !== "production") {
              console.info(
                `\nSaved ${comments.length} comments in DB for vod ${vodId}`
              );
            }
          })
          .catch((e) => {
            console.error(e);
          });
        comments = [];
      }
      comments.push({
        id: comment._id,
        vod_id: vodId,
        display_name: comment.commenter.display_name,
        content_offset_seconds: comment.content_offset_seconds,
        message: comment.message.fragments,
        user_badges: comment.message.user_badges,
        user_color: comment.message.user_color,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      });
    }

    cursor = response._next;
    await sleep(50); //don't bombarade the api
    howMany++;
  }
  console.info(
    `\nTotal API Calls: ${howMany} | Total Time to get logs for ${vodId}: ${
      (new Date() - start_time) / 1000
    } seconds`
  );

  await app
    .service("logs")
    .create(comments)
    .then(() => {
      console.info(`Saved all comments in DB for vod ${vodId}`);
    })
    .catch(() => {});
};

module.exports.manualLogs = async (commentsPath, vodId, app) => {
  let start_time = new Date(),
    comments = [],
    responseComments,
    howMany = 1;
  await readFile(commentsPath)
    .then((data) => {
      responseComments = JSON.parse(data).comments;
    })
    .catch((e) => {
      console.error(e);
    });

  for (let comment of responseComments) {
    if ((process.env.NODE_ENV || "").trim() !== "production") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0, null);
      process.stdout.write(
        `Current Log position: ${moment
          .utc(comment.content_offset_seconds * 1000)
          .format("HH:mm:ss")}`
      );
    }
    if (await commentExists(comment._id, app)) continue;
    if (comments.length >= 2500) {
      await app
        .service("logs")
        .create(comments)
        .then(() => {
          if ((process.env.NODE_ENV || "").trim() !== "production") {
            console.info(
              `\nSaved ${comments.length} comments in DB for vod ${vodId}`
            );
          }
        })
        .catch((e) => {
          console.error(e);
        });
      comments = [];
    }
    comments.push({
      id: comment._id,
      vod_id: vodId,
      display_name: comment.commenter.display_name,
      content_offset_seconds: comment.content_offset_seconds,
      message: comment.message.fragments,
      user_badges: comment.message.user_badges,
      user_color: comment.message.user_color,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
    howMany++;
  }
  console.info(
    `\nTotal Comments: ${howMany} | Total Time to get logs for ${vodId}: ${
      (new Date() - start_time) / 1000
    } seconds`
  );

  await app
    .service("logs")
    .create(comments)
    .then(() => {
      console.info(`Saved all comments in DB for vod ${vodId}`);
    })
    .catch(() => {});
};

const commentExists = async (id, app) => {
  let exists;
  await app
    .service("logs")
    .get(id)
    .then((data) => {
      exists = true;
    })
    .catch((e) => {
      exists = false;
    });
  return exists;
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const downloadLogs = async (vodId, app, cursor = null, retry = 1) => {
  let comments = [],
    response,
    lastCursor;

  if (!cursor) {
    let offset = 0;
    await app
      .service("logs")
      .find({
        paginate: false,
        query: {
          vod_id: vodId,
        },
      })
      .then((data) => {
        if (data.length > 0)
          offset = data[data.length - 1].content_offset_seconds;
      })
      .catch((e) => {
        console.error(e);
      });
    response = await twitch.fetchComments(vodId, offset);

    if (!response) return console.error(`No Comments found for ${vodId}`);

    for (let comment of response.comments) {
      if (await commentExists(comment._id, app)) continue;
      comments.push({
        id: comment._id,
        vod_id: vodId,
        display_name: comment.commenter.display_name,
        content_offset_seconds: comment.content_offset_seconds,
        message: comment.message.fragments,
        user_badges: comment.message.user_badges,
        user_color: comment.message.user_color,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      });
    }

    cursor = response._next;
  }

  while (cursor) {
    lastCursor = cursor;
    response = await twitch.fetchNextComments(vodId, cursor);
    if (!response) {
      console.info(`No more comments left due to vod ${vodId} being deleted..`);
      break;
    }
    if ((process.env.NODE_ENV || "").trim() !== "production") {
      console.info(
        `Current Log position: ${moment
          .utc(response.comments[0].content_offset_seconds * 1000)
          .format("HH:mm:ss")}`
      );
    }
    for (let comment of response.comments) {
      const exists = await commentExists(comment._id, app);
      if (exists) continue;
      if (comments.length >= 2500) {
        await app
          .service("logs")
          .create(comments)
          .then(() => {
            if ((process.env.NODE_ENV || "").trim() !== "production") {
              console.info(
                `\nSaved ${comments.length} comments in DB for vod ${vodId}`
              );
            }
          })
          .catch((e) => {
            console.error(e);
          });
        comments = [];
      }
      comments.push({
        id: comment._id,
        vod_id: vodId,
        display_name: comment.commenter.display_name,
        content_offset_seconds: comment.content_offset_seconds,
        message: comment.message.fragments,
        user_badges: comment.message.user_badges,
        user_color: comment.message.user_color,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      });
    }

    cursor = response._next;
    await sleep(50); //don't bombarade the api
  }

  if (comments.length > 0) {
    await app
      .service("logs")
      .create(comments)
      .then(() => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(
            `Finished current log position: ${moment
              .utc(response.comments[0].content_offset_seconds * 1000)
              .format("HH:mm:ss")}`
          );
        }
      })
      .catch((e) => {
        console.error(e);
      });
  }

  //if live, continue fetching logs.
  const stream = await twitch.getStream(config.twitchId);
  if (
    stream &&
    stream.length !== null &&
    stream.length > 0 &&
    stream[0] &&
    stream[0].type === "live"
  ) {
    setTimeout(() => {
      downloadLogs(vodId, app, lastCursor);
    }, 1000 * 60 * 1);
    //retry for next 10 mins if not live anymore to catch remaining logs.
  } else if (retry < 10) {
    retry++;
    setTimeout(() => {
      downloadLogs(vodId, app, lastCursor, retry);
    }, 1000 * 60 * 1);
  } else {
    console.info(`Saved all comments in DB for vod ${vodId}`);
  }
};

module.exports.startDownload = async (vodId, app) => {
  console.log(`Start download: ${vodId}`);
  download(vodId, app);
  console.log(`Start Logs download: ${vodId}`);
  downloadLogs(vodId, app);
};

//RETRY PARAM: Just to make sure whole vod is processed bc it takes awhile for twitch to update the vod even after a stream ends.
//VOD TS FILES SEEMS TO UPDATE AROUND 5 MINUTES. DELAY IS TO CHECK EVERY 1MIN.
const download = async (vodId, app, retry = 0, delay = 1) => {
  const dir = `${config.vodPath}/${vodId}`;
  const m3u8Path = `${dir}/${vodId}.m3u8`;
  const newVodData = await twitch.getVodData(vodId);
  const m3u8Exists = await fileExists(m3u8Path);
  let duration, vod;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod = data;
    })
    .catch(() => {});

  if (!vod)
    return console.error("Failed to download video: no VOD in database");

  if (m3u8Exists) {
    duration = await getDuration(m3u8Path);
    await saveDuration(vodId, duration, app);
    if (newVodData) await this.saveChapters(vodId, app, duration);
  }

  if (duration >= config.splitDuration && config.liveUpload) {
    const noOfParts = Math.floor(duration / config.splitDuration);

    if (vod.youtube.length < noOfParts) {
      for (let i = 0; i < noOfParts; i++) {
        if (vod.youtube[i]) continue;
        await this.liveUploadPart(
          app,
          vodId,
          m3u8Path,
          config.splitDuration * i,
          config.splitDuration,
          i + 1
        );
      }
    }
  }

  if ((!newVodData && m3u8Exists) || retry >= 10) {
    const mp4Path = `${dir}/${vodId}.mp4`;
    await this.convertToMp4(m3u8Path, vodId, mp4Path);
    if (config.drive.upload) await drive.upload(vodId, mp4Path, app);
    if (config.liveUpload) {
      //upload last part
      let startTime = 0;

      if (vod.youtube.length > 0) {
        const vod_youtube_data = vod.youtube.filter(function (data) {
          return data.type === "vod";
        });
        for (let i = 0; i < vod_youtube_data.length; i++) {
          startTime += vod_youtube_data[i].duration;
        }
        await this.liveUploadPart(
          app,
          vodId,
          m3u8Path,
          startTime,
          duration - startTime,
          vod_youtube_data.length + 1
        );
      } else {
        for (let i = 0; i < vod.youtube.length; i++) {
          startTime += vod.youtube[i].duration;
        }
        await this.liveUploadPart(
          app,
          vodId,
          m3u8Path,
          startTime,
          duration - startTime,
          vod.youtube.length + 1
        );
      }
      await youtube.saveChapters(vodId, app, "vod");
      setTimeout(async () => {
        await youtube.saveParts(vodId, app, "vod");
      }, 30000);
      await fs.promises.rmdir(dir, {
        recursive: true,
        force: true,
      });
      return;
    }
    await this.upload(vodId, app, mp4Path);
    await fs.promises.rmdir(dir, {
      recursive: true,
      force: true,
    });
    return;
  }

  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig) {
    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    return console.error(`failed to get token/sig for ${vodId}`);
  }

  let newVideoM3u8 = await twitch.getM3u8(
    vodId,
    tokenSig.value,
    tokenSig.signature
  );
  if (!newVideoM3u8) {
    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    return console.error("failed to get m3u8");
  }

  let parsedM3u8 = twitch.getParsedM3u8(newVideoM3u8);
  if (!parsedM3u8) {
    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    console.error(newVideoM3u8);
    return console.error("failed to parse m3u8");
  }

  const baseURL = parsedM3u8.substring(0, parsedM3u8.lastIndexOf("/"));

  let variantM3u8 = await twitch.getVariantM3u8(parsedM3u8);
  if (!variantM3u8) {
    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    return console.error("failed to get variant m3u8");
  }

  variantM3u8 = HLS.parse(variantM3u8);
  variantM3u8 = checkForUnmutedTS(variantM3u8);

  if (!(await fileExists(m3u8Path))) {
    if (!(await fileExists(dir))) {
      fs.mkdirSync(dir);
    }
    await downloadTSFiles(variantM3u8, dir, baseURL, vodId);

    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    return;
  }

  let videoM3u8;

  await fs.promises
    .readFile(m3u8Path, "utf8")
    .then((data) => (videoM3u8 = data))
    .catch((e) => console.error(e));

  if (!videoM3u8) {
    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    return;
  }

  videoM3u8 = HLS.parse(videoM3u8);

  //retry if last segment is the same as on file m3u8 and if the actual segment exists.
  if (
    variantM3u8.segments[variantM3u8.segments.length - 1].uri ===
      videoM3u8.segments[videoM3u8.segments.length - 1].uri &&
    (await fileExists(
      `${dir}/${variantM3u8.segments[variantM3u8.segments.length - 1].uri}`
    ))
  ) {
    retry++;
    setTimeout(() => {
      download(vodId, app, retry, delay);
    }, 1000 * 60 * delay);
    return;
  }

  //reset retry if downloading new ts files.
  retry = 1;
  await downloadTSFiles(variantM3u8, dir, baseURL, vodId);

  setTimeout(() => {
    download(vodId, app, retry, delay);
  }, 1000 * 60 * delay);
};

const checkForUnmutedTS = (m3u8) => {
  for (let segment of m3u8.segments) {
    if (segment.uri.includes("unmuted")) {
      m3u8.segments[segment] = `${segment.uri.substring(
        0,
        segment.uri.indexOf("-unmuted")
      )}.ts`;
    }
  }
  return m3u8;
};

const downloadTSFiles = async (m3u8, dir, baseURL, vodId) => {
  try {
    fs.writeFileSync(`${dir}/${vodId}.m3u8`, HLS.stringify(m3u8));
  } catch (err) {
    console.error(err);
  }
  for (let segment of m3u8.segments) {
    if (await fileExists(`${dir}/${segment.uri}`)) continue;

    await axios({
      method: "get",
      url: `${baseURL}/${segment.uri}`,
      responseType: "stream",
    })
      .then((response) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(`Downloaded ${segment.uri}`);
        }
        response.data.pipe(fs.createWriteStream(`${dir}/${segment.uri}`));
      })
      .catch((e) => {
        console.error(e);
      });
  }
  if ((process.env.NODE_ENV || "").trim() !== "production") {
    console.info(
      `Done downloading.. Last segment was ${
        m3u8.segments[m3u8.segments.length - 1].uri
      }`
    );
  }
};

module.exports.convertToMp4 = async (m3u8, vodId, mp4Path) => {
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(m3u8);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions(["-bsf:a aac_adtstoasc", "-copyts", "-start_at_zero"])
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `M3U8 CONVERT TO MP4 PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(cmd);
        }
        console.info(`Converting ${vodId} m3u8 to mp4`);
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve();
      })
      .saveToFile(mp4Path);
  });
};

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};

const getDuration = async (video) => {
  let duration;
  await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(video, (err, metadata) => {
      if (err) {
        console.error(err);
        return reject();
      }
      duration = metadata.format.duration;
      resolve();
    });
  });
  return duration;
};

module.exports.getResolution = async (video) => {
  let resolution;
  await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(video, (err, metadata) => {
      if (err) {
        console.error(err);
        return reject();
      }
      for (let stream of metadata.streams) {
        if (stream.codec_type !== "video") continue;
        resolution = {
          width: stream.width,
          height: stream.height,
        };
        break;
      }
      resolve();
    });
  });
  return resolution;
};

const saveDuration = async (vodId, duration, app) => {
  await app
    .service("vods")
    .patch(vodId, {
      duration: moment.duration(duration, "seconds").format("hh:mm:ss"),
    })
    .catch((e) => {
      console.error(e);
    });
};

module.exports.saveChapters = async (vodId, app, duration) => {
  const chapters = await twitch.getChapters(vodId);
  if (!chapters)
    return console.error("Failed to save chapters: Chapters is null");

  let newChapters = [];
  if (chapters.length === 0) {
    const chapter = await twitch.getChapter(vodId);
    const gameData = await twitch.getGameData(chapter.game.id);
    newChapters.push({
      gameId: chapter.game ? chapter.game.id : null,
      name: chapter.game ? chapter.game.displayName : null,
      image: gameData.box_art_url,
      duration: "00:00:00",
      start: 0,
      end: duration,
    });
  } else {
    for (let chapter of chapters) {
      newChapters.push({
        gameId: chapter.node.details.game ? chapter.node.details.game.id : null,
        name: chapter.node.details.game
          ? chapter.node.details.game.displayName
          : null,
        image: chapter.node.details.game
          ? chapter.node.details.game.boxArtURL
          : null,
        duration: moment
          .utc(chapter.node.positionMilliseconds)
          .format("HH:mm:ss"),
        start:
          chapter.node.positionMilliseconds === 0
            ? chapter.node.positionMilliseconds / 1000
            : chapter.node.positionMilliseconds / 1000,
        end:
          chapter.node.durationMilliseconds === 0
            ? duration
            : chapter.node.durationMilliseconds / 1000,
      });
    }
  }

  await app
    .service("vods")
    .patch(vodId, {
      chapters: newChapters,
    })
    .catch((e) => {
      console.error(e);
    });
};
