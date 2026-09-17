const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const DATA_FILE = path.join(DATA_DIR, "videos.json");

// ===============================
// ADMIN PASSWORD
// ===============================

const ADMIN_PASSWORD = "VideoHub@2026#Shams";

// ===============================
// SETTINGS
// ===============================

const MAX_FILE_SIZE = 30 * 1024 * 1024 * 1024;

const allowedExtensions = new Set([
  ".mp4",
  ".webm",
  ".ogg",
  ".mov",
  ".m4v"
]);

// ===============================
// FOLDERS
// ===============================

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

// ===============================
// DATA FUNCTIONS
// ===============================

function readVideos() {
  try {
    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeVideos(videos) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(videos, null, 2),
    "utf8"
  );
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

// ===============================
// ADMIN SESSION
// ===============================

const sessions = new Map();

function getCookie(req, name) {
  const header = req.headers.cookie || "";

  const parts = header
    .split(";")
    .map(item => item.trim());

  for (const part of parts) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index);
    const value = part.slice(index + 1);

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function isAdmin(req) {
  const token = getCookie(req, "videohub_admin");

  if (!token) {
    return false;
  }

  const expiresAt = sessions.get(token);

  if (!expiresAt) {
    return false;
  }

  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Admin login required."
    });
  }

  next();
}

// ===============================
// VIDEO RESPONSE
// ===============================

function publicVideo(video, includeComments = false) {
  const result = {
    id: video.id,
    name: video.name,
    originalName: video.originalName,
    title: video.title,
    description: video.description,
    size: video.size,
    createdAt: video.createdAt,
    modified: video.modified,
    views: video.views || 0,
    likes: video.likes || 0,
    commentsCount: Array.isArray(video.comments)
      ? video.comments.length
      : 0,
    url: `/videos/${encodeURIComponent(video.name)}`
  };

  if (includeComments) {
    result.comments = Array.isArray(video.comments)
      ? [...video.comments].reverse()
      : [];
  }

  return result;
}

// ===============================
// MULTER UPLOAD
// ===============================

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {

    const extension =
      path.extname(file.originalname).toLowerCase();

    const filename =
      `${Date.now()}-${crypto.randomBytes(10).toString("hex")}${extension}`;

    cb(null, filename);
  }
});

const upload = multer({

  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: (req, file, cb) => {

    const extension =
      path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.has(extension)) {

      return cb(
        new Error(
          "Unsupported video format. Use MP4, WebM, OGG, MOV or M4V."
        )
      );
    }

    cb(null, true);
  }
});

// ===============================
// MIDDLEWARE
// ===============================

app.use(express.json({
  limit: "1mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "1mb"
}));

// ===============================
// HEALTH
// ===============================

app.get("/api/health", (req, res) => {

  res.json({
    ok: true,
    service: "VideoHub"
  });

});

// ===============================
// ADMIN STATUS
// ===============================

app.get("/api/admin/status", (req, res) => {

  res.json({
    loggedIn: isAdmin(req)
  });

});

// ===============================
// ADMIN LOGIN
// ===============================

app.post("/api/admin/login", (req, res) => {

  const password =
    String(req.body?.password || "");

  if (password !== ADMIN_PASSWORD) {

    return res.status(401).json({
      error: "Incorrect password."
    });

  }

  const token =
    crypto.randomBytes(32).toString("hex");

  const expiresAt =
    Date.now() + 12 * 60 * 60 * 1000;

  sessions.set(token, expiresAt);

  const secure =
    req.headers["x-forwarded-proto"] === "https"
      ? "; Secure"
      : "";

  res.setHeader(
    "Set-Cookie",
    `videohub_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`
  );

  res.json({
    ok: true
  });

});

// ===============================
// ADMIN LOGOUT
// ===============================

app.post("/api/admin/logout", (req, res) => {

  const token =
    getCookie(req, "videohub_admin");

  if (token) {
    sessions.delete(token);
  }

  res.setHeader(
    "Set-Cookie",
    "videohub_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
  );

  res.json({
    ok: true
  });

});

// ===============================
// GET VIDEOS
// ===============================

app.get("/api/videos", (req, res) => {

  const videos = readVideos()
    .filter(video => {

      return fs.existsSync(
        path.join(UPLOAD_DIR, video.name)
      );

    })
    .sort((a, b) => {

      return (
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime()
      );

    })
    .map(video => publicVideo(video));

  res.json(videos);

});

// ===============================
// GET SINGLE VIDEO
// ===============================

app.get("/api/videos/:id", (req, res) => {

  const videos = readVideos();

  const video =
    videos.find(
      item => item.id === req.params.id
    );

  if (!video) {

    return res.status(404).json({
      error: "Video not found."
    });

  }

  const filePath =
    path.join(UPLOAD_DIR, video.name);

  if (!fs.existsSync(filePath)) {

    return res.status(404).json({
      error: "Video file is missing."
    });

  }

  res.json(
    publicVideo(video, true)
  );

});

// ===============================
// VIDEO VIEW
// ===============================

app.post("/api/videos/:id/view", (req, res) => {

  const videos = readVideos();

  const index =
    videos.findIndex(
      item => item.id === req.params.id
    );

  if (index === -1) {

    return res.status(404).json({
      error: "Video not found."
    });

  }

  videos[index].views =
    Number(videos[index].views || 0) + 1;

  videos[index].modified =
    new Date().toISOString();

  writeVideos(videos);

  res.json({
    video: publicVideo(videos[index])
  });

});

// ===============================
// LIKE
// ===============================

app.post("/api/videos/:id/like", (req, res) => {

  const action =
    req.body?.action === "unlike"
      ? "unlike"
      : "like";

  const videos = readVideos();

  const index =
    videos.findIndex(
      item => item.id === req.params.id
    );

  if (index === -1) {

    return res.status(404).json({
      error: "Video not found."
    });

  }

  videos[index].likes =
    Number(videos[index].likes || 0);

  if (action === "unlike") {

    videos[index].likes =
      Math.max(
        0,
        videos[index].likes - 1
      );

  } else {

    videos[index].likes += 1;

  }

  videos[index].modified =
    new Date().toISOString();

  writeVideos(videos);

  res.json({
    video: publicVideo(videos[index])
  });

});

// ===============================
// COMMENTS
// ===============================

app.get("/api/videos/:id/comments", (req, res) => {

  const videos = readVideos();

  const video =
    videos.find(
      item => item.id === req.params.id
    );

  if (!video) {

    return res.status(404).json({
      error: "Video not found."
    });

  }

  res.json({
    comments: Array.isArray(video.comments)
      ? [...video.comments].reverse()
      : []
  });

});

app.post("/api/videos/:id/comments", (req, res) => {

  const name =
    String(req.body?.name || "")
      .trim()
      .slice(0, 50);

  const text =
    String(req.body?.text || "")
      .trim()
      .slice(0, 500);

  if (!name || !text) {

    return res.status(400).json({
      error: "Name and comment are required."
    });

  }

  const videos = readVideos();

  const index =
    videos.findIndex(
      item => item.id === req.params.id
    );

  if (index === -1) {

    return res.status(404).json({
      error: "Video not found."
    });

  }

  if (!Array.isArray(videos[index].comments)) {
    videos[index].comments = [];
  }

  videos[index].comments.push({

    id: makeId(),

    name,

    text,

    createdAt:
      new Date().toISOString()

  });

  videos[index].modified =
    new Date().toISOString();

  writeVideos(videos);

  res.json({
    comments:
      [...videos[index].comments].reverse()
  });

});

// ===============================
// UPLOAD VIDEO
// ===============================

app.post(
  "/api/upload",
  requireAdmin,
  upload.single("video"),
  (req, res) => {

    if (!req.file) {

      return res.status(400).json({
        error: "No video selected."
      });

    }

    const title =
      String(req.body?.title || "")
        .trim()
        .slice(0, 200)
        ||
      path.parse(req.file.originalname).name;

    const description =
      String(req.body?.description || "")
        .trim()
        .slice(0, 2000);

    const videos =
      readVideos();

    const video = {

      id: makeId(),

      name: req.file.filename,

      originalName:
        req.file.originalname,

      title,

      description,

      size:
        req.file.size,

      createdAt:
        new Date().toISOString(),

      modified:
        new Date().toISOString(),

      views: 0,

      likes: 0,

      comments: []

    };

    videos.push(video);

    writeVideos(videos);

    res.status(201).json({

      message:
        "Video uploaded successfully.",

      video:
        publicVideo(video)

    });

  }
);

// ===============================
// EDIT VIDEO
// ===============================

app.put(
  "/api/videos/:id",
  requireAdmin,
  (req, res) => {

    const title =
      String(req.body?.title || "")
        .trim()
        .slice(0, 200);

    const description =
      String(req.body?.description || "")
        .trim()
        .slice(0, 2000);

    if (!title) {

      return res.status(400).json({
        error: "Title is required."
      });

    }

    const videos =
      readVideos();

    const index =
      videos.findIndex(
        item => item.id === req.params.id
      );

    if (index === -1) {

      return res.status(404).json({
        error: "Video not found."
      });

    }

    videos[index].title =
      title;

    videos[index].description =
      description;

    videos[index].modified =
      new Date().toISOString();

    writeVideos(videos);

    res.json({
      video:
        publicVideo(videos[index])
    });

  }
);

// ===============================
// DELETE VIDEO
// ===============================

app.delete(
  "/api/videos/:id",
  requireAdmin,
  (req, res) => {

    const videos =
      readVideos();

    const index =
      videos.findIndex(
        item => item.id === req.params.id
      );

    if (index === -1) {

      return res.status(404).json({
        error: "Video not found."
      });

    }

    const video =
      videos[index];

    const filePath =
      path.join(
        UPLOAD_DIR,
        video.name
      );

    try {

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      videos.splice(index, 1);

      writeVideos(videos);

      res.json({
        ok: true
      });

    } catch {

      res.status(500).json({
        error: "Could not delete video."
      });

    }

  }
);

// ===============================
// DOWNLOAD
// ===============================

app.get(
  "/api/videos/:id/download",
  (req, res) => {

    const videos =
      readVideos();

    const video =
      videos.find(
        item => item.id === req.params.id
      );

    if (!video) {

      return res.status(404).json({
        error: "Video not found."
      });

    }

    const filePath =
      path.join(
        UPLOAD_DIR,
        video.name
      );

    if (!fs.existsSync(filePath)) {

      return res.status(404).json({
        error: "Video file is missing."
      });

    }

    const downloadName =
      path.basename(
        video.originalName || video.name
      );

    res.download(
      filePath,
      downloadName
    );

  }
);

// ===============================
// VIDEO FILES
// ===============================

app.use(
  "/videos",
  express.static(UPLOAD_DIR)
);

// ===============================
// WEBSITE
// ===============================

app.use(
  express.static(PUBLIC_DIR)
);

app.get(
  "*splat",
  (req, res) => {

    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "index.html"
      )
    );

  }
);

// ===============================
// ERROR HANDLER
// ===============================

app.use(
  (err, req, res, next) => {

    if (err instanceof multer.MulterError) {

      if (
        err.code === "LIMIT_FILE_SIZE"
      ) {

        return res.status(400).json({
          error:
            "Video is larger than 30 GB."
        });

      }

      return res.status(400).json({
        error: err.message
      });

    }

    if (err) {

      return res.status(400).json({
        error:
          err.message ||
          "Request failed."
      });

    }

    next();

  }
);

// ===============================
// START SERVER
// ===============================

app.listen(
  PORT,
  () => {

    console.log(
      `VideoHub running on port ${PORT}`
    );

  }
);
