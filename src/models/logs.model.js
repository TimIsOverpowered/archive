// See http://docs.sequelizejs.com/en/latest/docs/models-definition/
// for more of what you can do here.
const Sequelize = require('sequelize');
const DataTypes = Sequelize.DataTypes;

module.exports = function (app) {
  const sequelizeClient = app.get('sequelizeClient');
  const logs = sequelizeClient.define('logs', {
    id: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true
    },
    _id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
    },
    vod_id: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    display_name: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    content_offset_seconds: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    message: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    user_badges: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    user_color: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  }, {
    hooks: {
      beforeCount(options) {
        options.raw = true;
      }
    }
  });

  // eslint-disable-next-line no-unused-vars
  logs.associate = function (models) {
    // Define associations here
    // See http://docs.sequelizejs.com/en/latest/docs/associations/
  };

  return logs;
};
