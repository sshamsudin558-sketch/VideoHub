const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT) || 10000;

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const DATA_FILE = path.join(DATA_DIR, "videos.json");

const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_FILE_SIZE = 30 * 1024 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".ogg",
  ".mov",
  ".m4v"
]);

const sessions = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

/* =========================
   BASIC HELPERS
========================= */

function readVideos() {
  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");
    const videos = JSON.parse(data);

    return Array.isArray(videos) ? videos : [];
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

function createId() {
  return crypto.randomBytes(12).toString("hex");
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function getVideoById(id) {
  const videos = readVideos();
  return {
    videos,
    video: videos.find((item) => item.id === id)
  };
}

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
    views: Number(video.views || 0),
    likes: Number(video.likes || 0),
    commentsCount: Array.isArray(video.comments)
      ? video.comments.length
      : 0,
    url: `/videos/${encodeURIComponent(video.name)}`
  };

  if (includeComments) {
    result.comments = Array.isArray(video.comments)
      ? video.comments
      : [];
  }

  return result;
}

/* =========================
   COOKIE / ADMIN SESSION
========================= */

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader
    .split(";")
    .map((item) => item.trim());

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");

    if (index === -1) continue;

    const key = cookie.slice(0, index);
    const value = cookie.slice(index + 1);

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function isHttps(req) {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    req.secure === true
  );
}

function setAdminCookie(req, res, token) {
  const secure = isHttps(req) ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `videohub_admin=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`
  );
}

function clearAdminCookie(req, res) {
  const secure = isHttps(req) ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `videohub_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`
  );
}

function requireAdmin(req, res, next) {
  const token = getCookie(req, "videohub_admin");

  if (!token) {
    return res.status(401).json({
      error: "Admin login required."
    });
  }

  const expiresAt = sessions.get(token);

  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);

    return res.status(401).json({
      error: "Admin session expired."
    });
  }

  next();
}

setInterval(() => {
  const now = Date.now();

  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt < now) {
      sessions.delete(token);
    }
  }
}, 60 * 60 * 1000).unref();

/* =========================
   MULTER UPLOAD
========================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    const filename =
      `${Date.now()}-${createId()}${extension}`;

    cb(null, filename);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: (req, file, cb) => {
    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return cb(
        new Error(
          "Unsupported video format. Use MP4, WebM, OGG, MOV or M4V."
        )
      );
    }

    cb(null, true);
  }
});

/* =========================
   MIDDLEWARE
========================= */

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb"
  })
);

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "VideoHub",
    time: new Date().toISOString()
  });
});

/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;

  if (!configuredPassword) {
    return res.status(503).json({
      error:
        "ADMIN_PASSWORD is not configured in Render Environment Variables."
    });
  }

  const password = String(req.body?.password || "");

  if (password !== configuredPassword) {
    return res.status(401).json({
      error: "Incorrect admin password."
    });
  }

  const token = createSessionToken();

  const expiresAt =
    Date.now() + 12 * 60 * 60 * 1000;

  sessions.set(token, expiresAt);

  setAdminCookie(req, res, token);

  res.json({
    ok: true,
    message: "Admin login successful."
  });
});

/* =========================
   ADMIN STATUS
========================= */

app.get("/api/admin/status", (req, res) => {
  const token = getCookie(req, "videohub_admin");

  if (!token) {
    return res.json({
      loggedIn: false
    });
  }

  const expiresAt = sessions.get(token);

  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);

    return res.json({
      loggedIn: false
    });
  }

  res.json({
    loggedIn: true
  });
});

/* =========================
   ADMIN LOGOUT
========================= */

app.post("/api/admin/logout", (req, res) => {
  const token = getCookie(req, "videohub_admin");

  if (token) {
    sessions.delete(token);
  }

  clearAdminCookie(req, res);

  res.json({
    ok: true
  });
});

/* =========================
   GET ALL VIDEOS
========================= */

app.get("/api/videos", (req, res) => {
  const videos = readVideos();

  const result = videos
    .filter((video) => {
      const filePath = path.join(
        UPLOAD_DIR,
        path.basename(video.name)
      );

      return fs.existsSync(filePath);
    })
    .sort((a, b) => {
      return (
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime()
      );
    })
    .map((video) => publicVideo(video));

  res.json(result);
});

/* =========================
   GET ONE VIDEO
========================= */

app.get("/api/videos/:id", (req, res) => {
  const { video } = getVideoById(req.params.id);

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  const filePath = path.join(
    UPLOAD_DIR,
    path.basename(video.name)
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: "Video file not found."
    });
  }

  res.json(publicVideo(video, true));
});

/* =========================
   UPLOAD VIDEO
========================= */

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
      cleanText(req.body?.title, 200) ||
      path.parse(req.file.originalname).name;

    const description =
      cleanText(req.body?.description, 2000);

    const now = new Date().toISOString();

    const video = {
      id: createId(),
      name: req.file.filename,
      originalName: req.file.originalname,
      title,
      description,
      size: req.file.size,
      createdAt: now,
      modified: now,
      views: 0,
      likes: 0,
      comments: []
    };

    try {
      const videos = readVideos();

      videos.push(video);

      writeVideos(videos);

      res.status(201).json({
        ok: true,
        message: "Video uploaded successfully.",
        video: publicVideo(video, true)
      });
    } catch (error) {
      try {
        fs.unlinkSync(
          path.join(UPLOAD_DIR, req.file.filename)
        );
      } catch {}

      console.error(error);

      res.status(500).json({
        error: "Could not save video information."
      });
    }
  }
);

/* =========================
   ADD VIEW
========================= */

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

  video.modified = new Date().toISOString();

  writeVideos(videos);

  res.json({
    ok: true,
    views: video.views
  });
});

/* =========================
   LIKE / UNLIKE
========================= */

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

  const action = req.body?.action === "unlike"
    ? "unlike"
    : "like";

  if (action === "unlike") {
    video.likes = Math.max(
      0,
      Number(video.likes || 0) - 1
    );
  } else {
    video.likes = Number(video.likes || 0) + 1;
  }

  writeVideos(videos);

  res.json({
    ok: true,
    likes: video.likes
  });
});

/* =========================
   GET COMMENTS
========================= */

app.get("/api/videos/:id/comments", (req, res) => {
  const { video } = getVideoById(req.params.id);

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  const comments = Array.isArray(video.comments)
    ? video.comments
    : [];

  res.json(
    [...comments].reverse()
  );
});

/* =========================
   ADD COMMENT
========================= */

app.post("/api/videos/:id/comments", (req, res) => {
  const videos = readVideos();

  const video = videos.find(
    (item) => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      error: "Video not found."
    });
  }

  const name = cleanText(
    req.body?.name,
    50
  );

  const text = cleanText(
    req.body?.text,
    500
  );

  if (!name) {
    return res.status(400).json({
      error: "Please enter your name."
    });
  }

  if (!text) {
    return res.status(400).json({
      error: "Please enter a comment."
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

  if (video.comments.length > 1000) {
    video.comments =
      video.comments.slice(-1000);
  }

  video.modified = new Date().toISOString();

  writeVideos(videos);

  res.status(201).json({
    ok: true,
    comment
  });
});

/* =========================
   EDIT VIDEO
========================= */

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

    const title = cleanText(
      req.body?.title,
      200
    );

    const description = cleanText(
      req.body?.description,
      2000
    );

    if (!title) {
      return res.status(400).json({
        error: "Title is required."
      });
    }

    video.title = title;
    video.description = description;
    video.modified = new Date().toISOString();

    writeVideos(videos);

    res.json({
      ok: true,
      video: publicVideo(video, true)
    });
  }
);

/* =========================
   DELETE VIDEO
========================= */

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

    const filePath = path.join(
      UPLOAD_DIR,
      path.basename(video.name)
    );

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      videos.splice(index, 1);

      writeVideos(videos);

      res.json({
        ok: true,
        message: "Video deleted successfully."
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not delete video."
      });
    }
  }
);

/* =========================
   DOWNLOAD VIDEO
========================= */

app.get(
  "/api/videos/:id/download",
  (req, res) => {
    const { video } = getVideoById(req.params.id);

    if (!video) {
      return res.status(404).send(
        "Video not found."
      );
    }

    const filePath = path.join(
      UPLOAD_DIR,
      path.basename(video.name)
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).send(
        "Video file not found."
      );
    }

    const downloadName =
      video.originalName ||
      `${video.title}.mp4`;

    res.download(
      filePath,
      path.basename(downloadName),
      (error) => {
        if (error) {
          console.error(
            "Download error:",
            error.message
          );
        }
      }
    );
  }
);

/* =========================
   VIDEO FILES
========================= */

app.use(
  "/videos",
  express.static(UPLOAD_DIR, {
    acceptRanges: true,
    fallthrough: true,
    maxAge: "1h"
  })
);

/* =========================
   WATCH URL
========================= */

app.get("/watch/:id", (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

/* =========================
   PUBLIC WEBSITE
========================= */

app.use(
  express.static(PUBLIC_DIR)
);

/* =========================
   API 404
========================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found."
  });
});

/* =========================
   SPA FALLBACK
========================= */

app.get("*splat", (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error:
          "Video is larger than the 30GB upload limit."
      });
    }

    return res.status(400).json({
      error: error.message
    });
  }

  return res.status(400).json({
    error:
      error.message ||
      "Something went wrong."
  });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `VideoHub running on port ${PORT}`
  );

  console.log(
    `Upload directory: ${UPLOAD_DIR}`
  );

  console.log(
    `Data file: ${DATA_FILE}`
  );
});
