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
const fs = require("fs");
const vodFunc = require("./vod");
const drive = require("./drive");
const youtube = require("./youtube");
const emotes = require("./emotes");
const initCycleTLS = require("cycletls");

module.exports.getChannel = async (app, username) => {
  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

  await page
    .goto(`https://kick.com/api/v2/channels/${username}`, {
      waitUntil: "domcontentloaded",
    })
    .catch((err) => {
      console.error(err);
      return undefined;
    });
  await sleep(10000);
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

module.exports.getStream = async (app, username) => {
  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

  await page
    .goto(`https://kick.com/api/v2/channels/${username}/livestream`, {
      waitUntil: "domcontentloaded",
    })
    .catch((err) => {
      console.error(err);
      return undefined;
    });
  await sleep(10000);
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

module.exports.getVods = async (app, username) => {
  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

  await page
    .goto(`https://kick.com/api/v2/channels/${username}/videos`, {
      waitUntil: "domcontentloaded",
    })
    .catch((err) => {
      console.error(err);
      return undefined;
    });
  await sleep(10000);
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

module.exports.getVod = async (app, username, vodId) => {
  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

  await page
    .goto(`https://kick.com/api/v2/channels/${username}/videos`, {
      waitUntil: "domcontentloaded",
    })
    .catch((err) => {
      console.error(err);
      return undefined;
    });
  await sleep(10000);
  await page.content();
  const jsonContent = await page.evaluate(() => {
    try {
      return JSON.parse(document.querySelector("body").innerText);
    } catch {
      console.error("Kick: Failed to parse json");
      return undefined;
    }
  });

  if (!jsonContent) return null;

  const vod = jsonContent.find(
    (livestream) => livestream.id.toString() === vodId
  );

  await page.close();

  return vod;
};

module.exports.downloadMP4 = async (app, username, vodId) => {
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
  const cycleTLS = await initCycleTLS();
  const response = await cycleTLS(
    source,
    {
      ja3: "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0",
      userAgent:
        "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:87.0) Gecko/20100101 Firefox/87.0",
      responseType: "text",
    },
    "get"
  );

  // Parse response as JSON
  const data = await response.text();

  await cycleTLS.exit();
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
  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

  await page
    .goto(
      `https://kick.com/api/v2/channels/${config.kick.id}/messages?start_time=${start_time}`,
      { waitUntil: "domcontentloaded" }
    )
    .catch((err) => {
      console.error(err);
      return undefined;
    });
  await sleep(10000);
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

  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

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

  emotes.save(vodId, app);
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
  const browser = app.get("puppeteer");
  if (!browser) return;
  const page = await browser.newPage();

  await page
    .goto(`https://kick.com/api/v1/subcategories/${chapter}`, {
      waitUntil: "domcontentloaded",
    })
    .catch((err) => {
      console.error(err);
      return undefined;
    });
  await sleep(10000);
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
  if (lastChapter && lastChapter.gameId === currentChapter.id) {
    //Same chapter still, only save end time.
    lastChapter.end = Math.round(currentTime.asSeconds() - lastChapter.start);
  } else {
    //New chapter
    const chapterInfo = await getChapterInfo(app, currentChapter.slug);
    chapters.push({
      gameId: chapterInfo.id,
      name: chapterInfo.name,
      image: chapterInfo.banner.src,
      duration:
        chapters.length === 0
          ? "00:00:00"
          : dayjs
              .duration(currentTime.asSeconds() - lastChapter.start, "s")
              .format("HH:mm:ss"),
      start: chapters.length === 0 ? 0 : Math.round(currentTime.asSeconds()),
    });

    //Update end to last chapter when new chapter is found.
    if (lastChapter)
      lastChapter.end = Math.round(currentTime.asSeconds() - lastChapter.start);
  }

  await app
    .service("vods")
    .patch(stream.id.toString(), {
      chapters: chapters,
    })
    .catch((e) => {
      console.error(e);
    });
};

module.exports.downloadHLS = async (
  vodId,
  app,
  source,
  retry = 0,
  delay = 1
) => {
  if ((process.env.NODE_ENV || "").trim() !== "production")
    console.info(`${vodId} Download Retry: ${retry}`);
  const dir = `${config.vodPath}/${vodId}`;
  const m3u8Path = `${dir}/${vodId}.m3u8`;
  const stream = await this.getStream(app, config.kick.username);
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
    duration = await ffmpeg.getDuration(m3u8Path);
    await saveDuration(vodId, duration, app);
    if (stream && stream.data) await this.saveChapters(stream.data, app);
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
        await vodFunc.liveUploadPart(
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

  if (retry >= 10) {
    app.set(`${config.channel}-${vodId}-vod-downloading`, false);

    const mp4Path = `${config.vodPath}/${vodId}.mp4`;
    await vodFunc.convertToMp4(m3u8Path, vodId, mp4Path);
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
      await vodFunc.liveUploadPart(
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
      await vodFunc.upload(vodId, app, mp4Path);
      if (!config.saveMP4) await fs.promises.rm(mp4Path);
    }
    if (!config.saveHLS)
      await fs.promises.rm(dir, {
        recursive: true,
      });
    return;
  }

  //Make variant work with 1080p playlist
  let baseURL;
  if (source.includes("master.m3u8")) {
    baseURL = `${source.substring(0, source.lastIndexOf("/"))}/1080p60`;
  } else {
    baseURL = `${source.substring(0, source.lastIndexOf("/"))}`;
  }

  let m3u8 = await this.getM3u8(`${baseURL}/playlist.m3u8`);
  if (!m3u8) {
    setTimeout(() => {
      this.downloadHLS(vodId, app, source, retry, delay);
    }, 1000 * 60 * delay);
    return console.error(`failed to get m3u8 for ${vodId}`);
  }

  m3u8 = HLS.parse(m3u8);

  if (!(await fileExists(m3u8Path))) {
    if (!(await fileExists(dir))) {
      fs.mkdirSync(dir);
    }
    await downloadTSFiles(m3u8, dir, baseURL, vodId);

    setTimeout(() => {
      this.downloadHLS(vodId, app, source, retry, delay);
    }, 1000 * 60 * delay);
    return;
  }

  let videoM3u8 = await fs.promises.readFile(m3u8Path, "utf8").catch((e) => {
    console.error(e);
    return null;
  });

  if (!videoM3u8) {
    setTimeout(() => {
      this.downloadHLS(vodId, app, source, retry, delay);
    }, 1000 * 60 * delay);
    return;
  }

  videoM3u8 = HLS.parse(videoM3u8);

  //retry if last segment is the same as on file m3u8 and if the actual segment exists.
  if (
    m3u8.segments[m3u8.segments.length - 1].uri ===
      videoM3u8.segments[videoM3u8.segments.length - 1].uri &&
    (await fileExists(`${dir}/${m3u8.segments[m3u8.segments.length - 1].uri}`))
  ) {
    retry++;
    setTimeout(() => {
      this.downloadHLS(vodId, app, source, retry, delay);
    }, 1000 * 60 * delay);
    return;
  }

  //reset retry if downloading new ts files.
  retry = 1;
  await downloadTSFiles(m3u8, dir, baseURL, vodId);

  setTimeout(() => {
    this.downloadHLS(vodId, app, source, retry, delay);
  }, 1000 * 60 * delay);
};

const saveDuration = async (vodId, duration, app) => {
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

const downloadTSFiles = async (m3u8, dir, baseURL, vodId) => {
  const cycleTLS = await initCycleTLS();
  try {
    fs.writeFileSync(`${dir}/${vodId}.m3u8`, HLS.stringify(m3u8));
  } catch (err) {
    console.error(err);
  }
  for (let segment of m3u8.segments) {
    if (await fileExists(`${dir}/${segment.uri}`)) continue;
    await cycleTLS(
      `${baseURL}/${segment.uri}`,
      {
        ja3: "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0",
        userAgent:
          "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:87.0) Gecko/20100101 Firefox/87.0",
        responseType: "stream",
      },
      "get"
    )
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
  await cycleTLS.exit();
};

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
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
