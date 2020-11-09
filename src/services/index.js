const vods = require('./vods/vods.service.js');
// eslint-disable-next-line no-unused-vars
module.exports = function (app) {
  app.configure(vods);
};
