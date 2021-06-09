const config = require("../../config/config.json");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const moment = require("moment");
const OAuth2 = google.auth.OAuth2;
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

module.exports.getDuration = async (id) => {
  oauth2Client.credentials = config.youtube;
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  const response = await youtube.videos.list({
    part: "contentDetails",
    id: [id],
  });

  const item = response.data.items[0];
  if (!item) return null;

  return moment.duration(item.contentDetails.duration).asSeconds();
};

module.exports.chapters = function (app) {
  const _this = this;
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "Missing vod id.." });

    _this.saveChapters(req.body.vodId, app);

    res
      .status(200)
      .json({ error: false, message: `Saving chapters for ${req.body.vodId}` });
  };
};

module.exports.saveChapters = async (vodId, app) => {
  oauth2Client.credentials = config.youtube;
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
    return console.error(`Could not save chapters: Can't find vod ${vodId}..`);

  if (!vod_data.chapters)
    return console.error(
      `Could not save chapters: Can't find chapters for vod ${vodId}..`
    );

  console.log(`Saving chapters on youtube for ${vodId}`);

  for (let i = 0; i < vod_data.youtube.length; i++) {
    const youtube_data = vod_data.youtube[i];
    const video_data = await this.getVideo(youtube_data.id);
    const snippet = video_data.snippet;
    const duration = moment
      .duration(video_data.contentDetails.duration)
      .asSeconds();

    let description = snippet.description;
    for (let chapter of vod_data.chapters) {
      if (i === 0) {
        if (chapter.end < duration || chapter.start === 0) {
          description += `\n\n${moment
            .utc(chapter.start * 1000)
            .format("HH:mm:ss")} ${chapter.name}\n`;
        }
      } else {
        if (chapter.end < duration * (i + 1) || chapter.start === 0) {
          description += `\n\n${moment
            .utc(chapter.start * 1000)
            .format("HH:mm:ss")} ${chapter.name}\n`;
        }
      }
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

    console.log(res.data);
  }
};

module.exports.parts = function (app) {
  const _this = this;
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "Missing vod id.." });

    _this.saveParts(req.body.vodId, app);

    res
      .status(200)
      .json({ error: false, message: `Saving Parts for ${req.body.vodId}` });
  };
};

module.exports.saveParts = async (vodId, app) => {
  oauth2Client.credentials = config.youtube;
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

  for (let youtube_data of vod_data.youtube) {
    const video_data = await this.getVideo(youtube_data.id);
    const snippet = video_data.snippet;

    let description = ``;
    for (let i = 0; i < vod_data.youtube.length; i++) {
      if (youtube_data.id === vod_data.youtube[i].id) continue;
      description += `PART ${i + 1}: https://youtube.com/watch?v=${
        vod_data.youtube[i].id
      }\n`;
    }
    description += snippet.description;

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

    console.log(res.data);
  }
};

module.exports.getVideo = async (id) => {
  oauth2Client.credentials = config.youtube;
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
