const { disallow } = require("feathers-hooks-common");
const modify = require("./modify");
const redisCache = require("../cache");

module.exports = {
  before: {
    all: [disallow("external")],
    find: [redisCache.before()],
    get: [],
    create: [],
    update: [],
    patch: [],
    remove: [],
  },

  after: {
    all: [],
    find: [modify(), redisCache.after({ expiration: 3600 * 24 })],
    get: [],
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
