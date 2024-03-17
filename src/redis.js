const { createClient } = require("redis");
const { RateLimiterRedis } = require("rate-limiter-flexible");

module.exports = async function (app) {
  const redisConf = app.get("redis"),
    client = createClient({
      socket: {
        path: redisConf.useSocket ? redisConf.path : null,
        host: redisConf.host,
      },
      enable_offline_queue: false,
    });

  client.connect().catch((e) => console.error(e));

  app.set("redisClient", client);

  const rateLimiter = new RateLimiterRedis({
    storeClient: client,
    keyPrefix: "middleware",
    points: 20,
    duration: 5,
    useRedisPackage: true,
  });

  app.set("rateLimiter", rateLimiter);
};
