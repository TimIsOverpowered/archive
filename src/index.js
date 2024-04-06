/* eslint-disable no-console */
const logger = require("./logger");
const app = require("./app");
const port = app.get("port");
const os = require("os");
const cluster = require("cluster");
const clusterWorkerSize = os.cpus().length;
const { checkTwitch, checkKick, testChapters } = require("./check");
const config = require("../config/config.json");

process.on("unhandledRejection", (reason, p) => {
  logger.error("Unhandled Rejection at: Promise ", p, reason);
  console.error("Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

const start = () => {
  app.listen(port).then(() => {
    logger.info(
      "Feathers application started on http://%s:%d and worker %s",
      app.get("host"),
      port,
      process.pid
    );
  });
};

if (clusterWorkerSize > 1 && process.env.NODE_ENV === "production") {
  if (!cluster.isMaster) return start();
  for (let i = 0; i < clusterWorkerSize; i++) {
    cluster.fork();
  }

  cluster.on("exit", function (worker, code, signal) {
    console.log("Worker", worker.id, "has exited with signal", signal);
    if (code !== 0 && !worker.exitedAfterDisconnect) {
      cluster.fork();
    }
  });

  if (config.twitch.enabled) checkTwitch(app);
  if (config.kick.enabled) checkKick(app);
} else {
  if (config.twitch.enabled) checkTwitch(app);
  if (config.kick.enabled) checkKick(app);
  start();
}
