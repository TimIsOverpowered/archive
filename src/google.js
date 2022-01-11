const config = require("../config/config.json");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const fs = require("fs");
const path = require("path");

module.exports.initializeYt = (app) => {
  const oauth2Client = new OAuth2(config.google.client_id, config.google.client_secret, config.google.redirect_url);
  oauth2Client.on("tokens", (tokens) => {
    if (tokens.refresh_token) config.youtube.auth.refresh_token = tokens.refresh_token;
    config.youtube.auth.access_token = tokens.access_token;

    fs.writeFile(path.resolve(__dirname, "../config/config.json"), JSON.stringify(config, null, 4), (err) => {
      if (err) return console.error(err);
      console.info("Refreshed Youtube Token");
    });

    oauth2Client.setCredentials({
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });
  });

  oauth2Client.setCredentials(config.youtube.auth);

  app.set("ytOauth2Client", oauth2Client);
};

module.exports.initializeDrive = (app) => {
  const oauth2Client = new OAuth2(config.google.client_id, config.google.client_secret, config.google.redirect_url);
  oauth2Client.on("tokens", (tokens) => {
    if (tokens.refresh_token) config.drive.auth.refresh_token = tokens.refresh_token;
    config.drive.auth.access_token = tokens.access_token;

    fs.writeFile(path.resolve(__dirname, "../config/config.json"), JSON.stringify(config, null, 4), (err) => {
      if (err) return console.error(err);
      console.info("Refreshed Drive Token");
    });

    oauth2Client.setCredentials({
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });
  });

  oauth2Client.setCredentials(config.drive.auth);

  app.set("driveOauth2Client", oauth2Client);
};
