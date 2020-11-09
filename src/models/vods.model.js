// See http://docs.sequelizejs.com/en/latest/docs/models-definition/
// for more of what you can do here.
const Sequelize = require('sequelize');
const DataTypes = Sequelize.DataTypes;

module.exports = function (app) {
  const sequelizeClient = app.get('sequelizeClient');
  const vods = sequelizeClient.define('vods', {
    id: {
      type: DataTypes.TEXT,
      allowNull: false,
      primaryKey: true
    },
    logs: {
      type: DataTypes.JSON
    },
    chapters: {
      type: DataTypes.JSON
    },
    title: {
      type: DataTypes.TEXT
    },
    duration: {
      type: DataTypes.TEXT
    },
    date: {
      type: DataTypes.TEXT
    },
    video_link: {
      type: DataTypes.TEXT
    },
    thumbnail_url: {
      type: DataTypes.TEXT
    },
    youtube_id: {
      type: DataTypes.TEXT
    }
  }, {
    hooks: {
      beforeCount(options) {
        options.raw = true;
      }
    }
  });

  // eslint-disable-next-line no-unused-vars
  vods.associate = function (models) {
    // Define associations here
    // See http://docs.sequelizejs.com/en/latest/docs/associations/
  };

  return vods;
};
