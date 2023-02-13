const vods = require('./vods/vods.service.js');
const logs = require('./logs/logs.service.js');
const emotes = require('./emotes/emotes.service.js');
const games = require('./games/games.service.js');
const streams = require('./streams/streams.service.js');
// eslint-disable-next-line no-unused-vars
module.exports = function (app) {
  app.configure(vods);
  app.configure(logs);
  app.configure(emotes);
  app.configure(games);
  app.configure(streams);
};
