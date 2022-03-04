const vods = require('./vods/vods.service.js');
const logs = require('./logs/logs.service.js');
const emotes = require('./emotes/emotes.service.js');
// eslint-disable-next-line no-unused-vars
module.exports = function (app) {
  app.configure(vods);
  app.configure(logs);
  app.configure(emotes);
};
