/* eslint-disable no-console */
const logger = require("./logger");
const app = require("./app");
const port = app.get("port");
const host = app.get("host");
const { checkTwitch, checkKick } = require("./check");
const { initialize } = require("./middleware/kick");
const config = require("../config/config.json");

process.on("unhandledRejection", (reason, p) => {
  logger.error("Unhandled Rejection at: Promise ", p, reason);
  console.error("Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

app.listen(port).then(async () => {
  logger.info(`Feathers app listening on http://${host}:${port}`);
  if (config.twitch.enabled) checkTwitch(app);
  if (config.kick.enabled) {
    let { connect } = await import("puppeteer-real-browser");
    const { page, browser, setTarget } = await connect({
      headless: "auto",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      fingerprint: true,
      turnstile: true,
      tf: true,
    });
    page.setDefaultNavigationTimeout(5 * 60 * 1000)
    setTarget({ status: false })
    app.set("puppeteer", browser);
    await initialize(app, config.kick.username);
    checkKick(app);
  }
});
