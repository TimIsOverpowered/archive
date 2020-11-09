const axios = require("axios");
const config = require("../../config/config.json");
const fs = require("fs");
const path = require("path");
const HLS = require("hls-parser");

module.exports.checkToken = async () => {
  let isValid = false;
  await axios(`https://id.twitch.tv/oauth2/validate`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.twitch.access_token}`,
    },
  })
    .then((response) => {
      if (response.status < 400) {
        isValid = true;
      }
    })
    .catch(async (e) => {
      if (e.response.status === 401) {
        console.info("Twitch App Token Expired");
        return await this.refreshToken();
      }
      console.error(e.response.data);
    });
  return isValid;
};

module.exports.refreshToken = async () => {
  await axios
    .post(
      `https://id.twitch.tv/oauth2/token?client_id=${config.twitch.client_id}&client_secret=${config.twitch.client_secret}&grant_type=client_credentials`
    )
    .then((response) => {
      const data = response.data;
      config.twitch.access_token = data.access_token;
      fs.writeFile(
        path.resolve(__dirname, "../../config/config.json"),
        JSON.stringify(config, null, 4),
        (err) => {
          if (err) return console.error(err);
          console.info("Refreshed Twitch App Token");
        }
      );
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      console.error(e.response.data);
    });
};

module.exports.getWebhooks = async () => {
  let webhooks;
  await axios
    .get(`https://api.twitch.tv/helix/webhooks/subscriptions?first=100`, {
      headers: {
        Authorization: `Bearer ${config.twitch.access_token}`,
        "Client-Id": config.twitch.client_id,
      },
    })
    .then(async (response) => {
      const data = response.data;
      webhooks = data.data;
      let cursor = data.pagination.cursor;

      while (cursor) {
        let newData = await getNextWebhooks(cursor);
        cursor = newData.pagination.cursor;
        webhooks = webhooks.concat(newData.data);
      }
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return webhooks;
};

const getNextWebhooks = async (cursor) => {
  let data;
  await axios
    .get(
      `https://api.twitch.tv/helix/webhooks/subscriptions?first=100&after=${cursor}`,
      {
        headers: {
          Authorization: `Bearer ${config.twitch.access_token}`,
          "Client-Id": config.twitch.client_id,
        },
      }
    )
    .then((response) => {
      data = response.data;
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return data;
};

module.exports.unsubscribe = async (user_id) => {
  await axios(`https://api.twitch.tv/helix/webhooks/hub`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.twitch.access_token}`,
      "Client-Id": config.twitch.client_id,
    },
    data: {
      "hub.callback": config.twitch.webhook_callback + `stream/${user_id}`,
      "hub.mode": "unsubscribe",
      "hub.topic": `https://api.twitch.tv/helix/streams?user_id=${user_id}`,
    },
  })
    .then((response) => {
      if (response.status === 202) {
        console.log(`unsubscribe: ${user_id}`);
      }
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
};

module.exports.subscribe = async (user_id) => {
  await axios(`https://api.twitch.tv/helix/webhooks/hub`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.twitch.access_token}`,
      "Client-Id": config.twitch.client_id,
    },
    data: {
      "hub.callback": config.twitch.webhook_callback + `stream/${user_id}`,
      "hub.mode": "subscribe",
      "hub.topic": `https://api.twitch.tv/helix/streams?user_id=${user_id}`,
      "hub.lease_seconds": 864000,
      "hub.secret": config.twitch.webhook_secret,
    },
  })
    .then((response) => {
      if (response.status === 202) {
        console.log(`trying to subscribe: ${user_id}`);
      }
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
};

module.exports.getVodTokenSig = async (vodId) => {
  let data;
  await axios
    .get(`https://api.twitch.tv/api/vods/${vodId}/access_token`, {
      headers: {
        Accept: "application/vnd.twitchtv.v5+json; charset=UTF-8",
        "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", //twitch's
      },
    })
    .then((response) => {
      data = response.data;
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return data;
};

module.exports.getM3u8 = async (vodId, token, sig) => {
  let data;
  await axios
    .get(
      `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=twitchweb&playlist_include_framerate=true&allow_spectre=true&nauthsig=${sig}&nauth=${token}`
    )
    .then((response) => {
      data = response.data;
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return data;
};

module.exports.getParsedM3u8 = (m3u8) => {
  return HLS.parse(m3u8).variants[0].uri;
};

module.exports.getLatestVodData = async (userId) => {
  let vodData;
  await axios
    .get(`https://api.twitch.tv/helix/videos?user_id=${userId}`, {
      headers: {
        Authorization: `Bearer ${config.twitch.access_token}`,
        "Client-Id": config.twitch.client_id,
      },
    })
    .then((response) => {
      let data = response.data.data;
      if (data.length > 0) {
        vodData = data[0];
      }
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return vodData;
};

module.exports.getVodData = async (vod_id) => {
  let vodData;
  await axios
    .get(`https://api.twitch.tv/helix/videos?id=${vod_id}`, {
      headers: {
        Authorization: `Bearer ${config.twitch.access_token}`,
        "Client-Id": config.twitch.client_id,
      },
    })
    .then((response) => {
      const data = response.data.data;
      if (data.length > 0) {
        vodData = data[0];
      }
    })
    .catch((e) => {
      console.error(e.response.data);
    });
  return vodData;
};
