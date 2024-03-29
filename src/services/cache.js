//https://github.com/sarkistlt/feathers-redis-cache/blob/master/src/hooks.ts
const config = require("../../config/config.json");
const qs = require("qs");
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
const relativeTime = require("dayjs/plugin/relativeTime");
dayjs.extend(duration);
dayjs.extend(relativeTime);

const { DISABLE_REDIS_CACHE, ENABLE_REDIS_CACHE_LOGGER } = process.env;
const HTTP_SERVER_ERROR = 500;
const defaults = {
  defaultExpiration: 3600 * 24, // seconds
  prefix: config.channel,
};

const hashCode = (s) => {
  let h;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return String(h);
};

const cacheKey = (hook) => {
  const q = hook.params.query || {};
  const p = hook.params.paginate === false ? "disabled" : "enabled";
  let path = `pagination-hook:${p}::${hook.path}`;

  if (hook.id) {
    path += `/${hook.id}`;
  }

  if (Object.keys(q).length > 0) {
    path += `?${qs.stringify(JSON.parse(JSON.stringify(q)), {
      encode: false,
    })}`;
  }

  // {prefix}{group}{key}
  return `${hashCode(hook.path)}${hashCode(path)}`;
};

module.exports.before = (passedOptions = {}) => {
  if (DISABLE_REDIS_CACHE) {
    return (hook) => hook;
  }

  return function (hook) {
    try {
      if (hook && hook.params && hook.params.$skipCacheHook) {
        return Promise.resolve(hook);
      }

      return new Promise(async (resolve) => {
        const client = hook.app.get("redisClient");
        const options = { ...defaults, ...passedOptions };

        if (!client) {
          return resolve(hook);
        }

        const group =
          typeof options.cacheGroupKey === "function"
            ? hashCode(`group-${options.cacheGroupKey(hook)}`)
            : hashCode(`group-${hook.path || "general"}`);
        const path =
          typeof options.cacheKey === "function"
            ? `${options.prefix}${group}${options.cacheKey(hook)}`
            : `${options.prefix}${group}${cacheKey(hook)}`;

        hook.params.cacheKey = path;

        data = await client
          .GET(path)
          .then((res) => JSON.parse(res))
          .catch(() => resolve(hook));

        if (!data || !data.expiresOn || !data.cache) {
          return resolve(hook);
        }

        const duration = dayjs(data.expiresOn).format(
          "DD MMMM YYYY - HH:mm:ss"
        );

        hook.result = data.cache;
        hook.params.$skipCacheHook = true;

        if (options.env !== "test" && ENABLE_REDIS_CACHE_LOGGER === "true") {
          console.log(`[redis] returning cached value for ${path}.`);
          console.log(`> Expires on ${duration}.`);
        }

        return resolve(hook);
      });
    } catch (err) {
      console.error(err);
      return Promise.resolve(hook);
    }
  };
};

module.exports.after = (passedOptions = {}) => {
  if (DISABLE_REDIS_CACHE) {
    return (hook) => hook;
  }

  return function (hook) {
    try {
      if (hook && hook.params && hook.params.$skipCacheHook) {
        return Promise.resolve(hook);
      }

      if (!hook.result) {
        return Promise.resolve(hook);
      }

      return new Promise((resolve) => {
        const client = hook.app.get("redisClient");
        const options = { ...defaults, ...passedOptions };
        const duration = options.expiration || options.defaultExpiration;
        const { cacheKey } = hook.params;

        if (!client || !cacheKey) {
          return resolve(hook);
        }

        client.SET(
          cacheKey,
          JSON.stringify({
            cache: hook.result,
            expiresOn: dayjs().add(duration, "s"),
          })
        );

        client.EXPIRE(cacheKey, duration);

        if (options.env !== "test" && ENABLE_REDIS_CACHE_LOGGER === "true") {
          console.log(`[redis] added ${cacheKey} to the cache.`);
          console.log(
            `> Expires in ${dayjs.duration(duration, "s").humanize()}.`
          );
        }

        resolve(hook);
      });
    } catch (err) {
      console.error(err);
      return Promise.resolve(hook);
    }
  };
};

async function purgeGroup(client, group, prefix = config.channel) {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    const scan = async () => {
      const reply = await client
        .SCAN(cursor, { MATCH: `${prefix}${group}*`, COUNT: 1000 })
        .catch((err) => reject(err));

      cursor = reply.cursor;
      const keys = reply.keys;

      for (key of keys) {
        await client.del(key);
      }

      if (cursor !== 0) return scan();

      resolve();
    };
    return scan();
  });
}

module.exports.purge = (passedOptions = {}) => {
  if (DISABLE_REDIS_CACHE) {
    return (hook) => hook;
  }

  return function (hook) {
    try {
      return new Promise((resolve) => {
        const client = hook.app.get("redisClient");
        const options = { ...defaults, ...passedOptions };
        const { prefix } = hook.app.get("redis");
        const group =
          typeof options.cacheGroupKey === "function"
            ? hashCode(`group-${options.cacheGroupKey(hook)}`)
            : hashCode(`group-${hook.path || "general"}`);

        if (!client) {
          return {
            message: "Redis unavailable",
            status: HTTP_SERVER_ERROR,
          };
        }

        purgeGroup(client, group, prefix).catch((err) =>
          console.error({
            message: err.message,
            status: HTTP_SERVER_ERROR,
          })
        );

        // do not wait for purge to resolve
        resolve(hook);
      });
    } catch (err) {
      console.error(err);
      return Promise.resolve(hook);
    }
  };
};

module.exports.purgeVods = () => {
  return function (hook) {
    try {
      return new Promise((resolve) => {
        const client = hook.app.get("redisClient");
        const { prefix } = hook.app.get("redis");
        const group = hashCode(`group-vods`);

        if (!client) {
          return {
            message: "Redis unavailable",
            status: HTTP_SERVER_ERROR,
          };
        }

        purgeGroup(client, group, prefix).catch((err) =>
          console.error({
            message: err.message,
            status: HTTP_SERVER_ERROR,
          })
        );

        // do not wait for purge to resolve
        resolve(hook);
      });
    } catch (err) {
      console.error(err);
      return Promise.resolve(hook);
    }
  };
};
