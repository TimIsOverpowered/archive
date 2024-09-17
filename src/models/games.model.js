// See http://docs.sequelizejs.com/en/latest/docs/models-definition/
// for more of what you can do here.
const Sequelize = require("sequelize");
const DataTypes = Sequelize.DataTypes;

module.exports = function (app) {
  const sequelizeClient = app.get("sequelizeClient");
  const games = sequelizeClient.define(
    "games",
    {
      id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      vodId: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: "vod_id",
      },
      start_time: {
        type: DataTypes.DECIMAL,
      },
      end_time: {
        type: DataTypes.DECIMAL,
      },
      video_provider: {
        type: DataTypes.TEXT,
      },
      video_id: {
        type: DataTypes.TEXT,
      },
      thumbnail_url: {
        type: DataTypes.TEXT,
      },
      game_id: {
        type: DataTypes.TEXT,
      },
      game_name: {
        type: DataTypes.TEXT,
      },
      title: {
        type: DataTypes.TEXT,
      },
      chapter_image: {
        type: DataTypes.TEXT,
      },
    },
    {
      hooks: {
        beforeCount(options) {
          options.raw = true;
        },
      },
    }
  );

  games.associate = function (models) {
    games.belongsTo(models.vods);
  };

  return games;
};
