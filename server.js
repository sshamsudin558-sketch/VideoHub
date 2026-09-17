const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

/* =========================
   DIRECTORIES
========================= */

const PUBLIC_DIR = path.join(__dirname, "public");

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
const REVENUE_FILE = path.join(DATA_DIR, "revenue.json");
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");

/* =========================
   ADMIN
========================= */

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "VideoHub@2026#Shams";

/* =========================
   APP CONFIG
========================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   CREATE DIRECTORIES
========================= */

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function createJsonFile(file, defaultValue = []) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify(defaultValue, null, 2),
      "utf8"
    );
  }
}

createJsonFile(VIDEOS_FILE, []);
createJsonFile(REVENUE_FILE, []);
createJsonFile(PAYMENTS_FILE, []);

/* =========================
   JSON HELPERS
========================= */

function readJson(file) {
  try {
    const data = fs.readFileSync(file, "utf8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

/* =========================
   ADMIN SESSION
========================= */

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    createdAt: Date.now()
  });

  return token;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Admin login required"
    });
  }

  const token = auth.substring(7);

  if (!sessions.has(token)) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session"
    });
  }

  next();
}

/* =========================
   MULTER
========================= */

const allowedExtensions = [
  ".mp4",
  ".webm",
  ".ogg",
  ".mov",
  ".m4v"
];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    const safeName =
      crypto.randomBytes(16).toString("hex") + ext;

    cb(null, safeName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 30 * 1024 * 1024 * 1024
  },

  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.includes(ext)) {
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
   HOME
========================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Incorrect admin password"
    });
  }

  const token = createSession();

  res.json({
    success: true,
    token
  });
});

/* =========================
   ADMIN STATUS
========================= */

app.get("/api/admin/status", requireAdmin, (req, res) => {
  res.json({
    success: true,
    authenticated: true
  });
});

/* =========================
   ADMIN LOGOUT
========================= */

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = req.headers.authorization.substring(7);

  sessions.delete(token);

  res.json({
    success: true,
    message: "Logged out successfully"
  });
});

/* =========================
   GET VIDEOS
========================= */

app.get("/api/videos", (req, res) => {
  const videos = readJson(VIDEOS_FILE);

  const search =
    String(req.query.search || "")
      .trim()
      .toLowerCase();

  let result = videos;

  if (search) {
    result = videos.filter(video =>
      `${video.title} ${video.description}`
        .toLowerCase()
        .includes(search)
    );
  }

  result.sort(
    (a, b) =>
      new Date(b.createdAt) -
      new Date(a.createdAt)
  );

  res.json({
    success: true,
    videos: result
  });
});

/* =========================
   GET SINGLE VIDEO
========================= */

app.get("/api/videos/:id", (req, res) => {
  const videos = readJson(VIDEOS_FILE);

  const video = videos.find(
    item => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video not found"
    });
  }

  res.json({
    success: true,
    video
  });
});

/* =========================
   UPLOAD VIDEO
========================= */

app.post(
  "/api/upload",
  requireAdmin,
  upload.single("video"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select a video"
        });
      }

      const title =
        String(req.body.title || "")
          .trim()
          .substring(0, 200);

      const description =
        String(req.body.description || "")
          .trim()
          .substring(0, 5000);

      if (!title) {
        fs.unlinkSync(req.file.path);

        return res.status(400).json({
          success: false,
          message: "Video title is required"
        });
      }

      const videos = readJson(VIDEOS_FILE);

      const video = {
        id: crypto.randomUUID(),

        title,

        description,

        filename: req.file.filename,

        originalName: req.file.originalname,

        size: req.file.size,

        mimeType: req.file.mimetype,

        views: 0,

        likes: 0,

        comments: [],

        createdAt: new Date().toISOString(),

        updatedAt: new Date().toISOString()
      };

      videos.push(video);

      writeJson(VIDEOS_FILE, videos);

      res.json({
        success: true,
        message: "Video uploaded successfully",
        video
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Upload failed"
      });
    }
  }
);

/* =========================
   VIDEO STREAMING
========================= */

app.get("/videos/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);

  const filePath = path.join(
    UPLOAD_DIR,
    filename
  );

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video not found");
  }

  const stat = fs.statSync(filePath);

  const fileSize = stat.size;

  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4"
    });

    return fs.createReadStream(filePath).pipe(res);
  }

  const parts = range
    .replace(/bytes=/, "")
    .split("-");

  const start = parseInt(parts[0], 10);

  const end = parts[1]
    ? parseInt(parts[1], 10)
    : fileSize - 1;

  const chunkSize = end - start + 1;

  const stream = fs.createReadStream(
    filePath,
    {
      start,
      end
    }
  );

  res.writeHead(206, {
    "Content-Range":
      `bytes ${start}-${end}/${fileSize}`,

    "Accept-Ranges": "bytes",

    "Content-Length": chunkSize,

    "Content-Type": "video/mp4"
  });

  stream.pipe(res);
});

/* =========================
   VIEW
========================= */

app.post("/api/videos/:id/view", (req, res) => {
  const videos = readJson(VIDEOS_FILE);

  const video = videos.find(
    item => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video not found"
    });
  }

  video.views =
    Number(video.views || 0) + 1;

  video.updatedAt =
    new Date().toISOString();

  writeJson(VIDEOS_FILE, videos);

  res.json({
    success: true,
    views: video.views
  });
});

/* =========================
   LIKE
========================= */

app.post("/api/videos/:id/like", (req, res) => {
  const videos = readJson(VIDEOS_FILE);

  const video = videos.find(
    item => item.id === req.params.id
  );

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video not found"
    });
  }

  video.likes =
    Number(video.likes || 0) + 1;

  writeJson(VIDEOS_FILE, videos);

  res.json({
    success: true,
    likes: video.likes
  });
});

/* =========================
   COMMENTS
========================= */

app.get(
  "/api/videos/:id/comments",
  (req, res) => {
    const videos = readJson(VIDEOS_FILE);

    const video = videos.find(
      item => item.id === req.params.id
    );

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found"
      });
    }

    res.json({
      success: true,
      comments: video.comments || []
    });
  }
);

app.post(
  "/api/videos/:id/comments",
  (req, res) => {
    const videos = readJson(VIDEOS_FILE);

    const video = videos.find(
      item => item.id === req.params.id
    );

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found"
      });
    }

    const name =
      String(req.body.name || "Guest")
        .trim()
        .substring(0, 100);

    const text =
      String(req.body.text || "")
        .trim()
        .substring(0, 1000);

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Comment is required"
      });
    }

    if (!video.comments) {
      video.comments = [];
    }

    const comment = {
      id: crypto.randomUUID(),

      name,

      text,

      createdAt:
        new Date().toISOString()
    };

    video.comments.push(comment);

    writeJson(VIDEOS_FILE, videos);

    res.json({
      success: true,
      comment
    });
  }
);

/* =========================
   EDIT VIDEO
========================= */

app.put(
  "/api/videos/:id",
  requireAdmin,
  (req, res) => {
    const videos = readJson(VIDEOS_FILE);

    const video = videos.find(
      item => item.id === req.params.id
    );

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found"
      });
    }

    if (req.body.title !== undefined) {
      video.title =
        String(req.body.title)
          .trim()
          .substring(0, 200);
    }

    if (req.body.description !== undefined) {
      video.description =
        String(req.body.description)
          .trim()
          .substring(0, 5000);
    }

    video.updatedAt =
      new Date().toISOString();

    writeJson(VIDEOS_FILE, videos);

    res.json({
      success: true,
      message: "Video updated",
      video
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
    const videos = readJson(VIDEOS_FILE);

    const index = videos.findIndex(
      item => item.id === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: "Video not found"
      });
    }

    const video = videos[index];

    const filePath = path.join(
      UPLOAD_DIR,
      path.basename(video.filename)
    );

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    videos.splice(index, 1);

    writeJson(VIDEOS_FILE, videos);

    /*
      IMPORTANT:
      Revenue is NOT deleted.
      Payment history is NOT deleted.
    */

    res.json({
      success: true,
      message:
        "Video deleted. Revenue history preserved."
    });
  }
);

/* =========================
   DOWNLOAD
========================= */

app.get(
  "/api/videos/:id/download",
  (req, res) => {
    const videos = readJson(VIDEOS_FILE);

    const video = videos.find(
      item => item.id === req.params.id
    );

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found"
      });
    }

    const filePath = path.join(
      UPLOAD_DIR,
      path.basename(video.filename)
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "Video file not found"
      });
    }

    res.download(
      filePath,
      video.originalName
    );
  }
);

/* =========================================================
   MONETIZATION
========================================================= */

/*
  Revenue is stored separately from videos.

  This means deleting a video DOES NOT delete
  its previous revenue records.
*/

/* =========================
   GET REVENUE
========================= */

app.get(
  "/api/admin/monetization",
  requireAdmin,
  (req, res) => {
    const revenue = readJson(REVENUE_FILE);
    const payments = readJson(PAYMENTS_FILE);

    const totalRevenue = revenue.reduce(
      (sum, item) =>
        sum + Number(item.amount || 0),
      0
    );

    const pendingRevenue = revenue
      .filter(item => item.status === "pending")
      .reduce(
        (sum, item) =>
          sum + Number(item.amount || 0),
        0
      );

    const paidRevenue = revenue
      .filter(item => item.status === "paid")
      .reduce(
        (sum, item) =>
          sum + Number(item.amount || 0),
        0
      );

    const now = new Date();

    const currentMonth =
      now.getUTCMonth();

    const currentYear =
      now.getUTCFullYear();

    const monthlyRevenue =
      revenue
        .filter(item => {
          const date =
            new Date(item.createdAt);

          return (
            date.getUTCMonth() === currentMonth &&
            date.getUTCFullYear() === currentYear
          );
        })
        .reduce(
          (sum, item) =>
            sum + Number(item.amount || 0),
          0
        );

    res.json({
      success: true,

      statistics: {
        totalRevenue,
        monthlyRevenue,
        pendingRevenue,
        paidRevenue
      },

      revenue,

      payments
    });
  }
);

/* =========================
   ADD REVENUE
========================= */

app.post(
  "/api/admin/revenue",
  requireAdmin,
  (req, res) => {
    const {
      videoId,
      amount,
      impressions,
      source
    } = req.body;

    const revenueAmount =
      Number(amount);

    if (
      !Number.isFinite(revenueAmount) ||
      revenueAmount < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid revenue amount"
      });
    }

    const revenue =
      readJson(REVENUE_FILE);

    const record = {
      id: crypto.randomUUID(),

      videoId:
        videoId || null,

      amount:
        Number(revenueAmount.toFixed(2)),

      impressions:
        Number(impressions || 0),

      source:
        source || "manual",

      status: "pending",

      createdAt:
        new Date().toISOString()
    };

    revenue.push(record);

    writeJson(
      REVENUE_FILE,
      revenue
    );

    res.json({
      success: true,
      revenue: record
    });
  }
);

/* =========================
   MARK REVENUE PAID
========================= */

app.post(
  "/api/admin/revenue/:id/paid",
  requireAdmin,
  (req, res) => {
    const revenue =
      readJson(REVENUE_FILE);

    const item =
      revenue.find(
        x => x.id === req.params.id
      );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Revenue record not found"
      });
    }

    item.status = "paid";

    item.paidAt =
      new Date().toISOString();

    writeJson(
      REVENUE_FILE,
      revenue
    );

    const payments =
      readJson(PAYMENTS_FILE);

    payments.push({
      id: crypto.randomUUID(),

      revenueId: item.id,

      amount: item.amount,

      status: "paid",

      createdAt:
        new Date().toISOString()
    });

    writeJson(
      PAYMENTS_FILE,
      payments
    );

    res.json({
      success: true,
      message: "Revenue marked as paid"
    });
  }
);

/* =========================
   PAYMENT HISTORY
========================= */

app.get(
  "/api/admin/payments",
  requireAdmin,
  (req, res) => {
    const payments =
      readJson(PAYMENTS_FILE);

    res.json({
      success: true,
      payments
    });
  }
);

/* =========================
   VIDEO REVENUE
========================= */

app.get(
  "/api/admin/videos-revenue",
  requireAdmin,
  (req, res) => {
    const videos =
      readJson(VIDEOS_FILE);

    const revenue =
      readJson(REVENUE_FILE);

    const result =
      videos.map(video => {
        const videoRevenue =
          revenue
            .filter(
              item =>
                item.videoId === video.id
            )
            .reduce(
              (sum, item) =>
                sum +
                Number(item.amount || 0),
              0
            );

        return {
          id: video.id,

          title: video.title,

          views:
            Number(video.views || 0),

          likes:
            Number(video.likes || 0),

          revenue:
            Number(
              videoRevenue.toFixed(2)
            )
        };
      });

    res.json({
      success: true,
      videos: result
    });
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (error, req, res, next) => {
    console.error(error);

    if (
      error instanceof multer.MulterError
    ) {
      return res.status(400).json({
        success: false,
        message:
          error.code === "LIMIT_FILE_SIZE"
            ? "Video file is larger than 30GB."
            : error.message
      });
    }

    res.status(500).json({
      success: false,
      message:
        error.message ||
        "Internal server error"
    });
  }
);

/* =========================
   STATIC WEBSITE
========================= */

app.use(
  express.static(PUBLIC_DIR)
);

/* =========================
   SPA FALLBACK
========================= */

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
    `Data directory: ${DATA_DIR}`
  );
});
