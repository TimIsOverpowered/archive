const twitch = require("./middleware/twitch");
const config = require("../config/config.json");
const vod = require("./middleware/vod");

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
  if (stream && stream.length !== null && stream.length > 0 && stream[0] && stream[0].type === "live") {
    const vodData = await twitch.getLatestVodData(config.twitchId);
    if (vodData && vodData.stream_id && stream[0].id === vodData.stream_id) {
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
      vod.startDownload(vodData.id, app);
    }
  }
  check(app);
};

const check = async (app) => {
  if ((process.env.NODE_ENV || "").trim() !== "production")
    console.info(`Checking if ${config.channel} is live..`);
  const stream = await twitch.getStream(config.twitchId);
  if (stream && stream.length !== null && stream.length > 0 && stream[0] && stream[0].type === "live") {
    const vodData = await twitch.getLatestVodData(config.twitchId);
    if (vodData && vodData.stream_id && stream[0].id === vodData.stream_id) {
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

        vod.startDownload(vodData.id, app);
      }
    }
  }

  setTimeout(() => {
    check(app);
  }, 30000);
};
