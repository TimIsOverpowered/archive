const ffmpeg = require("fluent-ffmpeg");
const twitch = require("./twitch");
const kick = require("./kick");
const config = require("../../config/config.json");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const HLS = require("hls-parser");
const axios = require("axios");
const drive = require("./drive");
const youtube = require("./youtube");
const emotes = require("./emotes");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const duration = require("dayjs/plugin/duration");
dayjs.extend(duration);
dayjs.extend(utc);
dayjs.extend(timezone);

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

  if (!vod) {
    console.error("Failed to download video: no VOD in database");
    return;
  }

  let vodPath;

  if (manualPath) {
    vodPath = manualPath;
  } else if (type === "vod") {
    if (vod.platform === "twitch") {
      vodPath = await this.mp4Download(vodId);
    } else if (vod.platform === "kick") {
      vodPath = await kick.downloadMP4(app, config.kick.username, vodId);
    }
  }

  if (!vodPath && config.drive.enabled) {
    vodPath = await drive.download(vodId, type, app);
  }

  if (!vodPath) {
    console.error(`Could not find a download source for ${vodId}`);
    return;
  }

  if (config.youtube.perGameUpload && vod.chapters) {
    for (let chapter of vod.chapters) {
      if (chapter.end < 60 * 5) continue;
      if (config.youtube.restrictedGames.includes(chapter.name)) continue;

      console.info(
        `Trimming ${chapter.name} from ${vod.id} ${dayjs(vod.createdAt).format(
          "MM/DD/YYYY"
        )}`
      );
      const trimmedPath = await this.trim(
        vodPath,
        vodId,
        chapter.start,
        chapter.end
      );

      if (!trimmedPath) {
        console.error("Trim failed");
        return;
      }

      if (chapter.end > config.youtube.splitDuration) {
        const duration = await getDuration(trimmedPath);
        let paths = await this.splitVideo(trimmedPath, duration, vodId);
        if (!paths) {
          console.error(
            "Something went wrong trying to split the trimmed video"
          );
          return;
        }

        for (let i = 0; i < paths.length; i++) {
          let totalGames, gameTitle, ytTitle;

          await app
            .service("games")
            .find({
              query: {
                game_name: chapter.name,
                $limit: 0,
              },
            })
            .then((response) => {
              totalGames = response.total;
            })
            .catch((e) => {
              console.error(e);
            });

          if (totalGames !== undefined) {
            ytTitle = `${config.channel} plays ${chapter.name} EP ${
              totalGames + 1
            } - ${dayjs(vod.createdAt)
              .tz(config.timezone)
              .format("MMMM DD YYYY")
              .toUpperCase()}`;
            gameTitle = `${chapter.name} EP ${totalGames + 1}`;
          } else {
            ytTitle = `${config.channel} plays ${chapter.name} - ${dayjs(
              vod.createdAt
            )
              .tz(config.timezone)
              .format("MMMM DD YYYY")
              .toUpperCase()} PART ${i + 1}`;
            gameTitle = `${chapter.name} PART ${i + 1}`;
          }

          await youtube.upload(
            {
              path: paths[i],
              title: ytTitle,
              gameTitle: gameTitle,
              type: "vod",
              public: true,
              duration: await getDuration(paths[i]),
              chapter: chapter,
              start_time: chapter.start + config.youtube.splitDuration * i,
              end_time:
                chapter.start + config.youtube.splitDuration * (i + 1) >
                chapter.end
                  ? chapter.end
                  : chapter.start + config.youtube.splitDuration * (i + 1),
              vod: vod,
            },
            app,
            false
          );
          fs.unlinkSync(paths[i]);
        }
      } else {
        let totalGames;
        await app
          .service("games")
          .find({
            query: {
              game_name: chapter.name,
              $limit: 0,
            },
          })
          .then((response) => {
            totalGames = response.total;
          })
          .catch((e) => {
            console.error(e);
          });

        let gameTitle, ytTitle;
        if (totalGames !== undefined) {
          ytTitle = `${config.channel} plays ${chapter.name} EP ${
            totalGames + 1
          } - ${dayjs(vod.createdAt)
            .tz(config.timezone)
            .format("MMMM DD YYYY")
            .toUpperCase()}`;
          gameTitle = `${chapter.name} EP ${totalGames + 1}`;
        } else {
          ytTitle = `${config.channel} plays ${chapter.name} - ${dayjs(
            vod.createdAt
          )
            .tz(config.timezone)
            .format("MMMM DD YYYY")
            .toUpperCase()}`;
          gameTitle = `${chapter.name}`;
        }

        await youtube.upload(
          {
            path: trimmedPath,
            title: ytTitle,
            gameTitle: gameTitle,
            type: "vod",
            public: true,
            duration: await getDuration(trimmedPath),
            chapter: chapter,
            start_time: chapter.start,
            end_time: chapter.end,
            vod: vod,
          },
          app,
          false
        );
        fs.unlinkSync(trimmedPath);
      }
    }
  }

  if (config.youtube.vodUpload) {
    const duration = await getDuration(vodPath);
    await saveDuration(vodId, duration, app);
    await this.saveChapters(vodId, app, duration);

    if (duration > config.youtube.splitDuration) {
      let paths = await this.splitVideo(vodPath, duration, vodId);

      if (!paths) {
        console.error("Something went wrong trying to split the trimmed video");
        return;
      }

      for (let i = 0; i < paths.length; i++) {
        const data = {
          path: paths[i],
          title:
            type === "vod"
              ? `${config.channel} ${
                  vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
                } VOD - ${dayjs(vod.createdAt)
                  .tz(config.timezone)
                  .format("MMMM DD YYYY")
                  .toUpperCase()} PART ${i + 1}`
              : `${config.channel} ${
                  vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
                }  Live VOD - ${dayjs(vod.createdAt)
                  .tz(config.timezone)
                  .format("MMMM DD YYYY")
                  .toUpperCase()} PART ${i + 1}`,
          type: type,
          public:
            config.youtube.multiTrack &&
            type === "live" &&
            config.youtube.public
              ? true
              : !config.youtube.multiTrack &&
                type === "vod" &&
                config.youtube.public
              ? true
              : false,
          duration: await getDuration(paths[i]),
          vod: vod,
          part: i + 1,
        };
        await youtube.upload(data, app);
        fs.unlinkSync(paths[i]);
      }
      setTimeout(async () => {
        await youtube.saveChapters(vodId, app, type);
        setTimeout(() => youtube.saveParts(vodId, app, type), 30000);
      }, 30000);
      if (config.drive.upload) fs.unlinkSync(vodPath);
      return vodPath;
    }

    const data = {
      path: vodPath,
      title:
        type === "vod"
          ? `${config.channel} ${
              vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
            } VOD - ${dayjs(vod.createdAt)
              .tz(config.timezone)
              .format("MMMM DD YYYY")
              .toUpperCase()}`
          : `${config.channel} ${
              vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
            } Live VOD - ${dayjs(vod.createdAt)
              .tz(config.timezone)
              .format("MMMM DD YYYY")
              .toUpperCase()}`,
      public:
        config.youtube.multiTrack && type === "live" && config.youtube.public
          ? true
          : !config.youtube.multiTrack &&
            type === "vod" &&
            config.youtube.public
          ? true
          : false,
      duration: duration,
      vod: vod,
      type: type,
      part: 1,
    };

    await youtube.upload(data, app);
    setTimeout(async () => {
      await youtube.saveChapters(vodId, app, type);
    }, 30000);
    if (config.drive.upload) fs.unlinkSync(vodPath);
    return vodPath;
  }
};

module.exports.manualVodUpload = async (
  app,
  vodId,
  videoPath,
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

  if (!vod) return console.error("Failed to get vod: no VOD in database");

  const duration = await getDuration(videoPath);

  const data = {
    path: videoPath,
    title:
      type === "vod"
        ? `${config.channel} ${
            vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
          } VOD - ${dayjs(vod.createdAt)
            .tz(config.timezone)
            .format("MMMM DD YYYY")
            .toUpperCase()}`
        : `${config.channel} ${
            vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
          } Live VOD - ${dayjs(vod.createdAt)
            .tz(config.timezone)
            .format("MMMM/DD/YYYY")
            .toUpperCase()}`,
    public:
      config.youtube.multiTrack && type === "live" && config.youtube.public
        ? true
        : !config.youtube.multiTrack && type === "vod" && config.youtube.public
        ? true
        : false,
    duration: duration,
    vod: vod,
    type: type,
    part: 1,
  };

  await youtube.upload(data, app);
  setTimeout(async () => {
    await youtube.saveChapters(vodId, app, type);
  }, 30000);
  if (config.drive.upload) fs.unlinkSync(vodPath);
};

module.exports.manualGameUpload = async (app, vod, game, videoPath) => {
  const { vodId, date, chapter } = game;
  const { name, end, start } = chapter;
  console.info(
    `Trimming ${name} from ${vodId} ${dayjs(date).format("MM/DD/YYYY")}`
  );

  const trimmedPath = await this.trim(videoPath, vodId, start, end);
  if (!trimmedPath) return console.error("Trim failed");

  if (end > config.youtube.splitDuration) {
    let paths = await this.splitVideo(trimmedPath, end, vodId);
    if (!paths)
      return console.error(
        "Something went wrong trying to split the trimmed video"
      );

    for (let i = 0; i < paths.length; i++) {
      await youtube.upload(
        {
          path: paths[i],
          title: `${config.channel} plays ${name} - ${dayjs(date)
            .tz(config.timezone)
            .format("MMMM DD YYYY")
            .toUpperCase()} PART ${i + 1}`,
          type: "vod",
          public: true,
          duration: await getDuration(paths[i]),
          chapter: chapter,
          start_time: start + config.youtube.splitDuration * i,
          end_time:
            start + config.youtube.splitDuration * (i + 1) > end
              ? end
              : start + config.youtube.splitDuration * (i + 1),
          vod: vod,
          gameId: (game.gameId ? game.gameId + i : null ),
        },
        app,
        false
      );
      fs.unlinkSync(paths[i]);
    }
  } else {
    await youtube.upload(
      {
        path: trimmedPath,
        title: game.gameId ? game.title : `${config.channel} plays ${name} - ${dayjs(date)
          .tz(config.timezone)
          .format("MMMM DD YYYY")
          .toUpperCase()}`,
        type: "vod",
        public: true,
        duration: await getDuration(trimmedPath),
        chapter: chapter,
        start_time: start,
        end_time: end,
        vod: vod,
        gameId: game.gameId,
      },
      app,
      false
    );
    fs.unlinkSync(trimmedPath);
  }
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
    `Trimming ${vod.id} ${dayjs(vod.createdAt).format(
      "MM/DD/YYYY"
    )} | Start time: ${start} | Duration: ${end}`
  );
  let trimmedPath = await this.trimHLS(m3u8Path, vodId, start, end);

  if (!trimmedPath) return console.error("Trim failed");

  const data = {
    path: trimmedPath,
    title:
      type === "vod"
        ? `${config.channel} ${
            vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
          } VOD - ${dayjs(vod.createdAt)
            .tz(config.timezone)
            .format("MMMM DD YYYY")
            .toUpperCase()} PART ${part}`
        : `${config.channel} ${
            vod.platform.charAt(0).toUpperCase() + vod.platform.slice(1)
          } Live VOD - ${dayjs(vod.createdAt)
            .tz(config.timezone)
            .format("MMMM DD YYYY")
            .toUpperCase()} PART ${part}`,
    public:
      config.youtube.multiTrack && type === "live" && config.youtube.public
        ? true
        : !config.youtube.multiTrack && type === "vod" && config.youtube.public
        ? true
        : false,
    duration: await getDuration(trimmedPath),
    vod: vod,
    type: type,
    part: part,
  };

  await youtube.upload(data, app);
  setTimeout(async () => {
    await youtube.saveChapters(vodId, app, type);
  }, 30000);
  if (config.drive.upload) fs.unlinkSync(trimmedPath);
};

module.exports.splitVideo = async (vodPath, duration, vodId) => {
  console.info(`Trying to split ${vodPath} with duration ${duration}`);
  const paths = [];
  for (let start = 0; start < duration; start += config.youtube.splitDuration) {
    await new Promise((resolve, reject) => {
      let cut = duration - start;
      if (cut > config.youtube.splitDuration)
        cut = config.youtube.splitDuration;
      const pathName = `${path.dirname(vodPath)}/${start}-${
        cut + start
      }-${vodId}.mp4`;
      const ffmpeg_process = ffmpeg(vodPath);
      ffmpeg_process
        .videoCodec("copy")
        .audioCodec("copy")
        .outputOptions([`-ss ${start}`, "-copyts", `-t ${cut}`])
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
          if ((process.env.NODE_ENV || "").trim() !== "production") {
            console.info(cmd);
          }
          console.info(
            `Splitting ${vodPath}. ${start} - ${
              cut + start
            } with a duration of ${duration}`
          );
        })
        .on("error", function (err) {
          ffmpeg_process.kill("SIGKILL");
          reject(err);
        })
        .on("end", function () {
          resolve(pathName);
        })
        .saveToFile(pathName);
    })
      .then((argPath) => {
        paths.push(argPath);
        console.info("\n");
      })
      .catch((e) => {
        console.error("\nffmpeg error occurred: " + e);
      });
  }
  return paths;
};

module.exports.trim = async (vodPath, vodId, start, end) => {
  let returnPath;
  await new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(vodPath);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions([`-ss ${start}`, "-copyts", `-t ${end}`])
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
        resolve(`${path.dirname(vodPath)}/${vodId}-${start}-${end}.mp4`);
      })
      .saveToFile(`${path.dirname(vodPath)}/${vodId}-${start}-${end}.mp4`);
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

module.exports.trimHLS = async (vodPath, vodId, start, end) => {
  let returnPath;
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
        resolve(`${path.dirname(vodPath)}/${vodId}-${start}-${end}.mp4`);
      })
      .saveToFile(`${path.dirname(vodPath)}/${vodId}-${start}-${end}.mp4`);
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

const commentExists = async (id, app) => {
  const exists = await app
    .service("logs")
    .get(id)
    .then(() => true)
    .catch(() => false);
  return exists;
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

module.exports.downloadLogs = async (vodId, app, cursor = null, retry = 1) => {
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
          offset = parseFloat(data[data.length - 1].content_offset_seconds);
      })
      .catch((e) => {
        console.error(e);
      });
    response = await twitch.fetchComments(vodId, offset);
    if (!response?.comments) {
      console.info(`No comments for vod ${vodId} at offset ${offset}`);
      app.set(`${config.channel}-${vodId}-chat-downloading`, false);
      return;
    }
    let responseComments = response.comments.edges;

    for (let comment of responseComments) {
      cursor = comment.cursor;
      let node = comment.node;
      if (await commentExists(node.id, app)) continue;
      const commenter = node.commenter;
      const message = node.message;
      comments.push({
        id: node.id,
        vod_id: vodId,
        display_name: commenter ? commenter.displayName : null,
        content_offset_seconds: node.contentOffsetSeconds,
        message: message.fragments,
        user_badges: message.userBadges,
        user_color: message.userColor,
        createdAt: node.createdAt,
      });
    }
  }

  while (cursor) {
    lastCursor = cursor;
    response = await twitch.fetchNextComments(vodId, cursor);
    if (!response?.comments) {
      console.info(
        `No more comments left due to vod ${vodId} being deleted or errored out..`
      );
      break;
    }

    responseComments = response.comments.edges;

    if ((process.env.NODE_ENV || "").trim() !== "production") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0, null);
      process.stdout.write(
        `Current Log position: ${dayjs
          .duration(responseComments[0].node.contentOffsetSeconds, "s")
          .format("HH:mm:ss")}`
      );
    }

    for (let comment of responseComments) {
      cursor = comment.cursor;
      let node = comment.node;
      if (await commentExists(node.id, app)) continue;
      const commenter = node.commenter;
      const message = node.message;

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
        id: node.id,
        vod_id: vodId,
        display_name: commenter ? commenter.displayName : null,
        content_offset_seconds: node.contentOffsetSeconds,
        message: message.fragments,
        user_badges: message.userBadges,
        user_color: message.userColor,
        createdAt: node.createdAt,
      });
    }

    await sleep(150); //don't bombarade the api
  }

  if (comments.length > 0) {
    await app
      .service("logs")
      .create(comments)
      .then(() => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          console.info(
            `Finished current log position: ${
              responseComments[responseComments.length - 1].node
                .contentOffsetSeconds * 1000
            }`
          );
        }
      })
      .catch((e) => {
        console.error(e);
      });
  }

  //if live, continue fetching logs.
  const stream = await twitch.getStream(config.twitch.id);

  if (stream && stream[0]) {
    setTimeout(() => {
      this.downloadLogs(vodId, app, lastCursor);
    }, 1000 * 60 * 1);
    //retry for next 10 mins if not live anymore to catch remaining logs.
  } else if (retry < 10) {
    retry++;
    setTimeout(() => {
      this.downloadLogs(vodId, app, lastCursor, retry);
    }, 1000 * 60 * 1);
  } else {
    console.info(`Saved all comments in DB for vod ${vodId}`);
    app.set(`${config.channel}-${vodId}-chat-downloading`, false);
    emotes.save(vodId, app);
  }
};

//RETRY PARAM: Just to make sure whole vod is processed bc it takes awhile for twitch to update the vod even after a stream ends.
//VOD TS FILES SEEMS TO UPDATE AROUND 5 MINUTES. DELAY IS TO CHECK EVERY X MIN.
module.exports.download = async (
  vodId,
  app,
  retry = 0,
  delay = 1,
  liveDownload = false
) => {
  if ((process.env.NODE_ENV || "").trim() !== "production")
    console.info(`${vodId} Download Retry: ${retry}`);
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
    if (newVodData) await this.saveChapters(vodId, app, duration);
  }

  if (
    duration >= config.youtube.splitDuration &&
    config.youtube.liveUpload &&
    config.youtube.upload
  ) {
    const noOfParts = Math.floor(duration / config.youtube.splitDuration);

    const vod_youtube_data = vod.youtube.filter((data) => {
      return data.type === "vod";
    });
    if (vod_youtube_data.length < noOfParts) {
      for (let i = 0; i < noOfParts; i++) {
        if (vod_youtube_data[i]) continue;
        await this.liveUploadPart(
          app,
          vodId,
          m3u8Path,
          config.youtube.splitDuration * i,
          config.youtube.splitDuration,
          i + 1
        );
      }
    }
  }

  if ((!newVodData && m3u8Exists) || retry >= 10) {
    app.set(`${config.channel}-${vodId}-vod-downloading`, false);

    const mp4Path = `${config.vodPath}/${vodId}.mp4`;
    await this.convertToMp4(m3u8Path, vodId, mp4Path);
    if (config.drive.upload) await drive.upload(vodId, mp4Path, app);
    if (config.youtube.liveUpload && config.youtube.upload) {
      //upload last part
      let startTime = 0;

      const vod_youtube_data = vod.youtube.filter(
        (data) => data.type === "vod"
      );
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
      //save parts at last upload.
      setTimeout(() => youtube.saveParts(vodId, app, "vod"), 60000);
    } else if (config.youtube.upload) {
      await this.upload(vodId, app, mp4Path);
      if (!config.saveMP4) await fs.promises.rm(mp4Path);
    }
    if (!config.saveHLS)
      await fs.promises.rm(dir, {
        recursive: true,
      });
    return;
  }

  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig) {
    setTimeout(() => {
      this.download(vodId, app, retry, delay, liveDownload);
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
      this.download(vodId, app, retry, delay, liveDownload);
    }, 1000 * 60 * delay);
    return console.error("failed to get m3u8");
  }

  let parsedM3u8 = twitch.getParsedM3u8(newVideoM3u8);
  if (!parsedM3u8) {
    setTimeout(() => {
      this.download(vodId, app, retry, delay, liveDownload);
    }, 1000 * 60 * delay);
    console.error(newVideoM3u8);
    return console.error("failed to parse m3u8");
  }

  const baseURL = parsedM3u8.substring(0, parsedM3u8.lastIndexOf("/"));

  let variantM3u8 = await twitch.getVariantM3u8(parsedM3u8);
  if (!variantM3u8) {
    setTimeout(() => {
      this.download(vodId, app, retry, delay, liveDownload);
    }, 1000 * 60 * delay);
    return console.error("failed to get variant m3u8");
  }

  //Save duration
  duration = await hlsGetDuration(variantM3u8);
  await saveDuration(vodId, duration, app);

  variantM3u8 = HLS.parse(variantM3u8);
  if (liveDownload) variantM3u8 = checkForUnmutedTS(variantM3u8);

  if (!(await fileExists(m3u8Path))) {
    if (!(await fileExists(dir))) {
      fs.mkdirSync(dir);
    }
    await downloadTSFiles(variantM3u8, dir, baseURL, vodId);

    setTimeout(() => {
      this.download(vodId, app, retry, delay, liveDownload);
    }, 1000 * 60 * delay);
    return;
  }

  let videoM3u8 = await fs.promises.readFile(m3u8Path, "utf8").catch((e) => {
    console.error(e);
    return null;
  });

  if (!videoM3u8) {
    setTimeout(() => {
      this.download(vodId, app, retry, delay, liveDownload);
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
      this.download(vodId, app, retry, delay, liveDownload);
    }, 1000 * 60 * delay);
    return;
  }

  //reset retry if downloading new ts files.
  retry = 1;
  await downloadTSFiles(variantM3u8, dir, baseURL, vodId);

  setTimeout(() => {
    this.download(vodId, app, retry, delay, liveDownload);
  }, 1000 * 60 * delay);
};

const checkForUnmutedTS = (m3u8) => {
  for (let i = 0; i < m3u8.segments.length; i++) {
    const segment = m3u8.segments[i];
    if (segment.uri.includes("-muted")) {
      m3u8.segments[i].uri = `${segment.uri.substring(
        0,
        segment.uri.indexOf("-muted")
      )}.ts`;
      continue;
    }
    if (segment.uri.includes("-unmuted")) {
      m3u8.segments[i].uri = `${segment.uri.substring(
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
      .outputOptions(["-bsf:a aac_adtstoasc"])
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

//EXT-X-TWITCH-TOTAL-SECS use this to get total duration from m3u8
const hlsGetDuration = async (m3u8) => {
  let totalSeconds;
  for (let line of m3u8.split("\n")) {
    if (!line.startsWith("#EXT-X-TWITCH-TOTAL-SECS:")) continue;
    const split = line.split(":");
    if (split[1]) totalSeconds = parseInt(split[1]);
    break;
  }
  return totalSeconds;
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
  return Math.round(duration);
};

const saveDuration = async (vodId, duration, app) => {
  if (isNaN(duration)) return;
  duration = toHHMMSS(duration);

  await app
    .service("vods")
    .patch(vodId, {
      duration: duration,
    })
    .catch((e) => {
      console.error(e);
    });
};

const toHHMMSS = (secs) => {
  var sec_num = parseInt(secs, 10);
  var hours = Math.floor(sec_num / 3600);
  var minutes = Math.floor(sec_num / 60) % 60;
  var seconds = sec_num % 60;

  return [hours, minutes, seconds]
    .map((v) => (v < 10 ? "0" + v : v))
    .filter((v, i) => v !== "00" || i > 0)
    .join(":");
};

module.exports.saveChapters = async (vodId, app, duration) => {
  const chapters = await twitch.getChapters(vodId);
  if (!chapters)
    return console.error("Failed to save chapters: Chapters is null");

  let newChapters = [];
  if (chapters.length === 0) {
    const chapter = await twitch.getChapter(vodId);
    if (!chapter) return null;
    const gameData = chapter.game
      ? await twitch.getGameData(chapter.game.id)
      : null;
    newChapters.push({
      gameId: chapter.game ? chapter.game.id : null,
      name: chapter.game ? chapter.game.displayName : null,
      image: gameData
        ? gameData.box_art_url.replace("{width}x{height}", "40x53")
        : null,
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
        duration: dayjs
          .duration(chapter.node.positionMilliseconds, "ms")
          .format("HH:mm:ss"),
        start:
          chapter.node.positionMilliseconds === 0
            ? chapter.node.positionMilliseconds / 1000
            : chapter.node.positionMilliseconds / 1000,
        end:
          chapter.node.durationMilliseconds === 0
            ? duration - chapter.node.positionMilliseconds / 1000
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

module.exports.getLogs = async (vodId, app) => {
  console.info(`Saving logs for ${vodId}`);
  let start_time = new Date();
  let comments = [];
  let cursor;
  let response = await twitch.fetchComments(vodId);
  if (!response?.comments) {
    console.info(`No comments for vod ${vodId}`);
    return;
  }
  let responseComments = response.comments.edges;

  for (let comment of responseComments) {
    cursor = comment.cursor;
    let node = comment.node;
    if (await commentExists(node.id, app)) continue;
    const commenter = node.commenter;
    const message = node.message;
    comments.push({
      id: node.id,
      vod_id: vodId,
      display_name: commenter ? commenter.displayName : null,
      content_offset_seconds: node.contentOffsetSeconds,
      message: message.fragments,
      user_badges: message.userBadges,
      user_color: message.userColor,
      createdAt: node.createdAt,
    });
  }

  let howMany = 1;
  while (cursor) {
    response = await twitch.fetchNextComments(vodId, cursor);
    if (!response?.comments) {
      console.info(
        `No more comments left due to vod ${vodId} being deleted or errored out..`
      );
      break;
    }

    responseComments = response.comments.edges;

    if ((process.env.NODE_ENV || "").trim() !== "production") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0, null);
      process.stdout.write(
        `Current Log position: ${dayjs
          .duration(responseComments[0].node.contentOffsetSeconds, "s")
          .format("HH:mm:ss")}`
      );
    }

    for (let comment of responseComments) {
      cursor = comment.cursor;
      let node = comment.node;
      if (await commentExists(node.id, app)) continue;
      const commenter = node.commenter;
      const message = node.message;

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
        id: node.id,
        vod_id: vodId,
        display_name: commenter ? commenter.displayName : null,
        content_offset_seconds: node.contentOffsetSeconds,
        message: message.fragments,
        user_badges: message.userBadges,
        user_color: message.userColor,
        createdAt: node.createdAt,
      });
    }

    await sleep(150); //don't bombarade the api

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
  await fs.promises
    .readFile(commentsPath)
    .then((data) => {
      responseComments = JSON.parse(data).comments.edges;
    })
    .catch((e) => {
      console.error(e);
    });

  for (let comment of responseComments) {
    let node = comment.node;
    if ((process.env.NODE_ENV || "").trim() !== "production") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0, null);
      process.stdout.write(
        `Current Log position: ${dayjs
          .duration(node.contentOffsetSeconds, "s")
          .format("HH:mm:ss")}`
      );
    }
    if (await commentExists(node.id, app)) continue;

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

    const commenter = node.commenter;
    const message = node.message;

    comments.push({
      id: node.id,
      vod_id: vodId,
      display_name: commenter ? commenter.displayName : null,
      content_offset_seconds: node.contentOffsetSeconds,
      message: message.fragments,
      user_badges: message.userBadges,
      user_color: message.userColor,
      createdAt: node.createdAt,
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

module.exports.mp4Download = async (vodId) => {
  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig) return console.error(`failed to get token/sig for ${vodId}`);

  let m3u8 = await twitch.getM3u8(vodId, tokenSig.value, tokenSig.signature);
  if (!m3u8) return null;

  m3u8 = twitch.getParsedM3u8(m3u8);
  if (!m3u8) return null;

  const vodPath = `${config.vodPath}/${vodId}.mp4`;

  const success = await this.ffmpegMp4Download(m3u8, vodPath)
    .then(() => {
      console.info(`Downloaded ${vodId}.mp4\n`);
      return true;
    })
    .catch((e) => {
      console.error("\nffmpeg error occurred: " + e);
      return false;
    });

  if (success) return vodPath;

  return null;
};

module.exports.ffmpegMp4Download = async (m3u8, path) => {
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
