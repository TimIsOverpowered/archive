/* eslint-disable no-console */
const logger = require("./logger");
const app = require("./app");
const port = app.get("port");
const os = require("os");
const cluster = require("cluster");
const clusterWorkerSize = os.cpus().length;
const { check } = require("./check");

process.on("unhandledRejection", (reason, p) => {
  logger.error("Unhandled Rejection at: Promise ", p, reason);
  console.error("Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

const start = () => {
  const server = app.listen(port);
  server.on("listening", () =>
    logger.info(
      "Feathers application started on http://%s:%d and worker %s",
      app.get("host"),
      port,
      process.pid
    )
  );
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

  check(app);
} else {
  check(app);
  start();
}
