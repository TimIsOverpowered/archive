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

    await app
      .service("logs")
      .find({
        paginate: false,
        query: {
          vod_id: vodId,
          content_offset_seconds: {
            $gte: content_offset_seconds
              ? content_offset_seconds
              : Buffer.from(req.query.cursor, "base64").toString("ascii"),
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
          cursor = Buffer.from(data[100].content_offset_seconds.toString()).toString("base64");
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
