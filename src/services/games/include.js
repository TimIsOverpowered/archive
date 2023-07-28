module.exports = () => {
  return async (context) => {
    const sequelize = context.app.get("sequelizeClient");
    const { vods, games } = sequelize.models;
    context.params.sequelize = {
      include: [{ model: vods, include: [games] }],
      raw: false,
    };
    return context;
  };
};
