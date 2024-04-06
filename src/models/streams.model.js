// See https://sequelize.org/master/manual/model-basics.html
// for more of what you can do here.
const Sequelize = require("sequelize");
const DataTypes = Sequelize.DataTypes;

module.exports = function (app) {
  const sequelizeClient = app.get("sequelizeClient");
  const streams = sequelizeClient.define(
    "streams",
    {
      id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        primaryKey: true,
      },
      started_at: {
        type: DataTypes.DATE,
      },
      platform: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      is_live: {
        type: DataTypes.BOOLEAN,
      },
    },
    {
      timestamps: false,
      hooks: {
        beforeCount(options) {
          options.raw = true;
        },
      },
    }
  );

  return streams;
};
