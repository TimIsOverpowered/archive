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
