const redis = require("redis").createClient({ return_buffers: true });
const util = require("util");
const asyncRedisGet = util.promisify(redis.get).bind(redis);
const cppzst = require("cppzst");
const decompress = util.promisify(cppzst.decompress);
const compress = util.promisify(cppzst.compress);

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
      content_offset_seconds = req.query.content_offset_seconds;

    let cursor = null,
      logs;

    if (content_offset_seconds) {
      await app
        .service("logs")
        .find({
          paginate: false,
          query: {
            vod_id: vodId,
            content_offset_seconds: {
              $gte: content_offset_seconds,
            },
            $limit: 101,
            $sort: {
              content_offset_seconds: 1,
            },
          },
        })
        .then((data) => {
          if (data.length === 0) return;
          if (data.length === 101) {
            cursor = Buffer.from(data[100]._id).toString("base64");
          }
          logs = data.slice(0, 100);
        })
        .catch((e) => {
          console.error(e);
        });

      if (!logs) {
        return res.status(500).json({
          error: true,
          msg: "Failed to retrieve logs from the database",
        });
      }

      return res.json({
        comments: logs,
        cursor: cursor,
      });
    }

    const _id = parseInt(Buffer.from(req.query.cursor, "base64").toString("ascii"));

    if (isNaN(_id))
      return res.status(400).json({
        error: true,
        msg: "Cursor broken..",
      });

    await app
      .service("logs")
      .find({
        paginate: false,
        query: {
          vod_id: vodId,
          _id: {
            $gte: _id,
          },
          $limit: 101,
          $sort: {
            content_offset_seconds: 1,
          },
        },
      })
      .then((data) => {
        if (data.length === 0) return;
        if (data.length === 101) {
          cursor = Buffer.from(data[100]._id).toString("base64");
        }
        logs = data.slice(0, 100);
      })
      .catch((e) => {
        console.error(e);
      });

    if (!logs) {
      return res.status(500).json({
        error: true,
        msg: "Failed to retrieve logs from the database",
      });
    }

    return res.json({
      comments: logs,
      cursor: cursor,
    });
  };
};

module.exports.v2 = function (app) {
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
      content_offset_seconds = parseFloat(req.query.content_offset_seconds);

    let cursor = null,
      logs,
      comments;

    if (req.query.cursor) {
      let dataJson;
      await asyncRedisGet(`${req.params.vodId}-${req.query.cursor}`)
        .then(async (data) => {
          if (!data) return;
          data = await decompress(data);
          dataJson = JSON.parse(data);
        })
        .catch((e) => {
          console.error(e);
        });
      if (dataJson) return res.json(dataJson);
    }

    await asyncRedisGet(`${req.params.vodId}-logs`)
      .then(async (data) => {
        if (!data) return;
        data = await decompress(data);
        logs = JSON.parse(data);
      })
      .catch((e) => {
        console.error(e);
      });

    if (!logs) {
      await app
        .service("logs")
        .find({
          paginate: false,
          query: {
            vod_id: vodId,
            $sort: {
              content_offset_seconds: 1,
            },
          },
        })
        .then((data) => {
          if (data.length === 0) return;
          logs = data;
        })
        .catch((e) => {
          console.error(e);
        });
      if (!logs) {
        return res.status(500).json({
          error: true,
          msg: "Failed to retrieve logs from the database",
        });
      }
      redis.set(
        `${req.params.vodId}-logs`,
        await compress(Buffer.from(JSON.stringify(logs), "utf-8")),
        "EX",
        3600
      );
    }

    if (req.query.cursor) {
      const cursorData = JSON.parse(
        Buffer.from(req.query.cursor, "base64").toString("ascii")
      );

      comments = logs.slice(cursorData.index, cursorData.index + 100);
      const nextComment = logs[cursorData.index + 100];
      if (nextComment) {
        cursor = Buffer.from(
          JSON.stringify({
            id: nextComment.id,
            content_offset_seconds: nextComment.content_offset_seconds,
            index: cursorData.index + 100,
          })
        ).toString("base64");
      }

      const response = {
        comments: comments,
        cursor: cursor,
      };

      redis.set(
        `${req.params.vodId}-${req.query.cursor}`,
        await compress(Buffer.from(JSON.stringify(response), "utf-8")),
        "EX",
        3600
      );

      return res.json(response);
    }

    let pastIndex = logs.findIndex(
      (comment) => comment.content_offset_seconds > content_offset_seconds
    );
    pastIndex = Math.floor(pastIndex / 100) * 100;
    comments = logs.slice(pastIndex, pastIndex + 100);
    const nextComment = logs[pastIndex + 100];
    if (nextComment) {
      cursor = Buffer.from(
        JSON.stringify({
          id: nextComment.id,
          content_offset_seconds: nextComment.content_offset_seconds,
          index: pastIndex + 100,
        })
      ).toString("base64");
    }

    return res.json({
      comments: comments,
      cursor: cursor,
    });
  };
};
