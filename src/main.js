const twitch = require("./middleware/twitch");
const moment = require("moment");
const config = require('../config/config.json');
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
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
    path.resolve(__dirname, "../config/config.json"),
    JSON.stringify(config, null, 4),
    (err) => {
      if (err) return console.error(err);
      console.info("Refreshed Google Token");
    }
  );
  oauth2Client.credentials = tokens;
});

module.exports = async function (app) {
  app.googleClient = oauth2Client;

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
};
