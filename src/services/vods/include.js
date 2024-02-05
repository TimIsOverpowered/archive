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
    if (!context.params.query.chapters) return context;
    if (!context.params.query.chapters.name) return context;
    context.params.sequelize = {
      ...context.params.sequelize,
      where: sequelize.literal(
        `"vods"."chapters" @? '$[*] ? (@.name like_regex ".*${context.params.query.chapters.name}.*" flag "i")'`
      ),
    };
    return context;
  };
};
