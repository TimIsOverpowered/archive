const config = require("../../config/config.json");
const fs = require("fs");
const { google } = require("googleapis");
const moment = require("moment");
const readline = require("readline");

module.exports.chapters = function (app) {
  const _this = this;
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "Missing vod id.." });

    if (!req.body.type)
      return res
        .status(400)
        .json({ error: true, message: "Missing type param..." });

    _this.saveChapters(req.body.vodId, app, req.body.type);

    res
      .status(200)
      .json({ error: false, message: `Saving chapters for ${req.body.vodId}` });
  };
};

module.exports.saveChapters = async (vodId, app, type = "vod") => {
  const oauth2Client = app.get("ytOauth2Client");
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  await youtube.search.list({
    auth: oauth2Client,
    part: "id,snippet",
    q: "Check if token is valid",
  });
  await sleep(5000);

  let vod_data;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod_data = data;
    })
    .catch(() => {});

  if (!vod_data)
    return console.error(`Could not save chapters: Can't find vod ${vodId}..`);

  if (!vod_data.chapters)
    return console.error(
      `Could not save chapters: Can't find chapters for vod ${vodId}..`
    );

  console.log(`Saving chapters on youtube for ${vodId}`);

  const type_youtube_data = vod_data.youtube.filter(
    (data) => data.type === type
  );
  for (let youtube_data of type_youtube_data) {
    const video_data = await this.getVideo(youtube_data.id, oauth2Client);
    if (!video_data)
      return console.error(
        `Could not save chapters: Can't find ${youtube_data.id} youtube video..`
      );
    const snippet = video_data.snippet;

    let description = (snippet.description += "\n\n");
    for (let chapter of vod_data.chapters) {
      const startDuration =
        config.youtube.splitDuration * (youtube_data.part - 1);
      const endDuration = config.youtube.splitDuration * youtube_data.part;

      if (
        chapter.start <= endDuration &&
        chapter.start + chapter.end >= startDuration
      ) {
        const actualTime = chapter.start - startDuration;
        const timestamp = actualTime < 0 ? 0 : actualTime;
        description += `${moment.utc(timestamp * 1000).format("HH:mm:ss")} ${
          chapter.name
        }\n`;
      }

      const res = await youtube.videos.update({
        resource: {
          id: youtube_data.id,
          snippet: {
            title: snippet.title,
            description: description,
            categoryId: snippet.categoryId,
          },
        },
        part: "snippet",
      });
    }
  }
};

module.exports.parts = function (app) {
  const _this = this;
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "Missing vod id.." });

    if (!req.body.type)
      return res
        .status(400)
        .json({ error: true, message: "Missing Type param..." });

    _this.saveParts(req.body.vodId, app, req.body.type);

    res
      .status(200)
      .json({ error: false, message: `Saving Parts for ${req.body.vodId}` });
  };
};

module.exports.saveParts = async (vodId, app, type = "vod") => {
  const oauth2Client = app.get("ytOauth2Client");
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  let vod_data;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod_data = data;
    })
    .catch(() => {});

  if (!vod_data)
    return console.error(`Could not save parts: Can't find vod ${vodId}..`);

  if (vod_data.youtube.length <= 1)
    return console.error(
      `Could not save parts: (No or only one) youtube video for ${vodId}`
    );

  console.log(`Saving parts on youtube for ${vodId}`);

  const type_youtube_data = vod_data.youtube.filter(function (data) {
    return data.type === type;
  });
  for (let youtube_data of type_youtube_data) {
    const video_data = await this.getVideo(youtube_data.id, oauth2Client);
    const snippet = video_data.snippet;

    let description = ``;
    for (let i = 0; i < type_youtube_data.length; i++) {
      if (youtube_data.id === type_youtube_data[i].id) continue;
      description += `PART ${i + 1}: https://youtube.com/watch?v=${
        type_youtube_data[i].id
      }\n`;
    }
    description += "\n" + snippet.description;

    const res = await youtube.videos.update({
      resource: {
        id: youtube_data.id,
        snippet: {
          title: snippet.title,
          description: description,
          categoryId: snippet.categoryId,
        },
      },
      part: "snippet",
    });

    //console.info(res.data);
  }
};

module.exports.getVideo = async (id, oauth2Client) => {
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  const response = await youtube.videos.list({
    part: "contentDetails,snippet",
    id: [id],
  });

  const item = response.data.items[0];
  if (!item) return null;

  return item;
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

module.exports.upload = async (data, app, isVod = true) => {
  const oauth2Client = app.get("ytOauth2Client");
  const youtube = google.youtube("v3");

  await youtube.search.list({
    auth: oauth2Client,
    part: "id,snippet",
    q: "Check if token is valid",
  });
  await sleep(5000);

  return new Promise(async (resolve, reject) => {
    const fileSize = fs.statSync(data.path).size;
    const vodTitle = data.vod.title.replace(/>|</gi, "");
    const description =
      `VOD TITLE: ${vodTitle}\nChat Replay: https://${config.domain_name}/youtube/${data.vod.id}\n` +
      config.youtube.description;
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
            privacyStatus: data.public ? "public" : "unlisted",
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
    if ((process.env.NODE_ENV || "").trim() !== "production") {
      console.info("\n\n");
    }

    console.info(
      isVod
        ? `Uploaded ${data.vod.id} ${data.part} ${data.type} to youtube!`
        : `Uploaded ${data.title} to youtube!`
    );

    if (isVod) {
      let vod_youtube;
      await app
        .service("vods")
        .get(data.vod.id)
        .then((newData) => {
          vod_youtube = newData.youtube;
        })
        .catch((e) => {
          console.error(e);
        });

      if (!vod_youtube) return console.error("Could not find youtube data...");

      let videoIndex;
      for (let i = 0; i < vod_youtube.length; i++) {
        const youtube_data = vod_youtube[i];
        if (data.type !== youtube_data.type) continue;
        if (data.part === parseInt(youtube_data.part)) {
          videoIndex = i;
          break;
        }
      }

      if (videoIndex == undefined) {
        vod_youtube.push({
          id: res.data.id,
          type: data.type,
          duration: data.duration,
          part: data.part,
          thumbnail_url: res.data.snippet.thumbnails.medium.url,
        });
      } else {
        vod_youtube[videoIndex] = {
          id: res.data.id,
          type: data.type,
          duration: data.duration,
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
          console.info(
            `Saved youtube data in DB for vod ${data.vod.id} ${data.type}`
          );
        })
        .catch((e) => {
          console.error(e);
        });
    } else {
      await app
        .service("games")
        .create({
          vodId: data.vod.id,
          start_time: data.start_time,
          end_time: data.end_time,
          video_provider: "youtube",
          video_id: res.data.id,
          thumbnail_url: res.data.snippet.thumbnails.medium.url,
          game_id: data.chapter.gameId,
          game_name: data.chapter.name,
        })
        .then(() => {
          console.info(
            `Created ${data.chapter.name} in games DB for ${data.vod.id}`
          );
        })
        .catch((e) => {
          console.error(e);
        });
    }

    fs.unlinkSync(data.path);
    resolve();
  });
};
