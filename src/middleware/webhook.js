const crypto = require("crypto");
const config = require("../../config/config.json");
const vod = require("./vod");
const twitch = require("./twitch");

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
    const vodData = await twitch.getLatestVodData(userId);
    if (!vodData) return console.error("Failed to get latest vod in webhook");

    if (data.length === 0) {
      console.log(`${config.channel} went offline.`);
      saveDuration(vodData);
      vod.download(vodData, app);
      vod.getLogs(vodData);
      return;
    }

    if (!exists(vodData)) {
      createVod(data, vodData);
      return;
    }
    saveChapters(data, vodData);
  };
};

const saveDuration = async (vodData) => {
  await app
    .service("vods")
    .patch(vodData.id, {
      duration: vodData.duration,
    })
    .catch((e) => {
      console.error(e);
    });
};

const exists = async (vodData) => {
  await app
    .service("vods")
    .get(vodData.id)
    .then(() => {
      return true;
    })
    .catch((e) => {
      console.error(e);
    });
  return false;
};

const createVod = async (data, vodData) => {
  const gameData = await twitch.getGameData(data.game_id);
  if (!gameData) return console.error("Failed to get game data");

  const chapters = [
    {
      title: "Start of stream",
      name: gameData.name,
      duration: "00:00",
    },
    {
      gameId: gameData.id,
      name: gameData.name,
      image: gameData.box_art_url,
      title: data.title,
      duration: moment
        .duration(moment.utc().diff(moment.utc(data.started_at)), "seconds")
        .format("HH:mm:ss", { trim: true }),
    },
  ];

  await app
    .service("vods")
    .create({
      id: vodData.id,
      title: vodData.title,
      date: new Date(vodData.created_at).toLocaleDateString(),
      chapters: chapters,
    })
    .then(() => {
      console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
    })
    .catch((e) => {
      console.error(e);
    });
};

const saveChapters = async (data, vodData) => {
  let vod;
  await app
    .service("vods")
    .get(vodData.id)
    .then((data) => {
      vod = data;
    })
    .catch((e) => {
      console.error(e);
    });

  if (!vod)
    return console.error("Failed to save chapters: No vod in database..?");

  const chapters = vod.chapters;

  const gameData = await twitch.getGameData(data.game_id);
  if (!gameData) return console.error("Failed to get game data");

  const chapter = {
    gameId: gameData.id,
    name: gameData.name,
    image: gameData.box_art_url,
    title: data.title,
    duration: moment
      .duration(moment.utc().diff(moment.utc(data.started_at)), "seconds")
      .format("HH:mm:ss", { trim: true }),
  };

  //don't push chapter if the last chapter was the same game.
  if (chapters[chapters.length - 1] !== chapter.gameId) {
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
