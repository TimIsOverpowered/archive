const logs = sequelizeClient.define(
  'logs',
  {
    id: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
    },
    vod_id: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    display_name: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    content_offset_seconds: {
      type: DataTypes.DECIMAL,
      allowNull: false,
    },
    message: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    user_badges: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    user_color: {
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
  },
);
