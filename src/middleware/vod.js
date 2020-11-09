const ffmpeg = require("fluent-ffmpeg");
const twitch = require("./twitch");
const config = require("../../config/config.json");
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");
const moment = require("moment");

module.exports.download = async (vodId, app) => {
  let vod;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod = data;
    })
    .catch((e) => {
      console.error(e);
    });

  if (!vod)
    return console.error("Failed to download video: no VOD in database");

  const duration = moment.duration(vod.duration).asSeconds();

  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig) return console.error(`failed to get token/sig for ${vodId}`);

  let m3u8 = await twitch.getM3u8(vodId, tokenSig.token, tokenSig.sig);
  if (!m3u8) return console.error("failed to get m3u8");

  m3u8 = twitch.getParsedM3u8(m3u8);
  if (!m3u8) return console.error("failed to parse m3u8");

  let data = [];
  if (duration > 43200) {
    let part = 1;
    for (let start = 0; start < duration; start += 43200) {
      const vodPath = config.vodPath + vodId + `-part${part}.mp4`;
      data.push({
        path: vodPath,
        title: `${vod.title} (${vod.date} VOD) PART ${part}`,
        date: vod.date,
        vodId: vodId,
      });
      let cut = duration - start;
      if (cut > 43200) {
        cut = 43200;
      }
      await downloadAsMP4(m3u8, vodPath, start, cut).catch((e) => {
        return console.error("ffmpeg error occurred: " + e);
      });
      part++;
    }
  } else {
    const vodPath = config.vodPath + vodId + ".mp4";
    data.push({
      path: vodPath,
      title: `${vod.title} (${vod.date} VOD)`,
      date: vod.date,
      chapters: vod.chapters,
      vodId: vodId,
    });
    await downloadAsMP4(m3u8, vodPath).catch((e) => {
      return console.error("ffmpeg error occurred: " + e);
    });
  }
  console.log("\n");
  await uploadVideo(data, app);
};

const downloadAsMP4 = async (m3u8, path, start, duration) => {
  return new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(m3u8);
    if (start) {
      ffmpeg_process.seekInput(start);
      ffmpeg_process.duration(duration);
    }
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions(["-bsf:a aac_adtstoasc"])
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || '').trim() !== 'production') {
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

const uploadVideo = async (datas, app) => {
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
    for (let data of datas) {
      //const fileSize = fs.statSync(data.path).size;
      const youtube = google.youtube("v3");
      let description = config.youtube_description;
      for (let chapter of data.chapters) {
        description += `${chapter.duration} - ${chapter.name} - ${chapter.title}\n`;
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
            if ((process.env.NODE_ENV || '').trim() !== 'production') {
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
          video_url: `youtube.com/watch?v=${res.data.id}`,
          youtube_id: res.data.id,
        })
        .then(() => {
          console.info(`Saved youtube data in DB for vod ${vodId}`);
        })
        .catch((e) => {
          console.error(e);
        });

      fs.unlinkSync(data.path);
    }
  }, 1000);
};

module.exports.getLogs = async (vodId, app) => {
  let start_time = new Date();
  const comments = [];
  let response = await twitch.fetchComments(vodId);
  for (let comment of response.comments) {
    comments.push({
      id: comment._id,
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
        `Current Log position: ${response.comments[0].content_offset_seconds}`
      );
    }
    response = await twitch.fetchNextComments(vodId, cursor);
    for (let comment of response.comments) {
      comments.push({
        id: comment._id,
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
    .service("vods")
    .patch(vodId, {
      logs: comments,
    })
    .then(() => {
      console.info(`Saved logs in DB for vod ${vodId}`);
    })
    .catch((e) => {
      console.error(e);
    });
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
