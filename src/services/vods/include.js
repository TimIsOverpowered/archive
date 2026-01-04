const { Op } = require("sequelize");

module.exports = () => {
  return async (context) => {
    const sequelize = context.app.get("sequelizeClient");
    const { games } = sequelize.models;
    context.params.sequelize = {
      include: [{ model: games }],
      raw: false,
    };
    return context;
  };
};

/**
 * Implment ilike search in chapters array.
 */
module.exports.games = () => {
  return async (context) => {
    const sequelize = context.app.get("sequelizeClient");
    const game = containsGame(context.params.query);
    if (!game) return context;
    const platform = containsPlatform(context.params.query);
    context.params.sequelize = {
      ...context.params.sequelize,
      where: {
        [Op.and]: [
          // 1. Use %%s to escape the percent for Sequelize
          // 2. Wrap pattern in extra double quotes because JSONPath requires them for strings
          sequelize.literal(
            `"vods"."chapters" @? format('$[*] ? (@.name like_regex %s flag "i")', :gamePattern)::jsonpath`
          ),
          ...(platform ? [{ platform }] : []),
        ],
      },
      replacements: {
        // Must include the double quotes inside the replacement string for the JSONPath syntax
        gamePattern: `".*${game}.*"`,
      },
    };
    return context;
  };
};

const containsGame = (query) => {
  if (query.$and) {
    let game = null;
    for (let i = 0; i <= query.$and.length; i++) {
      let key = query.$and[i];
      if (key?.chapters?.name) {
        game = key.chapters.name;
        query.$and.splice(i, 1);
        break;
      }
    }
    return game;
  }
  if (!query.chapters) return null;
  if (!query.chapters.name) return null;
  return query.chapters.name;
};

const containsPlatform = (query) => {
  if (query.$and) {
    let platform = null;
    for (let i = 0; i <= query.$and.length; i++) {
      let key = query.$and[i];
      if (key?.platform) {
        platform = key.platform;
        query.$and.splice(i, 1);
        break;
      }
    }
    return platform;
  }
  if (!query.platform) return null;
  return query.platform;
};
