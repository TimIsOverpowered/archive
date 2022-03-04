module.exports = function (app) {
  return async function (req, res, next) {
    if (req.body.search === null) return res.status(400).json({ error: true, msg: "Missing request params" });

    const search = req.body.search;
    const results = await app
      .service("vods")
      .find({
        query: {
          $or: [{ title: { $iLike: `%${search}%` } }, { date: { $iLike: `%${search}%` } }],
          $sort: {
            createdAt: -1,
          },
        },
      })
      .catch((e) => {
        console.error(e);
        return null;
      });

    if (!results) return res.status(500).json({ error: true, msg: "Failed to get search results" });
    res.json(results);
  };
};
