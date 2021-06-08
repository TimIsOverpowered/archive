const twitch = require("./middleware/twitch");
const config = require("../config/config.json");
const vod = require("./middleware/vod");
const fs = require("fs");

process.on("unhandledRejection", function (reason, p) {
  console.log(
    "Possibly Unhandled Rejection at: Promise ",
    p,
    " reason: ",
    reason
  );
  // application specific logging here
});

module.exports = async function (app) {
  await twitch.checkToken();
  const stream = await twitch.getStream(config.twitchId);
  if (stream.length > 0 && stream[0].type === "live") {
    const vodData = await twitch.getLatestVodData(config.twitchId);
    if (stream[0].id === vodData.stream_id) {
      let exists;
      await app
        .service("vods")
        .get(vodData.id)
        .then(() => {
          exists = true;
        })
        .catch(() => {
          exists = false;
        });
      if (!exists) {
        await app
          .service("vods")
          .create({
            id: vodData.id,
            title: vodData.title,
            date: new Date(vodData.created_at).toLocaleDateString("en-US", {
              timeZone: config.timezone,
            }),
            createdAt: vodData.created_at,
            stream_id: vodData.stream_id,
          })
          .then(() => {
            console.info(`Created vod ${vodData.id} for ${vodData.user_name}`);
          })
          .catch((e) => {
            console.error(e);
          });
      }
      const dir = `${config.vodPath}${vodData.id}`;
      if (await fileExists(dir))
        await fs.promises.rmdir(dir, {
          recursive: true,
        });
      vod.startDownload(vodData.id, app);
    }
  }
  check(app);
};

const fileExists = async (file) => {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
};

const check = async (app) => {
  if ((process.env.NODE_ENV || "").trim() !== "production")
    console.info(`Checking if ${config.channel} is live..`);
  const stream = await twitch.getStream(config.twitchId);
  if (stream.length > 0 && stream[0].type === "live") {
    const vodData = await twitch.getLatestVodData(config.twitchId);
    if (stream[0].id === vodData.stream_id) {
      let exists;
      await app
        .service("vods")
        .get(vodData.id)
        .then(() => {
          exists = true;
        })
        .catch(() => {
          exists = false;
        });
      if (!exists) {
        await app
          .service("vods")
          .create({
            id: vodData.id,
            title: vodData.title,
            date: new Date(vodData.created_at).toLocaleDateString("en-US", {
              timeZone: config.timezone,
            }),
            createdAt: vodData.created_at,
            stream_id: vodData.stream_id,
          })
          .then(() => {
            console.log(
              `${
                config.channel
              } went online. Creating vod. ${new Date().toLocaleDateString()}`
            );
          })
          .catch((e) => {
            console.error(e);
          });

        const dir = `${config.vodPath}${vodData.id}`;
        if (await fileExists(dir))
          await fs.promises.rmdir(dir, {
            recursive: true,
          });
        vod.startDownload(vodData.id, app);
      }
    }
  }

  setTimeout(() => {
    check(app);
  }, 30000);
};
