const ffmpeg = require("fluent-ffmpeg");
const readline = require("readline");

module.exports.mp4Download = async (m3u8, path) => {
  return new Promise((resolve, reject) => {
    const ffmpeg_process = ffmpeg(m3u8);
    ffmpeg_process
      .videoCodec("copy")
      .audioCodec("copy")
      .outputOptions(["-bsf:a aac_adtstoasc", "-copyts", "-start_at_zero"])
      .toFormat("mp4")
      .on("progress", (progress) => {
        if ((process.env.NODE_ENV || "").trim() !== "production") {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0, null);
          process.stdout.write(
            `DOWNLOAD PROGRESS: ${Math.round(progress.percent)}%`
          );
        }
      })
      .on("start", (cmd) => {
        console.info(`Starting m3u8 download for ${m3u8} in ${path}`);
      })
      .on("error", function (err) {
        ffmpeg_process.kill("SIGKILL");
        reject(err);
      })
      .on("end", function () {
        resolve();
      })
      .saveToFile(path);
  });
};
