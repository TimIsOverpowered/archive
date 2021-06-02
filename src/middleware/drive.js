const config = require("../../config/config.json");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const oauth2Client = new OAuth2(
  config.google.client_id,
  config.google.client_secret,
  config.google.redirect_url
);
oauth2Client.on("tokens", (tokens) => {
  if (tokens.refresh_token) {
    config.drive.refresh_token = tokens.refresh_token;
  }
  config.drive.access_token = tokens.access_token;
  fs.writeFile(
    path.resolve(__dirname, "../../config/config.json"),
    JSON.stringify(config, null, 4),
    (err) => {
      if (err) return console.error(err);
      console.info("Refreshed Drive Token");
    }
  );
  oauth2Client.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
  });
});

module.exports.upload = async (vodId, path) => {
  oauth2Client.credentials = config.drive;
  const drive = google.drive("v3");
  await drive.files.list({
    auth: oauth2Client,
  });
  const fileSize = fs.statSync(path).size;
  const res = await drive.files.create(
    {
      auth: oauth2Client,
      resource: {
        name: `${vodId}.mp4`,
        parents: config.drive.parents
      },
      media: {
        body: fs.createReadStream(path),
      },
    },
    {
      onUploadProgress: (evt) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          const progress = (evt.bytesRead / fileSize) * 100;
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(`DRIVE UPLOAD PROGRESS: ${Math.round(progress)}%`);
        }
      },
    }
  );
  console.log("\n\n");
  console.log(res.data);
};
