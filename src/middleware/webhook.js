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
    setTimeout(async () => {
      let vodData = await twitch.getLatestVodData(userId);
      if (!vodData) return console.error("Failed to get latest vod in webhook");

      if (data.length === 0) {
        console.log(`${config.channel} went offline.`);
        let vodDb;
        await app
          .service("vods")
          .find({
            query: {
              $limit: 1,
              $sort: {
                createdAt: -1,
              },
            },
          })
          .then((response) => {
            vodDb = response.data[0];
          })
          .catch((e) => {
            console.error(e);
          });
        if (!vodDb)
          return console.error("Something went wrong trying to get latest vod");

        vodData = await twitch.getVodData(vodDb.id);
        if (!vodData)
          return console.error(
            "Something went wrong trying to get vod data in webhook"
          );
        if (vodDb.youtube_id.length !== 0)
          return console.error("Youtube video already exists. Skipping..");
        if (
          moment.duration("PT" + vodData.duration.toUpperCase()).asSeconds() <
          600
        )
          return;
        await saveDuration(vodData, app);
        vod.upload(vodData.id, app);
        vod.getLogs(vodData.id, app);
        return;
      }

      if (!(await exists(vodData.id, app))) {
        createVod(data[0], vodData, app);
        return;
      }
      saveChapters(data[0], vodData, app);
    }, 300 * 1000);
  };
};

const saveDuration = async (vodData, app) => {
  await app
    .service("vods")
    .patch(vodData.id, {
      duration: moment
        .duration("PT" + vodData.duration.toUpperCase())
        .format("HH:mm:ss", { trim: false }),
    })
    .catch((e) => {
      console.error(e);
    });
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

const createVod = async (data, vodData, app) => {
  const gameData = await twitch.getGameData(data.game_id);
  if (!gameData) return console.error("Failed to get game data");

  const chapters = [
    {
      gameId: gameData.id,
      name: gameData.name,
      image: gameData.box_art_url,
      title: data.title,
      duration: moment
        .duration(
          moment.utc().diff(moment.utc(data.started_at)),
          "milliseconds"
        )
        .format("HH:mm:ss", { trim: false }),
      createdAt: vodData.created_at,
    },
  ];

  await app
    .service("vods")
    .create({
      id: vodData.id,
      title: vodData.title,
      date: new Date(vodData.created_at).toLocaleDateString("en-US", {
        timeZone: config.timezone,
      }),
      chapters: chapters,
    })
    .then(() => {
      console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
    })
    .catch((e) => {
      console.error(e);
    });
};

const saveChapters = async (data, vodData, app) => {
  let vod_data;
  await app
    .service("vods")
    .get(vodData.id)
    .then((data) => {
      vod_data = data;
    })
    .catch((e) => {
      console.error(e);
    });

  if (!vod_data)
    return console.error("Failed to save chapters: No vod in database..?");

  const chapters = vod_data.chapters;

  const gameData = await twitch.getGameData(data.game_id);
  if (!gameData) return console.error("Failed to get game data");

  const chapter = {
    gameId: gameData.id,
    name: gameData.name,
    image: gameData.box_art_url,
    title: data.title,
    duration: moment
      .duration(
        moment.utc().diff(moment.utc(data.started_at)) - 60 * 1000 * 7,
        "milliseconds"
      )
      .format("HH:mm:ss", { trim: false }),
  };

  //don't push chapter if the last chapter was the same game.
  if (chapters[chapters.length - 1].gameId !== chapter.gameId) {
    chapters.push(chapter);
  }

  await app
    .service("vods")
    .patch(vodData.id, {
      chapters: chapters,
    })
    .then(() => {
      console.info(
        `Saved chapter: ${chapter.name} for ${vodData.user_name} in vod ${vodData.id}`
      );
    })
    .catch((e) => {
      console.error(e);
    });
};
