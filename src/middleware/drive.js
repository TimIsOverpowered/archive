const config = require("../../config/config.json");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { google } = require("googleapis");

module.exports.upload = async (vodId, path, app) => {
  const oauth2Client = app.get("driveOauth2Client");
  const drive = google.drive({
    version: "v3",
    auth: oauth2Client,
  });
  await drive.files.list();
  await sleep(5000);

  const fileSize = fs.statSync(path).size;
  const res = await drive.files.create(
    {
      auth: oauth2Client,
      resource: {
        name: `${vodId}.mp4`,
        parents: config.drive.parents,
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

  let vod_data;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod_data = data;
    })
    .catch(() => {});

  if (!vod_data) return console.error("Failed to upload to drive: no VOD in database");

  vod_data.drive.push({
    id: res.data.id,
    type: "vod",
  });

  await app
    .service("vods")
    .patch(vod_data.id, {
      drive: vod_data.drive,
    })
    .catch((e) => {
      console.error(e);
    });
};

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

module.exports.download = async (vodId, type, app) => {
  let vod;
  await app
    .service("vods")
    .get(vodId)
    .then((data) => {
      vod = data;
    })
    .catch(() => {});

  if (!vod) return console.error("Failed to download from drive: no VOD in database");

  let driveId;

  for (let drive of vod.drive) {
    if (type !== drive.type) continue;
    driveId = drive.id;
  }

  if (!driveId) return console.error("Failed to download from drive: no DRIVE ID in database");

  console.info(`Drive Download: ${driveId} for ${type} ${vodId}`);
  const oauth2Client = app.get("driveOauth2Client");
  const drive = google.drive({
    version: "v3",
    auth: oauth2Client,
  });
  await drive.files.list();
  await sleep(5000);

  const filePath = path.join(type === "vod" ? config.vodPath : config.livePath, `${vodId}.mp4`);

  await drive.files.get({ fileId: driveId, alt: "media" }, { responseType: "stream" }).then((res) => {
    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(filePath);
      let progress = 0;

      res.data
        .on("end", () => {
          resolve(filePath);
        })
        .on("error", (err) => {
          console.error("Error downloading file.");
          reject(err);
        })
        .on("data", (d) => {
          progress += d.length;
          if (process.stdout.isTTY && (process.env.NODE_ENV || "").trim() !== "production") {
            process.stdout.clearLine();
            process.stdout.cursorTo(0);
            process.stdout.write(`Downloaded ${progress} bytes`);
          }
        })
        .pipe(dest);
    });
  });

  return filePath;
};
