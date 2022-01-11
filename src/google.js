const config = require("../config/config.json");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const fs = require("fs");
const path = require("path");

module.exports.initialize = (app) => {
  const oauth2Client = new OAuth2(
    config.google.client_id,
    config.google.client_secret,
    config.google.redirect_url
  );
  oauth2Client.on("tokens", (tokens) => {
    if (tokens.refresh_token)
      config.google.auth.refresh_token = tokens.refresh_token;
    config.google.auth.access_token = tokens.access_token;

    fs.writeFile(
      path.resolve(__dirname, "../config/config.json"),
      JSON.stringify(config, null, 4),
      (err) => {
        if (err) return console.error(err);
        console.info("Refreshed Google Token");
      }
    );

    oauth2Client.setCredentials({
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });
  });

  oauth2Client.setCredentials(config.google.auth);

  app.set("googleOauth2Client", oauth2Client);
};
