const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(UPLOAD_DIR, "videos.json");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "CHANGE_THIS_PASSWORD";

const MAX_FILE_SIZE = 30 * 1024 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readVideos() {
  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");
    const videos = JSON.parse(data);

    if (!Array.isArray(videos)) {
      return [];
    }

    return videos;
  } catch {
    return [];
  }
}

function saveVideos(videos) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(videos, null, 2),
    "utf8"
  );
}

function createId() {
  return crypto.randomBytes(12).toString("hex");
}

function safeText(value, maxLength = 5000) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function safeFileName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function getFilePath(video) {
  return path.join(UPLOAD_DIR, video.filename);
}

function isAdmin(req) {
  const token = req.headers["x-admin-token"];

  if (!token) {
    return false;
  }

  return adminSessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Admin login required."
    });
  }

  next();
}

const adminSessions = new Set();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const original = safeFileName(file.originalname);
    const uniqueName = `${Date.now()}-${createId()}-${original}`;

    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: (req, file, cb) => {
    const allowedExtensions =
      /\.(mp4|webm|ogg|mov|m4v|avi|mkv)$/i;

    const allowedMime =
      /^video\//i.test(file.mimetype);

    if (allowedExtensions.test(file.originalname) || allowedMime) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed."));
    }
  }
});

app.use(express.json({ limit: "2mb" }));

app.use(express.static(PUBLIC_DIR));

/*
--------------------------------------------------
ADMIN LOGIN
--------------------------------------------------
*/

app.post("/api/admin/login", (req, res) => {
  const password = safeText(req.body.password, 500);

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Incorrect admin password."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  adminSessions.add(token);

  res.json({
    success: true,
    token
  });
});

app.post("/api/admin/logout", (req, res) => {
  const token = req.headers["x-admin-token"];

  if (token) {
    adminSessions.delete(token);
  }

  res.json({
    success: true
  });
});

app.get("/api/admin/status", (req, res) => {
  res.json({
    loggedIn: isAdmin(req)
  });
});

/*
--------------------------------------------------
GET ALL VIDEOS
--------------------------------------------------
*/

app.get("/api/videos", (req, res) => {
  const videos = readVideos();

  const existingVideos = videos.filter((video) => {
    return fs.existsSync(getFilePath(video));
  });

  if (existingVideos.length !== videos.length) {
    saveVideos(existingVideos);
  }

  const result = existingVideos
    .map((video) => ({
      ...video,
      url: `/videos/${encodeURIComponent(video.filename)}`,
      downloadUrl: `/api/videos/${video.id}/download`
    }))
    .sort(
      (a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
    );

  res.json(result);
});

/*
--------------------------------------------------
GET SINGLE VIDEO
--------------------------------------------------
*/

app.get("/api/videos/:id", (req, res) => {
  const videos = readVideos();

  const video = videos.find(
    (item) => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  res.json({
    ...video,
    url: `/videos/${encodeURIComponent(video.filename)}`,
    downloadUrl: `/api/videos/${video.id}/download`
  });
});

/*
--------------------------------------------------
UPLOAD VIDEO
--------------------------------------------------
*/

app.post(
  "/api/upload",
  requireAdmin,
  (req, res, next) => {
    upload.single("video")(req, res, (error) => {
      if (error) {
        if (error instanceof multer.MulterError) {
          if (error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
              error: "Video is larger than the 30GB limit."
            });
          }
        }

        return res.status(400).json({
          error: error.message || "Upload failed."
        });
      }

      next();
    });
  },

  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Please select a video."
      });
    }

    const title =
      safeText(req.body.title, 200) ||
      path.parse(req.file.originalname).name;

    const description =
      safeText(req.body.description, 3000);

    const video = {
      id: createId(),

      filename: req.file.filename,

      originalName: req.file.originalname,

      title,

      description,

      size: req.file.size,

      mimeType: req.file.mimetype,

      views: 0,

      likes: 0,

      comments: [],

      createdAt: new Date().toISOString()
    };

    const videos = readVideos();

    videos.push(video);

    saveVideos(videos);

    res.status(201).json({
      success: true,

      message: "Video uploaded successfully.",

      video: {
        ...video,
        url: `/videos/${encodeURIComponent(
          video.filename
        )}`,
        downloadUrl: `/api/videos/${video.id}/download`
      }
    });
  }
);

/*
--------------------------------------------------
VIEW COUNTER
--------------------------------------------------
*/

app.post("/api/videos/:id/view", (req, res) => {
  const videos = readVideos();

  const video = videos.find(
    (item) => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  video.views = Number(video.views || 0) + 1;

  saveVideos(videos);

  res.json({
    success: true,
    views: video.views
  });
});

/*
--------------------------------------------------
LIKE
--------------------------------------------------
*/

app.post("/api/videos/:id/like", (req, res) => {
  const videos = readVideos();

  const video = videos.find(
    (item) => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  video.likes = Number(video.likes || 0) + 1;

  saveVideos(videos);

  res.json({
    success: true,
    likes: video.likes
  });
});

/*
--------------------------------------------------
COMMENTS
--------------------------------------------------
*/

app.post("/api/videos/:id/comments", (req, res) => {
  const name =
    safeText(req.body.name, 80) || "Visitor";

  const text =
    safeText(req.body.text, 1000);

  if (!text) {
    return res.status(400).json({
      error: "Comment cannot be empty."
    });
  }

  const videos = readVideos();

  const video = videos.find(
    (item) => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  if (!Array.isArray(video.comments)) {
    video.comments = [];
  }

  const comment = {
    id: createId(),

    name,

    text,

    createdAt: new Date().toISOString()
  };

  video.comments.push(comment);

  if (video.comments.length > 100) {
    video.comments =
      video.comments.slice(-100);
  }

  saveVideos(videos);

  res.status(201).json({
    success: true,
    comment
  });
});

/*
--------------------------------------------------
DOWNLOAD
--------------------------------------------------
*/

app.get("/api/videos/:id/download", (req, res) => {
  const videos = readVideos();

  const video = videos.find(
    (item) => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).send("Video not found.");
  }

  const filePath = getFilePath(video);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video file not found.");
  }

  const downloadName =
    video.originalName || video.filename;

  res.download(filePath, downloadName);
});

/*
--------------------------------------------------
EDIT VIDEO
--------------------------------------------------
*/

app.put(
  "/api/videos/:id",
  requireAdmin,
  (req, res) => {
    const videos = readVideos();

    const video = videos.find(
      (item) => item.id === req.params.id
    );

    if (!video) {
      return res.status(404).json({
        error: "Video not found."
      });
    }

    const title =
      safeText(req.body.title, 200);

    const description =
      safeText(req.body.description, 3000);

    if (title) {
      video.title = title;
    }

    video.description = description;

    saveVideos(videos);

    res.json({
      success: true,
      video
    });
  }
);

/*
--------------------------------------------------
DELETE VIDEO
--------------------------------------------------
*/

app.delete(
  "/api/videos/:id",
  requireAdmin,
  (req, res) => {
    const videos = readVideos();

    const index = videos.findIndex(
      (item) => item.id === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({
        error: "Video not found."
      });
    }

    const video = videos[index];

    const filePath = getFilePath(video);

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      return res.status(500).json({
        error: "Could not delete video file."
      });
    }

    videos.splice(index, 1);

    saveVideos(videos);

    res.json({
      success: true
    });
  }
);

/*
--------------------------------------------------
VIDEO FILES
--------------------------------------------------
*/

app.use(
  "/videos",
  express.static(UPLOAD_DIR)
);

/*
--------------------------------------------------
WATCH PAGE
--------------------------------------------------
*/

app.get("/watch/:id", (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

/*
--------------------------------------------------
SPA FALLBACK
--------------------------------------------------
*/

app.get("*splat", (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

/*
--------------------------------------------------
ERROR HANDLER
--------------------------------------------------
*/

app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).json({
    error: "Server error."
  });
});

/*
--------------------------------------------------
START SERVER
--------------------------------------------------
*/

app.listen(PORT, () => {
  console.log(
    `VideoHub running on port ${PORT}`
  );
});
