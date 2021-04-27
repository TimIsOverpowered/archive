const crypto = require("crypto");
const config = require("../../config/config.json");
const vod = require("./vod");
const twitch = require("./twitch");
const moment = require("moment");
const momentDurationFormatSetup = require("moment-duration-format");
momentDurationFormatSetup(moment);

process.on("unhandledRejection", function (reason, p) {
  console.log(
    "Possibly Unhandled Rejection at: Promise ",
    p,
    " reason: ",
    reason
  );
  // application specific logging here
});

module.exports.verify = function (app) {
  return async function (req, res, next) {
    if (req.query["hub.challenge"]) {
      console.log(`${req.query["hub.mode"]}: ${req.query["hub.topic"]}`);
      return res.status(200).send(req.query["hub.challenge"]);
    }

    if (req.query["hub.reason"]) {
      console.error(req.query["hub.reason"]);
      return res.status(500);
    }
  };
};

module.exports.stream = function (app) {
  const self = this;
  return async function (req, res, next) {
    res.status(200).send("ok");

    if (!req.headers["x-hub-signature"]) {
      return;
    }

    const secret = req.headers["x-hub-signature"].split("=")[1];

    const hash = crypto
      .createHmac("sha256", config.twitch.webhook_secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (secret != hash) {
      return;
    }

    const userId = req.params.userId;
    if (!userId) return;

    const data = req.body.data;

    await twitch.checkToken();

    if (data.length != 0) {
      //Have to wait a few minutes till the new vod gets populated.
      setTimeout(async () => {
        let vodData = await twitch.getLatestVodData(userId);
        if (!vodData)
          return console.error("Failed to get latest vod in webhook");
        const vodExists = await exists(vodData.id, app);
        //Rare case: In case it was deleted and webhook was fired. Check if latest vod is relatively new.
        if (!vodExists && moment.utc().diff(moment.utc(vodData.created_at), "seconds") <= 3600) {
          console.log(
            `${
              config.channel
            } went online. Creating vod. ${new Date().toLocaleDateString()}`
          );
          await createVod(vodData, app);
          vod.startDownload(vodData.id, app);
        }
      }, 1000 * 60 * 2);
      return;
    }

    let vodData = await twitch.getLatestVodData(userId);
    if (!vodData) return console.error("Failed to get latest vod in webhook");

    console.log(`${config.channel} went offline.`);
    await self.saveChapters(vodData, app);
  };
};

const exists = async (vodId, app) => {
  let exists;
  await app
    .service("vods")
    .get(vodId)
    .then(() => {
      exists = true;
    })
    .catch(() => {
      exists = false;
    });
  return exists;
};

const createVod = async (vodData, app) => {
  await app
    .service("vods")
    .create({
      id: vodData.id,
      title: vodData.title,
      date: new Date(vodData.created_at).toLocaleDateString("en-US", {
        timeZone: config.timezone,
      }),
    })
    .then(() => {
      console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
    })
    .catch((e) => {
      console.error(e);
    });
};

module.exports.saveChapters = async (vodData, app) => {
  if (!vodData)
    return console.error("Failed to save chapters: No vod in database..?");

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
      end: moment.duration(vodData.duration).asSeconds(),
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
        end: chapter.node.durationMilliseconds / 1000,
      });
    }
  }

  await app
    .service("vods")
    .patch(vodId, {
      chapters: newChapters,
    })
    .then(() => {
      console.info(`Saved chapters for ${config.channel} in vod ${vodId}`);
    })
    .catch((e) => {
      console.error(e);
    });
};