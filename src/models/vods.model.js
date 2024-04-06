// See http://docs.sequelizejs.com/en/latest/docs/models-definition/
// for more of what you can do here.
const Sequelize = require("sequelize");
const DataTypes = Sequelize.DataTypes;

module.exports = function (app) {
  const sequelizeClient = app.get("sequelizeClient");
  const vods = sequelizeClient.define(
    "vods",
    {
      id: {
        type: DataTypes.TEXT,
        allowNull: false,
        primaryKey: true,
      },
      chapters: {
        type: DataTypes.JSONB,
        defaultValue: [],
      },
      title: {
        type: DataTypes.TEXT,
      },
      duration: {
        type: DataTypes.TEXT,
        defaultValue: "00:00:00",
      },
      thumbnail_url: {
        type: DataTypes.TEXT,
      },
      youtube: {
        type: DataTypes.JSONB,
        defaultValue: [],
      },
      stream_id: {
        type: DataTypes.TEXT,
      },
      drive: {
        type: DataTypes.JSONB,
        defaultValue: [],
      },
      platform: {
        type: DataTypes.TEXT,
        allowNull: false,
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

  vods.associate = function (models) {
    vods.hasOne(models.emotes);
    vods.hasMany(models.games);
  };

  return vods;
};
