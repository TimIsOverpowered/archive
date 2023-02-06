const config = require("../../config/config.json");

module.exports = function (app) {
  return async function (req, res, next) {
    if (!req.params.vodId)
      return res
        .status(400)
        .json({ error: true, msg: "Missing request params" });
    if (!req.query.content_offset_seconds && !req.query.cursor)
      return res
        .status(400)
        .json({ error: true, msg: "Missing request params" });

    const vodId = req.params.vodId,
      content_offset_seconds = parseFloat(
        req.query.content_offset_seconds
      ).toFixed(1),
      cursor = req.query.cursor;

    const client = app.get("redisClient");
    let responseJson;

    if (!isNaN(content_offset_seconds) && content_offset_seconds !== null) {
      const vodData = await returnVodData(app, vodId);
      let key = `${config.channel}-${vodId}-offset-${content_offset_seconds}`;
      responseJson = await client
        .get(key)
        .then((data) => JSON.parse(data))
        .catch(() => null);

      if (!responseJson) {
        responseJson = await offsetSearch(
          app,
          vodId,
          content_offset_seconds,
          vodData
        );

        if (!responseJson)
          return res.status(500).json({
            error: true,
            msg: `Failed to retrieve comments from offset ${content_offset_seconds}`,
          });

        client.set(key, JSON.stringify(responseJson), {
          EX: 60 * 5,
        });
      }
    } else {
      let key = cursor;
      responseJson = await client
        .get(key)
        .then((data) => JSON.parse(data))
        .catch(() => null);

      if (!responseJson) {
        let cursorJson;

        try {
          cursorJson = JSON.parse(Buffer.from(key, "base64").toString());
        } catch (e) {}

        if (!cursorJson)
          return res
            .status(500)
            .json({ error: true, msg: "Failed to parse cursor" });

        responseJson = await cursorSearch(app, vodId, cursorJson);

        if (!responseJson)
          return res.status(500).json({
            error: true,
            msg: `Failed to retrieve comments from cursor ${cursor}`,
          });

        client.set(key, JSON.stringify(responseJson), {
          EX: 60 * 60 * 24 * 1,
        });
      }
    }

    return res.json(responseJson);
  };
};

const cursorSearch = async (app, vodId, cursorJson) => {
  const data = await app
    .service("logs")
    .find({
      paginate: false,
      query: {
        vod_id: vodId,
        _id: {
          $gte: cursorJson.id,
        },
        createdAt: {
          $gte: cursorJson.createdAt,
        },
        $limit: 201,
        $sort: {
          content_offset_seconds: 1,
          _id: 1,
        },
      },
    })
    .catch((e) => {
      console.error(e);
      return null;
    });

  if (!data) return null;

  if (data.length === 0) return null;

  let cursor, comments;

  if (data.length === 201) {
    cursor = Buffer.from(
      JSON.stringify({
        id: data[200]._id,
        content_offset_seconds: data[200].content_offset_seconds,
        createdAt: cursorJson.createdAt,
      })
    ).toString("base64");
  }

  comments = data.slice(0, 200);

  return { comments: comments, cursor: cursor };
};

const offsetSearch = async (app, vodId, content_offset_seconds, vodData) => {
  const startingId = await returnStartingId(app, vodId, vodData);
  if (!startingId) return null;

  const commentId = await returnCommentId(
    app,
    vodId,
    content_offset_seconds,
    vodData
  );
  if (!commentId) return null;

  let index = parseInt(commentId) - parseInt(startingId);
  index = Math.floor(index / 200) * 200;

  const searchCursor = parseInt(startingId) + index;

  const data = await app
    .service("logs")
    .find({
      paginate: false,
      query: {
        vod_id: vodId,
        _id: {
          $gte: searchCursor,
        },
        $limit: 201,
        $sort: {
          content_offset_seconds: 1,
          _id: 1,
        },
      },
    })
    .catch((e) => {
      console.error(e);
      return null;
    });

  if (!data) return null;

  if (data.length === 0) return null;

  let cursor, comments;

  if (data.length === 201) {
    cursor = Buffer.from(
      JSON.stringify({
        id: data[200]._id,
        content_offset_seconds: data[200].content_offset_seconds,
        createdAt: vodData.createdAt,
      })
    ).toString("base64");
  }

  comments = data.slice(0, 200);

  return { comments: comments, cursor: cursor };
};

const returnCommentId = async (app, vodId, content_offset_seconds, vodData) => {
  let data = await app
    .service("logs")
    .find({
      paginate: false,
      query: {
        vod_id: vodId,
        content_offset_seconds: {
          $gte: content_offset_seconds,
        },
        createdAt: {
          $gte: vodData.createdAt,
        },
        $limit: 1,
        $sort: {
          content_offset_seconds: 1,
          _id: 1,
        },
      },
    })
    .catch((e) => {
      console.error(e);
      return null;
    });

  if (!data) return null;

  if (data.length === 0) return null;

  return data[0]._id;
};

const returnStartingId = async (app, vodId, vodData) => {
  const key = `${config.channel}-${vodId}-chat-startingId`;
  const client = app.get("redisClient");
  let startingId = await client
    .get(key)
    .then((data) => data)
    .catch(() => null);

  if (!startingId) {
    let data = await app
      .service("logs")
      .find({
        paginate: false,
        query: {
          vod_id: vodId,
          $limit: 1,
          createdAt: {
            $gte: vodData.createdAt,
          },
          $sort: {
            content_offset_seconds: 1,
            _id: 1,
          },
        },
      })
      .catch(() => null);

    if (!data) return null;

    if (data.length === 0) return null;

    startingId = data[0]._id;

    client.set(key, startingId, {
      EX: 60 * 60 * 24 * 1,
    });
  }

  return startingId;
};

const returnVodData = async (app, vodId) => {
  let data = await app
    .service("vods")
    .get(vodId)
    .catch((e) => {
      console.error(e);
      return null;
    });

  if (!data) return null;

  return data;
};
