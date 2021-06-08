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
    chapters: {
      type: DataTypes.ARRAY(DataTypes.JSON)
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
    thumbnail_url: {
      type: DataTypes.TEXT
    },
    stream_id: {
      type: DataTypes.TEXT
    },
    drive_id: {
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
