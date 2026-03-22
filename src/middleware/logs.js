const config = require('../../config/config.json');
const { QueryTypes } = require('sequelize');

const PAGE_SIZE = 200;
const BUCKET_SIZE = 120;
const CURSOR_TTL = 60 * 60 * 24 * 7;
const OFFSET_TTL = 60 * 60 * 24 * 7;
const TARGET_COMMENTS_PER_BUCKET = 300;
const BOUNDARIES = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600];

const computeBucketSize = (commentsPer100s) => {
  const raw = (TARGET_COMMENTS_PER_BUCKET / commentsPer100s) * 100;
  return BOUNDARIES.reduce((prev, curr) => (Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev));
};

const getVodBucketSize = async (app, vodId) => {
  const client = app.get('redisClient');
  const key = `${config.channel}-${vodId}-bucketSize`;

  const cached = await client.get(key).catch(() => null);
  if (cached) return parseInt(cached);

  const result = await app.get('sequelizeClient').query(
    `
    SELECT 
      COUNT(*) / NULLIF((MAX(content_offset_seconds) - MIN(content_offset_seconds)), 0) * 100 AS comments_per_100s
    FROM logs
    WHERE vod_id = :vodId
  `,
    { replacements: { vodId }, type: QueryTypes.SELECT },
  );

  if (!result?.[0]?.comments_per_100s) return BUCKET_SIZE; // fallback to static

  const commentsPer100s = parseFloat(result[0].comments_per_100s);
  const bucketSize = computeBucketSize(commentsPer100s);

  client.set(key, bucketSize); // no TTL, permanent
  return bucketSize;
};

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
      const bucketSize = await getVodBucketSize(app, vodId);
      const bucket = Math.floor(content_offset_seconds / bucketSize) * bucketSize;
      const key = `${config.channel}-${vodId}-bucket-${bucket}`;

      responseJson = await client
        .get(key)
        .then((data) => JSON.parse(data))
        .catch(() => null);

      if (!responseJson) {
        responseJson = await offsetSearch(app, vodId, bucket);

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

        if (!cursorJson?.offset || !cursorJson?.id) return res.status(400).json({ error: true, msg: 'Invalid cursor' });

        cursorJson.offset = parseFloat(cursorJson.offset);

        if (!isFinite(cursorJson.offset)) return res.status(400).json({ error: true, msg: 'Invalid cursor' });

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
            offset: parseFloat(data[PAGE_SIZE].content_offset_seconds),
            id: data[PAGE_SIZE].id,
          }),
        ).toString('base64')
      : undefined;

  return { comments, cursor };
};

const offsetSearch = async (app, vodId, bucket) => {
  const data = await app
    .service('logs')
    .find({
      paginate: false,
      query: {
        vod_id: vodId,
        content_offset_seconds: { $gte: bucket },
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
            offset: parseFloat(data[PAGE_SIZE].content_offset_seconds),
            id: data[PAGE_SIZE].id,
          }),
        ).toString('base64')
      : undefined;

  return { comments, cursor };
};
