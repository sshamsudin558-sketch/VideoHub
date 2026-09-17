const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/videos", (_, res) => {
  const videos = fs.readdirSync(UPLOAD_DIR)
    .filter(name => /\.(mp4|webm|ogg|mov|m4v)$/i.test(name))
    .map(name => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, name));
      return {
        name,
        url: `/videos/${encodeURIComponent(name)}`,
        size: stat.size,
        modified: stat.mtime
      };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));

  res.json(videos);
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video selected." });
  res.json({
    message: "Video uploaded successfully.",
    video: {
      name: req.file.filename,
      url: `/videos/${encodeURIComponent(req.file.filename)}`
    }
  });
});

app.use("/videos", express.static(UPLOAD_DIR));

app.get("*splat", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Modern Video Hub running on port ${PORT}`);
});