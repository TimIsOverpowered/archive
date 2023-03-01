const axios = require("axios");
const config = require("../../config/config.json");

module.exports.checkPullZone = (app) => {
  return async (req, res, next) => {
    const client = app.get("redisClient");
    const key = `${config.channel}-bunnycdn`;
    const data = await client
      .get(key)
      .then((data) => JSON.parse(data))
      .catch(() => null);
    if (!data) {
      if (!config.bunnycdn)
        return res.status(200).json({
          enabled: false,
        });
      const responseJson = {
        enabled: config.bunnycdn ? config.bunnycdn.enabled : false,
        available: config.bunnycdn && config.bunnycdn.enabled ? await checkAvailability() : false,
      };
      client.set(key, JSON.stringify(responseJson), {
        EX: 60 * 5,
      });

      return res.status(200).json(responseJson);
    }

    res.status(200).json(data);
  };
};

const checkAvailability = async () => {
  const available = await axios(`https://api.bunny.net/pullzone/${config.bunnycdn.pull_zone}`, {
    method: "GET",
    headers: {
      AccessKey: `${config.bunnycdn.api_key}`,
    },
  })
    .then((response) => response.data.Enabled)
    .catch(async (e) => {
      console.error(e.response ? e.response.data : e);
      return false;
    });

  return available;
};
