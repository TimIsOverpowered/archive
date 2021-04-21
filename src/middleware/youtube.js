const config = require("../../config/config.json");
const { google } = require("googleapis");
const moment = require("moment");

const youtube = google.youtube({
  version: "v3",
  auth: config.youtube_api_key,
});

module.exports.getDuration = async (id) => {
  const response = await youtube.videos.list({
    part: "contentDetails",
    id: [id],
  });

  const item = response.data.items[0];
  if (!item) return null;

  return moment.duration(item.contentDetails.duration).asSeconds();
};
