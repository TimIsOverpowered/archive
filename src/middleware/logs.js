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
            cursor = Buffer.from(
              JSON.stringify({
                id: data[100]._id,
                content_offset_seconds: data[100].content_offset_seconds,
              })
            ).toString("base64");
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

    let json;

    try {
      json = JSON.parse(Buffer.from(req.query.cursor, "base64").toString());
    } catch (e) {
      console.error(`Cursor was: ${req.query.cursor}`);
      console.error(Buffer.from(req.query.cursor, "base64").toString());
    }

    if (!json)
      return res
        .status(500)
        .json({ error: true, msg: "Failed to parse cursor" });

    await app
      .service("logs")
      .find({
        paginate: false,
        query: {
          vod_id: vodId,
          _id: {
            $gte: json.id,
          },
          content_offset_seconds: {
            $gte: json.content_offset_seconds,
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
          cursor = Buffer.from(
            JSON.stringify({
              id: data[100]._id,
              content_offset_seconds: data[100].content_offset_seconds,
            })
          ).toString("base64");
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
