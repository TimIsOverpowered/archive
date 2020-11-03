const ffmpeg = require("fluent-ffmpeg");
const twitch = require("./twitch");
const config = require("./config");
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");
const moment = require("moment");

module.exports.download = async (userId, app) => {
  await twitch.checkToken();
  const latestVodData = await twitch.getLatestVodData(userId);
  if (!latestVodData)
    return console.error("Failed to get latest vod in webhook");

  const vodId = latestVodData.id;

  const duration = moment
    .duration("PT" + latestVodData.duration.toUpperCase())
    .asSeconds();

  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig)
    return console.error(
      `failed to get token/sig for ${vodId}`
    );

  let m3u8 = await twitch.getM3u8(vodId, tokenSig.token, tokenSig.sig);
  if (!m3u8) return console.error("failed to get m3u8");

  m3u8 = twitch.getParsedM3u8(m3u8);
  if (!m3u8) return console.error("failed to parse m3u8");

  let data = [];
  if (duration > 43200) {
    let part = 1;
    for (let start = 0; start < duration; start += 43200) {
      const date = new Date(latestVodData.created_at).toLocaleDateString();
      const vodPath = config.vodPath + latestVodData.id + `-part${part}.mp4`;
      data.push({
        path: vodPath,
        title: `${latestVodData.title} (${date} VOD) PART ${part}`,
        date: date,
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
    const date = new Date(latestVodData.created_at).toLocaleDateString();
    const vodPath = config.vodPath + latestVodData.id + ".mp4";
    data.push({
      path: vodPath,
      title: `${latestVodData.title} (${date} VOD)`,
      date: date,
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
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0, null);
        process.stdout.write(
          `DOWNLOAD PROGRESS: ${Math.round(progress.percent)}%`
        );
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
  for (let data of datas) {
    const fileSize = fs.statSync(data.path).size;
    const youtube = google.youtube("v3");
    await youtube.videos
      .insert(
        {
          auth: app.googleClient,
          part: "id,snippet,status",
          notifySubscribers: true,
          requestBody: {
            snippet: {
              title: data.title,
              description: `Watch Poke live on Twitch! https://twitch.tv/pokelawls\n\nThis vod was on ${data.date} \n\nSocial Media \nTwitter - https://twitter.com/pokelawls \nDiscord - https://discord.gg/pokelawls \nInstagram - https://instagram.com/pokelawls \nReddit - https://reddit.com/r/pokelawls \nMain Channel - https://www.youtube.com/c/pokelawls`,
              categoryId: "20",
            },
            status: {
              privacyStatus: "unlisted",
            },
          },
          media: {
            body: fs.createReadStream(data.path),
          },
        },
        {
          onUploadProgress: (evt) => {
            const progress = (evt.bytesRead / fileSize) * 100;
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0, null);
            process.stdout.write(`UPLOAD PROGRESS: ${Math.round(progress)}%`);
          },
        }
      )
      .then((res) => {
        console.log("\n\n");
        console.log(res.data.status);
        fs.unlinkSync(data.path);
      })
      .catch((error) => {
        console.log("\n\n");
        console.error(error);
      });
  }
};
