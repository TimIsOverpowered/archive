const axios = require("axios");
const HLS = require("hls-parser");
const config = require("../../config/config.json");
const ffmpeg = require("./ffmpeg");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const duration = require("dayjs/plugin/duration");
dayjs.extend(duration);
dayjs.extend(utc);
const readline = require("readline");

module.exports.initialize = async (app, username) => {
  const page = app.get("puppeteer");
  await page.goto(`https://kick.com/api/v2/channels/${username}/livestream`);
  await sleep(10000);
  await page.content();
  console.info("Puppeteer: Initialized!");
  return;
};

module.exports.getChannel = async (app, username) => {
  const page = app.get("pupppeter");
  await page.goto(`https://kick.com/api/v2/channels/${username}`);
  await page.content();
  const jsonContent = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector("body").innerText);
    } catch {
      console.error("Kick: Failed to parse json");
      return undefined;
    }
  });

  return jsonContent;
};

module.exports.getStream = async (app, username) => {
  const page = app.get("puppeteer");
  await page.goto(`https://kick.com/api/v2/channels/${username}/livestream`);
  await page.content();
  const jsonContent = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector("body").innerText);
    } catch {
      console.error("Kick: Failed to parse json");
      return undefined;
    }
  });

  return jsonContent;
};

module.exports.getVods = async (app, username) => {
  const page = app.get("puppeteer");
  await page.goto(`https://kick.com/api/v2/channels/${username}/videos`);
  await page.content();
  const jsonContent = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector("body").innerText);
    } catch {
      console.error("Kick: Failed to parse json");
      return undefined;
    }
  });

  return jsonContent;
};

module.exports.getVod = async (app, username, vodId) => {
  const page = app.get("puppeteer");
  await page.goto(`https://kick.com/api/v2/channels/${username}/videos`);
  await page.content();
  const jsonContent = await page.evaluate(() => {
    return JSON.parse(document.querySelector("body").innerText);
  });

  const vod = jsonContent.find(
    (livestream) => livestream.id.toString() === vodId
  );

  return vod;
};

module.exports.download = async (app, username, vodId) => {
  const vod = await this.getVod(app, username, vodId);
  if (!vod) return null;

  let m3u8 = await this.getM3u8(vod.source);
  if (!m3u8) return null;

  const baseURL = vod.source.replace("/master.m3u8", "");
  m3u8 = this.getParsedM3u8(m3u8, baseURL);
  if (!m3u8) return null;

  const vodPath = `${config.vodPath}/${vodId}.mp4`;

  const success = await ffmpeg
    .mp4Download(m3u8, vodPath)
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

module.exports.getM3u8 = async (source) => {
  const data = await axios
    .get(source)
    .then((response) => response.data)
    .catch((e) => {
      console.error(e.response ? e.response.data : e);
      return null;
    });
  return data;
};

module.exports.getParsedM3u8 = (m3u8, baseURL) => {
  let parsedM3u8;
  try {
    parsedM3u8 = HLS.parse(m3u8);
  } catch (e) {
    console.error(e);
  }
  return parsedM3u8 ? `${baseURL}/${parsedM3u8.variants[0].uri}` : null;
};

const fetchComments = async (app, start_time) => {
  const page = app.get("puppeteer");
  await page.goto(
    `https://kick.com/api/v2/channels/${config.kick.id}/messages?start_time=${start_time}`
  );
  await page.content();
  const jsonContent = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector("body").innerText);
    } catch {
      console.error("Kick: Failed to parse json");
      return undefined;
    }
  });
  await page.close();

  return jsonContent;
};

module.exports.downloadLogs = async (vodId, app, vod_start_date, duration) => {
  console.info(`Saving kick logs for ${vodId}`);
  let start_time = new Date();
  let comments = [];
  let howMany = 1;
  let cursor = vod_start_date;

  const page = app.get("puppeteer");
  do {
    let response = await fetchComments(page, cursor);
    if (!response.data) {
      console.info(`No comments for vod ${vodId}`);
      return;
    }

    let responseComments = response.data.messages;
    const lastComment = responseComments[responseComments.length - 1];
    cursor = lastComment.created_at;
    let currentDuration = dayjs(lastComment.created_at).diff(
      dayjs.utc(vod_start_date),
      "second"
    );
    if ((process.env.NODE_ENV || "").trim() !== "production") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0, null);
      process.stdout.write(
        `Current Log position: ${dayjs
          .duration(currentDuration, "s")
          .format("HH:mm:ss")}`
      );
    }
    if (currentDuration >= duration / 1000) break;

    for (let comment of responseComments) {
      if (await commentExists(comment.id, app)) continue;
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

      const commenter = comment.sender;
      comments.push({
        id: comment.id,
        vod_id: vodId,
        display_name: commenter.username,
        content_offset_seconds: dayjs(comment.created_at).diff(
          dayjs(vod_start_date),
          "second"
        ),
        message: comment.content,
        user_badges: commenter.identity.badges,
        user_color: commenter.identity.color,
        createdAt: comment.created_at,
      });
    }
    howMany++;
    await sleep(25);
  } while (true);

  await app
    .service("logs")
    .create(comments)
    .then(() => {
      console.info(`Saved all kick comments in DB for vod ${vodId}`);
    })
    .catch(() => {});

  console.info(
    `\nTotal API Calls: ${howMany} | Total Time to get logs for ${vodId}: ${
      (new Date() - start_time) / 1000
    } seconds`
  );
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

const getChapterInfo = async (app, chapter) => {
  const page = app.get("puppeteer");
  await page.goto(`https://kick.com/api/v1/subcategories/${chapter}`);
  await page.content();
  const jsonContent = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector("body").innerText);
    } catch {
      console.error("Kick: Failed to parse json");
      return undefined;
    }
  });

  return jsonContent;
};

module.exports.saveChapters = async (stream, app) => {
  const chapters = await app
    .service("vods")
    .get(stream.id.toString())
    .then((vod) => vod.chapters)
    .catch(() => null);

  if (!chapters) return;

  const currentChapter = stream.category;
  const lastChapter = chapters[chapters.length - 1];
  const currentTime = dayjs.duration(dayjs.utc().diff(stream.created_at));
  if (lastChapter && lastChapter.id === currentChapter.id) {
    //Same chapter still, only save end time.
    lastChapter.end = currentTime.asSeconds();
  } else {
    //New chapter
    const chapterInfo = await getChapterInfo(app, currentChapter.slug);
    chapters.push({
      gameId: chapterInfo.id,
      name: chapterInfo.name,
      image: chapterInfo.banner.src,
      duration: currentTime.format("HH:mm:ss"),
      start: chapters.length === 0 ? 0 : currentTime.asSeconds(),
    });

    //Update end to last chapter when new chapter is found.
    if (lastChapter) lastChapter.end = currentTime.asSeconds() - 1;
  }

  await app
    .service("vods")
    .patch(vodId, {
      chapters: chapters,
    })
    .catch((e) => {
      console.error(e);
    });
};
