const axios = require("axios");
const config = require("../../config/config.json");
const fs = require("fs");
const path = require("path");

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
      if (!e.response) return console.error(e);
      if (e.response.status === 401) {
        console.info("Twitch App Token Expired");
        return await this.refreshToken();
      }
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
      if (!e.response) return console.error(e);
      console.error(e.response.data);
    });
  return vodData;
};

module.exports.getGameData = async (gameId) => {
  let gameData;
  await axios
    .get(`https://api.twitch.tv/helix/games?id=${gameId}`, {
      headers: {
        Authorization: `Bearer ${config.twitch.access_token}`,
        "Client-Id": config.twitch.client_id,
      },
    })
    .then((response) => {
      let data = response.data.data;
      if (data.length > 0) {
        gameData = data[0];
      }
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return gameData;
};

module.exports.fetchComments = async (vodId, offset = 0) => {
  let data;
  await axios
    .get(
      `https://api.twitch.tv/v5/videos/${vodId}/comments?content_offset_seconds=${offset}`,
      {
        headers: {
          "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
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

module.exports.fetchNextComments = async (vodId, cursor) => {
  let data;
  await axios
    .get(`https://api.twitch.tv/v5/videos/${vodId}/comments?cursor=${cursor}`, {
      headers: {
        "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
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

module.exports.getChapters = async (vodID) => {
  let data;
  await axios({
    url: "https://gql.twitch.tv/gql",
    method: "POST",
    headers: {
      Accept: "*/*",
      "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", //twitch's
      "Content-Type": "text/plain;charset=UTF-8",
    },
    data: {
      operationName: "VideoPreviewCard__VideoMoments",
      variables: {
        videoId: vodID,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "0094e99aab3438c7a220c0b1897d144be01954f8b4765b884d330d0c0893dbde",
        },
      },
    },
  })
    .then((response) => {
      if (!response.data.data.video) return null;
      data = response.data.data.video.moments.edges;
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return data;
};

module.exports.getChapter = async (vodID) => {
  let data;
  await axios({
    url: "https://gql.twitch.tv/gql",
    method: "POST",
    headers: {
      Accept: "*/*",
      "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", //twitch's
      "Content-Type": "text/plain;charset=UTF-8",
    },
    data: {
      operationName: "NielsenContentMetadata",
      variables: {
        isCollectionContent: false,
        isLiveContent: false,
        isVODContent: true,
        collectionID: "",
        login: "",
        vodID: vodID,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "2dbf505ee929438369e68e72319d1106bb3c142e295332fac157c90638968586",
        },
      },
    },
  })
    .then((response) => {
      data = response.data.data.video;
    })
    .catch(async (e) => {
      if (!e.response) {
        return console.error(e);
      }
      console.error(e.response.data);
    });
  return data;
};

module.exports.getStream = async (twitchId) => {
  let stream;
  await axios
    .get(`https://api.twitch.tv/helix/streams?user_id=${twitchId}`, {
      headers: {
        Authorization: `Bearer ${config.twitch.access_token}`,
        "Client-Id": config.twitch.client_id,
      },
    })
    .then((response) => {
      stream = response.data.data;
    })
    .catch((e) => {
      if (!e.response) return console.error(e);
      console.error(e.response.data);
    });
  return stream;
};