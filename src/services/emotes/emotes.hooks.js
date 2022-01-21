const { disallow } = require("feathers-hooks-common");
const redisCache = require("../cache");

module.exports = {
  before: {
    all: [],
    find: [redisCache.before()],
    get: [redisCache.before()],
    create: [disallow("external")],
    update: [disallow("external")],
    patch: [disallow("external")],
    remove: [disallow("external")],
  },

  after: {
    all: [],
    find: [redisCache.after({ expiration: 3600 * 24 })],
    get: [redisCache.after({ expiration: 3600 * 24 })],
    create: [redisCache.purge()],
    update: [redisCache.purge()],
    patch: [redisCache.purge()],
    remove: [redisCache.purge()],
  },

  error: {
    all: [],
    find: [],
    get: [],
    create: [],
    update: [],
    patch: [],
    remove: [],
  },
};
