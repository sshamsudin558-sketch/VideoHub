const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require("@aws-sdk/client-s3");

const app = express();

/* =========================
   BASIC CONFIG
========================= */

const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");

/* =========================
   IDRIVE E2 CONFIG
========================= */

const S3_ACCESS_KEY_ID = "aabgP1PKuw0y0rhvl1UQG";

/*
  IMPORTANT:
  Do NOT put your old exposed Secret Key here.
  Put your NEW Secret Key in Render Environment Variables.
*/
const S3_SECRET_ACCESS_KEY =
  process.env.S3_SECRET_ACCESS_KEY || "PASTE_NEW_SECRET_HERE";

const S3_BUCKET = "videohub-storage";
const S3_REGION = "us-west-4";
const S3_ENDPOINT = "https://s3.us-west-4.idrivee2.com";

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY
  }
});

/* =========================
   APP SETTINGS
========================= */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

/*
  We keep the uploaded file temporarily on disk
  instead of RAM. This is safer for large videos.
*/
const upload = multer({
  dest: path.join(__dirname, "tmp"),
  limits: {
    fileSize: 30 * 1024 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "video/mp4",
      "video/webm",
      "video/ogg",
      "video/quicktime",
      "video/x-m4v"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only video files are allowed."));
    }

    cb(null, true);
  }
});

/* =========================
   TEMP FILE SUPPORT
========================= */

const fs = require("fs");

const TMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, {
    recursive: true
  });
}

/* =========================
   IN-MEMORY METADATA
=========================

   IMPORTANT:
   On Render Free this data is not permanent.
   For permanent data use PostgreSQL.
========================= */

const videos = new Map();

/* =========================
   ADMIN
========================= */

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "VideoHub@2026#Shams";

const adminSessions = new Set();

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");

  adminSessions.add(token);

  return token;
}

function isAdmin(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return false;
  }

  const token = auth.substring(7);

  return adminSessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      success: false,
      message: "Admin authentication required."
    });
  }

  next();
}

/* =========================
   HELPERS
========================= */

function makeId() {
  return crypto.randomUUID();
}

function safeFileName(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function removeTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Temporary file delete error:", error.message);
  }
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "VideoHub",
    storage: "IDrive e2",
    bucket: S3_BUCKET,
    region: S3_REGION,
    time: new Date().toISOString()
  });
});

/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Invalid password."
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

app.get("/api/admin/status", (req, res) => {
  res.json({
    success: true,
    admin: isAdmin(req)
  });
});

/* =========================
   ADMIN LOGOUT
========================= */

app.post("/api/admin/logout", (req, res) => {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    adminSessions.delete(auth.substring(7));
  }

  res.json({
    success: true
  });
});

/* =========================
   UPLOAD VIDEO
========================= */

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {
    let tempFile = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select a video."
        });
      }

      tempFile = req.file.path;

      const id = makeId();

      const extension =
        path.extname(req.file.originalname).toLowerCase();

      const storageName =
        `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;

      const objectKey = `videos/${storageName}`;

      const stream = fs.createReadStream(tempFile);

      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: objectKey,
          Body: stream,
          ContentType: req.file.mimetype,
          Metadata: {
            originalname: safeFileName(req.file.originalname)
          }
        })
      );

      const video = {
        id,

        title:
          req.body.title ||
          path.parse(req.file.originalname).name,

        description:
          req.body.description || "",

        originalName:
          req.file.originalname,

        fileName:
          storageName,

        objectKey,

        contentType:
          req.file.mimetype,

        size:
          req.file.size,

        views: 0,

        likes: 0,

        comments: [],

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()
      };

      videos.set(id, video);

      res.json({
        success: true,
        message: "Video uploaded successfully.",
        video
      });
    } catch (error) {
      console.error("UPLOAD ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Video upload failed.",
        error: error.message
      });
    } finally {
      if (tempFile) {
        removeTempFile(tempFile);
      }
    }
  }
);

/* =========================
   GET ALL VIDEOS
========================= */

app.get("/api/videos", (req, res) => {
  const list = Array.from(videos.values())
    .sort(
      (a, b) =>
        new Date(b.createdAt) -
        new Date(a.createdAt)
    );

  res.json({
    success: true,
    count: list.length,
    videos: list
  });
});

/* =========================
   GET SINGLE VIDEO
========================= */

app.get("/api/videos/:id", (req, res) => {
  const video = videos.get(req.params.id);

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video not found."
    });
  }

  res.json({
    success: true,
    video
  });
});

/* =========================
   STREAM VIDEO
========================= */

app.get("/videos/:id", async (req, res) => {
  try {
    const video = videos.get(req.params.id);

    if (!video) {
      return res.status(404).send("Video not found.");
    }

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: video.objectKey
      })
    );

    res.status(200);

    res.setHeader(
      "Content-Type",
      video.contentType || "video/mp4"
    );

    if (result.ContentLength) {
      res.setHeader(
        "Content-Length",
        result.ContentLength
      );
    }

    if (result.ETag) {
      res.setHeader(
        "ETag",
        result.ETag
      );
    }

    result.Body.pipe(res);
  } catch (error) {
    console.error("STREAM ERROR:", error);

    res.status(404).send(
      "Unable to stream video."
    );
  }
});

/* =========================
   VIEW
========================= */

app.post("/api/videos/:id/view", (req, res) => {
  const video = videos.get(req.params.id);

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video not found."
    });
  }

  video.views += 1;

  video.updatedAt =
    new Date().toISOString();

  res.json({
    success: true,
    views: video.views
  });
});

/* =========================
   LIKE
========================= */

app.post("/api/videos/:id/like", (req, res) => {
  const video = videos.get(req.params.id);

  if (!video) {
    return res.status(404).json({
      success: false,
      message: "Video not found."
    });
  }

  video.likes += 1;

  video.updatedAt =
    new Date().toISOString();

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
    const video = videos.get(req.params.id);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found."
      });
    }

    res.json({
      success: true,
      comments: video.comments
    });
  }
);

app.post(
  "/api/videos/:id/comments",
  (req, res) => {
    const video = videos.get(req.params.id);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found."
      });
    }

    const name =
      String(req.body.name || "Anonymous")
        .trim()
        .slice(0, 80);

    const text =
      String(req.body.text || "")
        .trim()
        .slice(0, 1000);

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Comment is required."
      });
    }

    const comment = {
      id: makeId(),

      name,

      text,

      createdAt:
        new Date().toISOString()
    };

    video.comments.push(comment);

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
    const video = videos.get(req.params.id);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: "Video not found."
      });
    }

    if (req.body.title !== undefined) {
      video.title =
        String(req.body.title)
          .trim()
          .slice(0, 200);
    }

    if (req.body.description !== undefined) {
      video.description =
        String(req.body.description)
          .trim()
          .slice(0, 5000);
    }

    video.updatedAt =
      new Date().toISOString();

    res.json({
      success: true,
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
  async (req, res) => {
    try {
      const video = videos.get(req.params.id);

      if (!video) {
        return res.status(404).json({
          success: false,
          message: "Video not found."
        });
      }

      await s3.send(
        new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: video.objectKey
        })
      );

      videos.delete(req.params.id);

      res.json({
        success: true,
        message: "Video deleted successfully."
      });
    } catch (error) {
      console.error("DELETE ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Unable to delete video.",
        error: error.message
      });
    }
  }
);

/* =========================
   DOWNLOAD VIDEO
========================= */

app.get(
  "/api/videos/:id/download",
  async (req, res) => {
    try {
      const video = videos.get(req.params.id);

      if (!video) {
        return res.status(404).json({
          success: false,
          message: "Video not found."
        });
      }

      const result = await s3.send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: video.objectKey
        })
      );

      res.setHeader(
        "Content-Type",
        video.contentType || "application/octet-stream"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFileName(
          video.originalName
        )}"`
      );

      if (result.ContentLength) {
        res.setHeader(
          "Content-Length",
          result.ContentLength
        );
      }

      result.Body.pipe(res);
    } catch (error) {
      console.error("DOWNLOAD ERROR:", error);

      res.status(500).json({
        success: false,
        message: "Download failed."
      });
    }
  }
);

/* =========================
   STORAGE TEST
========================= */

app.get(
  "/api/admin/storage-test",
  requireAdmin,
  async (req, res) => {
    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: "videos/test"
        })
      );

      res.json({
        success: true,
        storage: "Connected"
      });
    } catch (error) {
      /*
        NotFound means the bucket connection itself
        may still be working.
      */
      if (
        error.name === "NotFound" ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return res.json({
          success: true,
          storage: "Connected"
        });
      }

      res.status(500).json({
        success: false,
        storage: "Connection failed",
        error: error.message
      });
    }
  }
);

/* =========================
   ADMIN STATISTICS
========================= */

app.get(
  "/api/admin/statistics",
  requireAdmin,
  (req, res) => {
    const list =
      Array.from(videos.values());

    const totalViews =
      list.reduce(
        (sum, video) =>
          sum + Number(video.views || 0),
        0
      );

    const totalLikes =
      list.reduce(
        (sum, video) =>
          sum + Number(video.likes || 0),
        0
      );

    const totalComments =
      list.reduce(
        (sum, video) =>
          sum +
          Number(
            video.comments?.length || 0
          ),
        0
      );

    const totalSize =
      list.reduce(
        (sum, video) =>
          sum + Number(video.size || 0),
        0
      );

    res.json({
      success: true,

      statistics: {
        videos: list.length,

        views: totalViews,

        likes: totalLikes,

        comments: totalComments,

        storageBytes: totalSize,

        storageGB:
          totalSize /
          (1024 * 1024 * 1024)
      }
    });
  }
);

/* =========================
   MONETIZATION
========================= */

app.get(
  "/api/admin/monetization",
  requireAdmin,
  (req, res) => {
    res.json({
      success: true,

      monetization: {
        enabled: false,

        provider: null,

        message:
          "Connect an approved advertising provider before activating real monetization."
      }
    });
  }
);

/* =========================
   SPA FALLBACK
========================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      PUBLIC_DIR,
      "index.html"
    )
  );
});

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
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message:
        error.message ||
        "Internal server error."
    });
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
    `IDrive e2 bucket: ${S3_BUCKET}`
  );

  console.log(
    `IDrive e2 region: ${S3_REGION}`
  );
});
