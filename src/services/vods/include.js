module.exports = () => {
  return async (context) => {
    const sequelize = context.app.get("sequelizeClient");
    const { games, streams } = sequelize.models;
    context.params.sequelize = {
      include: [{ model: games, model: streams }],
      raw: false,
    };
    return context;
  };
};
