const config = require("./config.json");
const twitch = require("./twitch");
const express = require("express");
const moment = require("moment");
const webhook = require("./webhook");
const vod = require("./vod");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const rawBodySaver = function (req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || "utf8");
  }
};
app.use(express.raw({ verify: rawBodySaver(), type: "*/*" }));
const fs = require("fs");
const path = require("path");
const oauth2Client = new OAuth2(
  config.google.client_id,
  config.google.client_secret,
  config.google.redirect_url
);
oauth2Client.credentials = config.youtube;
oauth2Client.on("tokens", (tokens) => {
  if (tokens.refresh_token) {
    config.youtube.refresh_token = tokens.refresh_token;
  }
  config.youtube.access_token = tokens.access_token;
  fs.writeFile(
    path.resolve(__dirname, "./config.json"),
    JSON.stringify(config, null, 4),
    (err) => {
      if (err) return console.error(err);
      console.info("Refreshed Google Token");
    }
  );
  oauth2Client.credentials = tokens;
});
app.googleClient = oauth2Client;

app.listen(config.port, () =>
  console.log(`${config.channel}-archives listening on port ${config.port}!`)
);

const main = async () => {
  await twitch.checkToken();
  const webhooks = await twitch.getWebhooks();
  if (!webhooks) return console.error("failed to retrieve webhooks");

  if (webhooks.length === 0) {
    await twitch.subscribe(config.twitchId);
    setInterval(() => {
      twitch.subscribe(config.twitchId);
    }, 864000 * 1000);
    return;
  }

  for (let webhook of webhooks) {
    let id = webhook.topic.substring(
      webhook.topic.indexOf("?user_id=") + 9,
      webhook.topic.length
    );
    if (config.twitchId === id) {
      setTimeout(() => {
        twitch.subscribe(config.twitchId);
        setInterval(() => {
          twitch.subscribe(config.twitchId);
        }, 864000 * 1000);
      }, moment.utc(webhook.expires_at).diff(moment.utc()));
      continue;
    }
  }
  //manual
  vod.download(config.twitchId, app);
};

main();

app.get("/twitch/webhook/*", webhook.verify(app));
app.post("/twitch/webhook/stream/:userId", webhook.stream(app));
