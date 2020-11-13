const ffmpeg = require("fluent-ffmpeg");
const twitch = require("./twitch");
const config = require("../../config/config.json");
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");
const moment = require("moment");

module.exports.upload = async (vodId, app) => {
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

  const vodPath = await this.download(vodId);

  const duration = moment.duration(vod.duration).asSeconds();

  if (duration > 43200) {
    let paths = await this.splitVideo(vodPath, duration, vodId);

    if (!paths)
      return console.error("Something went wrong trying to split the video");

    for (let i = 0; i < paths.length; i++) {
      let chapters;
      if (vod.chapters) {
        for (let chapter of vod.chapters) {
          const chapterDuration = moment.duration(chapter.duration).asSeconds();
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
        title: `${vod.title} (${vod.date} VOD) PART ${i + 1}`,
        date: vod.date,
        chapters: chapters,
        vodId: vodId,
      };
      await this.uploadVideo(data, app);
    }
    return;
  }

  const data = {
    path: vodPath,
    title: `${vod.title} (${vod.date} VOD)`,
    date: vod.date,
    chapters: vod.chapters,
    vodId: vodId,
  };

  await this.uploadVideo(data, app);
};

module.exports.splitVideo = async (vodPath, duration, vodId) => {
  console.log(`Trying to split ${vodPath} with duration ${duration}`);
  const paths = [];
  for (let start = 0; start < duration; start += 43200) {
    await new Promise((resolve, reject) => {
      let cut = duration - start;
      if (cut > 43200) {
        cut = 43200;
      }
      const ffmpeg_process = ffmpeg(vodPath);
      ffmpeg_process
        .seekInput(start)
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
          //console.info(cmd);
          console.info(`Splitting ${vodPath}. ${cut + start} / ${duration}`);
        })
        .on("error", function (err) {
          ffmpeg_process.kill("SIGKILL");
          reject(err);
        })
        .on("end", function () {
          resolve(`${config.vodPath}${start}-${vodId}.mp4`);
        })
        .saveToFile(`${config.vodPath}${start}-${vodId}.mp4`);
    })
      .then((path) => {
        paths.push(path);
        console.log("\n");
      })
      .catch((e) => {
        console.error("\nffmpeg error occurred: " + e);
      });
  }
  if (paths.length > 0) {
    fs.unlinkSync(vodPath);
  }
  return paths;
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
        console.info(cmd);
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve(`${config.vodPath}${vodId}-muted.mp4`);
      })
      .saveToFile(`${config.vodPath}${vodId}-muted.mp4`);
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

  let m3u8 = await twitch.getM3u8(vodId, tokenSig.token, tokenSig.sig);
  if (!m3u8) return console.error("failed to get m3u8");

  m3u8 = twitch.getParsedM3u8(m3u8);
  if (!m3u8) return console.error("failed to parse m3u8");

  const vodPath = config.vodPath + vodId + ".mp4";

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
      .outputOptions(["-bsf:a aac_adtstoasc"])
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
        //console.info(cmd);
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
  await app.googleClient
    .getTokenInfo(config.youtube.access_token)
    .catch(async (e) => {
      //Change once they fix this problem, not being able to update using getTokenInfo?
      const youtube = google.youtube("v3");
      await youtube.search.list({
        auth: app.googleClient,
        part: "id,snippet",
        q: "Check if token is valid",
      });
    });
  setTimeout(async () => {
    const fileSize = fs.statSync(data.path).size;
    const youtube = google.youtube("v3");
    let description = config.youtube_description;
    if (data.chapters) {
      description += `00:00 "Start of stream"\n`;
      for (let chapter of data.chapters) {
        description += `${chapter.duration} ${chapter.name}\n`;
      }
    }
    const res = await youtube.videos.insert(
      {
        auth: app.googleClient,
        part: "id,snippet,status",
        notifySubscribers: true,
        requestBody: {
          snippet: {
            title: data.title,
            description: description,
            categoryId: "20",
          },
          status: {
            privacyStatus: "public",
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

    await app
      .service("vods")
      .patch(data.vodId, {
        thumbnail_url: res.data.snippet.thumbnails.medium.url,
        video_link: `youtube.com/watch?v=${res.data.id}`,
        youtube_id: res.data.id,
      })
      .then(() => {
        console.info(`Saved youtube data in DB for vod ${data.vodId}`);
      })
      .catch((e) => {
        console.error(e);
      });

    fs.unlinkSync(data.path);
  }, 1000);
};

module.exports.getLogs = async (vodId, app) => {
  let start_time = new Date();
  let comments = [];
  let response = await twitch.fetchComments(vodId);
  for (let comment of response.comments) {
    comments.push({
      id: comment._id,
      vod_id: vodId,
      display_name: comment.commenter.display_name,
      content_offset_seconds: comment.content_offset_seconds,
      message: comment.message.fragments,
      user_badges: comment.message.user_badges,
      user_color: comment.message.user_color,
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
    for (let comment of response.comments) {
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
      });
    }
    cursor = response._next;
    await sleep(100); //don't bombarade the api
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

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
