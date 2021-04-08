const twitch = require("./middleware/twitch");
const moment = require("moment");
const config = require('../config/config.json');
const vod = require("./middleware/vod");

module.exports = async function (app) {
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
  
  if(await twitch.checkIfLive(config.twitchId)) {
    const vodData = await twitch.getLatestVodData(config.twitchId);
    vod.startDownload(vodData.id);
  }
};
