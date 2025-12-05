const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const ytdl = require("ytdl-core");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { exec } = require("child_process");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");

// Konfigurasi FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// Buat folder downloads jika belum ada
if (!fs.existsSync("downloads")) {
  fs.mkdirSync("downloads");
}

// Storage untuk file yang diupload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "downloads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

// Endpoint untuk mendapatkan info video YouTube
app.post("/api/youtube/info", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL diperlukan" });
    }

    const info = await ytdl.getInfo(url);

    const formats = info.formats
      .filter((format) => format.hasAudio || format.hasVideo)
      .map((format) => ({
        quality: format.qualityLabel || format.quality,
        container: format.container,
        hasVideo: format.hasVideo,
        hasAudio: format.hasAudio,
        itag: format.itag,
        contentLength: format.contentLength,
        bitrate: format.bitrate,
        fps: format.fps,
      }));

    res.json({
      title: info.videoDetails.title,
      duration: info.videoDetails.lengthSeconds,
      thumbnail:
        info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]
          .url,
      formats: formats,
      author: info.videoDetails.author.name,
      viewCount: info.videoDetails.viewCount,
    });
  } catch (error) {
    console.error("Error getting YouTube info:", error);
    res.status(500).json({ error: "Gagal mendapatkan info video" });
  }
});

// Endpoint untuk download video YouTube
app.get("/api/youtube/download", async (req, res) => {
  try {
    const { url, itag, format = "mp4" } = req.query;

    if (!url) {
      return res.status(400).json({ error: "URL diperlukan" });
    }

    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^^\w\s]/gi, "");
    const filename = `${title}.${format}`;
    const filepath = path.join(__dirname, "downloads", filename);

    // Set header untuk streaming
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    if (format === "mp3") {
      // Download sebagai MP3
      const videoStream = ytdl(url, { quality: "highestaudio" });

      ffmpeg(videoStream)
        .audioBitrate(128)
        .format("mp3")
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          res.status(500).end();
        })
        .pipe(res, { end: true });
    } else {
      // Download sebagai video
      const videoStream = ytdl(url, {
        quality: itag || "highest",
        filter: format === "mp4" ? "audioandvideo" : "audioonly",
      });

      videoStream.pipe(res);
    }
  } catch (error) {
    console.error("Error downloading YouTube video:", error);
    res.status(500).json({ error: "Gagal mendownload video" });
  }
});

// Endpoint untuk download file umum
app.get("/api/download", async (req, res) => {
  try {
    const { url, filename } = req.query;

    if (!url) {
      return res.status(400).json({ error: "URL diperlukan" });
    }

    // Fetch file dari URL
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Dapatkan content type dan content length
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const contentLength = response.headers.get("content-length");
    const finalFilename =
      filename || path.basename(new URL(url).pathname) || "download";

    // Set headers
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(finalFilename)}"`
    );

    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    // Stream response
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      res.write(value);
    }

    res.end();
  } catch (error) {
    console.error("Error downloading file:", error);
    res.status(500).json({ error: "Gagal mendownload file" });
  }
});

// Endpoint untuk upload file
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Tidak ada file yang diupload" });
    }

    res.json({
      message: "File berhasil diupload",
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      path: `/downloads/${req.file.filename}`,
    });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({ error: "Gagal mengupload file" });
  }
});

// Endpoint untuk mendapatkan list file yang sudah didownload
app.get("/api/files", (req, res) => {
  try {
    const files = fs
      .readdirSync("downloads")
      .map((file) => {
        const stat = fs.statSync(path.join("downloads", file));
        return {
          name: file,
          size: stat.size,
          created: stat.birthtime,
          path: `/downloads/${file}`,
        };
      })
      .filter((file) => file.size > 0); // Hanya file dengan ukuran > 0

    res.json(files);
  } catch (error) {
    console.error("Error reading files:", error);
    res.status(500).json({ error: "Gagal membaca file" });
  }
});

// Endpoint untuk menghapus file
app.delete("/api/files/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const filepath = path.join(__dirname, "downloads", filename);

    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      res.json({ message: "File berhasil dihapus" });
    } else {
      res.status(404).json({ error: "File tidak ditemukan" });
    }
  } catch (error) {
    console.error("Error deleting file:", error);
    res.status(500).json({ error: "Gagal menghapus file" });
  }
});

// Endpoint untuk mengukur kecepatan download
app.get("/api/speedtest", async (req, res) => {
  try {
    const testFileUrl = "https://speed.hetzner.de/100MB.bin";
    const response = await fetch(testFileUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = parseInt(response.headers.get("content-length"), 10);
    let downloadedBytes = 0;
    const startTime = Date.now();

    const reader = response.body.getReader();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Transfer-Encoding", "chunked");

    // Stream data dan kirim update kecepatan
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      downloadedBytes += value.length;
      const elapsedTime = (Date.now() - startTime) / 1000; // dalam detik
      const speed = downloadedBytes / elapsedTime / (1024 * 1024); // MB/s

      // Kirim update kecepatan sebagai JSON stream
      res.write(
        JSON.stringify({
          bytes: downloadedBytes,
          total: contentLength,
          speed: speed,
          elapsed: elapsedTime,
          percent: (downloadedBytes / contentLength) * 100,
        }) + "\n"
      );
    }

    res.end();
  } catch (error) {
    console.error("Speed test error:", error);
    res.status(500).json({ error: "Gagal melakukan speed test" });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Server static files dari frontend (opsional)
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log(`API endpoints tersedia di http://localhost:${PORT}/api`);
});
