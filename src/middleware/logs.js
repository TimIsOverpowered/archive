const config = require('../../config/config.json');

const PAGE_SIZE = 200;
const CURSOR_TTL = 60 * 60 * 24;
const OFFSET_TTL = 60 * 5;

module.exports = function (app) {
  return async function (req, res, next) {
    if (!req.params.vodId) return res.status(400).json({ error: true, msg: 'Missing request params' });
    if (!req.query.content_offset_seconds && !req.query.cursor) return res.status(400).json({ error: true, msg: 'Missing request params' });

    const vodId = req.params.vodId;
    const cursor = req.query.cursor;
    const content_offset_seconds = parseFloat(req.query.content_offset_seconds);

    const client = app.get('redisClient');
    let responseJson;

    if (!cursor && isFinite(content_offset_seconds)) {
      const key = `${config.channel}-${vodId}-offset-${content_offset_seconds}`;
      responseJson = await client
        .get(key)
        .then((data) => JSON.parse(data))
        .catch(() => null);

      if (!responseJson) {
        responseJson = await offsetSearch(app, vodId, content_offset_seconds);

        if (!responseJson)
          return res.status(500).json({
            error: true,
            msg: `Failed to retrieve comments from offset ${content_offset_seconds}`,
          });

        client.set(key, JSON.stringify(responseJson), { EX: OFFSET_TTL });
      }
    } else {
      responseJson = await client
        .get(cursor)
        .then((data) => JSON.parse(data))
        .catch(() => null);

      if (!responseJson) {
        let cursorJson;
        try {
          cursorJson = JSON.parse(Buffer.from(cursor, 'base64').toString());
        } catch (e) {}

        if (!cursorJson?.offset || !cursorJson?.id || typeof cursorJson.offset !== 'number') return res.status(400).json({ error: true, msg: 'Invalid cursor' });

        responseJson = await cursorSearch(app, vodId, cursorJson);

        if (!responseJson)
          return res.status(500).json({
            error: true,
            msg: `Failed to retrieve comments from cursor ${cursor}`,
          });

        client.set(cursor, JSON.stringify(responseJson), { EX: CURSOR_TTL });
      }
    }

    return res.json(responseJson);
  };
};

const cursorSearch = async (app, vodId, cursorJson) => {
  const data = await app
    .service('logs')
    .find({
      paginate: false,
      query: {
        vod_id: vodId,
        $or: [{ content_offset_seconds: { $gt: cursorJson.offset } }, { content_offset_seconds: cursorJson.offset, id: { $gte: cursorJson.id } }],
        $limit: PAGE_SIZE + 1,
        $sort: { content_offset_seconds: 1, id: 1 },
      },
    })
    .catch((e) => {
      console.error(e);
      return null;
    });

  if (!data || data.length === 0) return null;

  const comments = data.slice(0, PAGE_SIZE);
  const cursor =
    data.length === PAGE_SIZE + 1
      ? Buffer.from(
          JSON.stringify({
            offset: data[PAGE_SIZE].content_offset_seconds,
            id: data[PAGE_SIZE].id,
          }),
        ).toString('base64')
      : undefined;

  return { comments, cursor };
};

const offsetSearch = async (app, vodId, content_offset_seconds) => {
  const data = await app
    .service('logs')
    .find({
      paginate: false,
      query: {
        vod_id: vodId,
        content_offset_seconds: { $gte: content_offset_seconds },
        $limit: PAGE_SIZE + 1,
        $sort: { content_offset_seconds: 1, id: 1 },
      },
    })
    .catch((e) => {
      console.error(e);
      return null;
    });

  if (!data || data.length === 0) return null;

  const comments = data.slice(0, PAGE_SIZE);
  const cursor =
    data.length === PAGE_SIZE + 1
      ? Buffer.from(
          JSON.stringify({
            offset: data[PAGE_SIZE].content_offset_seconds,
            id: data[PAGE_SIZE].id,
          }),
        ).toString('base64')
      : undefined;

  return { comments, cursor };
};
