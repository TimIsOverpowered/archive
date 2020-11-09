const crypto = require("crypto");
const config = require("../../config/config.json");
const vod = require("./vod");

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

    if (data.length === 0) {
      console.log(`${config.channel} went offline.`);
      //save duration
      vod.download(userId, app);
    } else {
      //save chapters and create in db (if not created already)
    }
  };
};
