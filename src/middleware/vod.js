const twitch = require("./twitch");
const config = require("../../config/config.json");
const moment = require("moment");

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
  if (stream.length > 0) {
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
    this.saveChapters(vodId, app)
    console.info(`Saved all comments in DB for vod ${vodId}`);
  }
};

module.exports.startDownload = async (vodId, app) => {
  console.log(`Start Logs download: ${vodId}`);
  downloadLogs(vodId, app);
};

module.exports.saveChapters = async (vodId, app, duration = -1) => {
  const chapters = await twitch.getChapters(vodId);
  if (!chapters)
    return console.error("Failed to save chapters: Chapters is null");

  let newChapters = [];
  if (chapters.length === 0) {
    const chapter = await twitch.getChapter(vodId);
    newChapters.push({
      gameId: chapter.game.id,
      name: chapter.game.displayName,
      duration: "00:00:00",
      start: 0,
      end: duration,
    });
  } else {
    for (let chapter of chapters) {
      newChapters.push({
        gameId: chapter.node.details.game.id,
        name: chapter.node.details.game.displayName,
        image: chapter.node.details.game.boxArtURL,
        duration: moment
          .utc(chapter.node.positionMilliseconds)
          .format("HH:mm:ss"),
        start:
          chapter.node.positionMilliseconds === 0
            ? chapter.node.positionMilliseconds / 1000
            : chapter.node.positionMilliseconds / 1000 - 120, //2mins prior bc streamers are dumb when setting game?
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
