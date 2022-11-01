// See https://sequelize.org/master/manual/model-basics.html
// for more of what you can do here.
const Sequelize = require("sequelize");
const DataTypes = Sequelize.DataTypes;

module.exports = function (app) {
  const sequelizeClient = app.get("sequelizeClient");
  const emotes = sequelizeClient.define(
    "emotes",
    {
      vodId: {
        type: DataTypes.TEXT,
        primaryKey: true,
        allowNull: false,
        field: "vod_id",
      },
      ffz_emotes: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        defaultValue: [],
      },
      bttv_emotes: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        defaultValue: [],
      },
      "7tv_emotes": {
        type: DataTypes.ARRAY(DataTypes.JSON),
        defaultValue: [],
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

  emotes.associate = function (models) {
    emotes.belongsTo(models.vods);
  };

  return emotes;
};
