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
        primaryKey: true,
      },
      started_at: {
        type: DataTypes.DATE,
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
