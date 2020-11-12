const vod = require("./vod");
const twitch = require('./twitch');

module.exports.verify = function (app) {
  return async function (req, res, next) {
    if (!req.headers["authorization"]) {
      res.status(403).json({ error: true, message: "Missing auth key" });
      return;
    }

    const authKey = req.headers.authorization.split(" ")[1];
    const key = app.get("ADMIN_API_KEY");

    if (key !== authKey) {
      res.status(403).json({ error: true, message: "Not authorized" });
      return;
    }
    next();
  };
};

module.exports.download = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No VodId" });

    let exists;
    await app
      .service("vods")
      .get(req.body.vodId)
      .then(() => {
        exists = true;
      })
      .catch(() => {
        exists = false;
      });
    if (exists) {
      vod.download(req.body.vodId, app);
      res.status(200).json({ error: false, message: "Starting download.." });
      return;
    }

    const vodData = await twitch.getVodData(req.body.vodId);

    await app
    .service("vods")
    .create({
      id: vodData.id,
      title: vodData.title,
      date: new Date(vodData.created_at).toLocaleDateString()
    })
    .then(() => {
      console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
    })
    .catch((e) => {
      console.error(e);
    });

    vod.download(req.body.vodId, app);
    res.status(200).json({ error: false, message: "Starting download.." });
  };
};

module.exports.logs = function (app) {
  return async function (req, res, next) {
    if (!req.body.vodId)
      return res.status(400).json({ error: true, message: "No VodId" });

    let total;
    app
      .service("logs")
      .find({
        vod_id: req.body.vodId,
      })
      .then((data) => {
        total = data.total;
      })
      .catch((e) => {
        console.error(e);
      });

    if (total > 1)
      return res.status(400).json({
        error: true,
        message: `Logs already exist for ${req.body.vodId}`,
      });

    vod.getLogs(req.body.vodId, app);
    res.status(200).json({ error: false, message: "Getting logs.." });
  };
};
