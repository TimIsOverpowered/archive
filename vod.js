const ffmpeg = require("fluent-ffmpeg");
const twitch = require("./twitch");
const config = require("./config");
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

module.exports.download = async (userId, app) => {
  await twitch.checkToken();
  const latestVodData = await twitch.getLatestVodData(userId);
  if (!latestVodData)
    return console.error("Failed to get latest vod in webhook");

  const vodId = latestVodData.id;

  const tokenSig = await twitch.getVodTokenSig(vodId);
  if (!tokenSig)
    return console.error(
      `failed to get token/sig for ${vodId} under volume collection`
    );

  let m3u8 = await twitch.getM3u8(vodId, tokenSig.token, tokenSig.sig);
  if (!m3u8) return console.error("failed to get m3u8");

  m3u8 = twitch.getParsedM3u8(m3u8);
  if (!m3u8) return console.error("failed to parse m3u8");

  const vodPath = config.vodPath + latestVodData.id + ".mp4";

  await downloadAsMP4(m3u8, vodPath).catch((e) => {
    return console.error("ffmpeg error occurred: " + e);
  });

  await uploadVideo(vodPath, latestVodData, app);
};

const downloadAsMP4 = async (m3u8, path) => {
  return new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(m3u8)
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions(["-bsf:a aac_adtstoasc"])
      .toFormat("mp4")
      .on("progress", (progress) => {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0, null);
        process.stdout.write(`DOWNLOAD PROGRESS: ${Math.round(progress.percent)}%`);
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

const uploadVideo = async (path, vodData, app) => {
  await app.googleClient.getTokenInfo(config.youtube.access_token)
  .catch(async e => {
    //Change once they fix this problem, not being able to update using getTokenInfo?
    const youtube = google.youtube('v3');
    await youtube.search.list({
      auth: app.googleClient,
      part: 'id,snippet',
      q: 'Check if token is valid',
    });
  });

  const fileSize = fs.statSync(path).size;
  const youtube = google.youtube("v3");
  await youtube.videos
    .insert(
      {
        auth: app.googleClient,
        part: "id,snippet,status",
        notifySubscribers: true,
        requestBody: {
          snippet: {
            title: vodData.title,
            description: `Watch Poke live on Twitch! https://twitch.tv/pokelawls\n\nThis vod was on ${new Date(
              vodData.created_at
            ).toLocaleDateString()} \n\nSocial Media \nTwitter - https://twitter.com/pokelawls \nDiscord - https://discord.gg/pokelawls \nInstagram - https://instagram.com/pokelawls \nReddit - https://reddit.com/r/pokelawls \nMain Channel - https://www.youtube.com/c/pokelawls`,
            categoryId: "20",
          },
          status: {
            privacyStatus: "unlisted",
          },
        },
        media: {
          body: fs.createReadStream(path),
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
    })
    .catch((error) => {
      console.log("\n\n");
      console.error(error);
    });
  fs.unlinkSync(path);
};
