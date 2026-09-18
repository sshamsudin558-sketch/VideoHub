"use strict";

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand
} = require("@aws-sdk/client-s3");

const {
  getSignedUrl
} = require("@aws-sdk/s3-request-presigner");


/* =========================================================
   APP
========================================================= */

const app = express();

app.disable("x-powered-by");


/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = Number(
  process.env.PORT || 10000
);

const PUBLIC_DIR = path.join(
  __dirname,
  "public"
);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const JWT_SECRET =
  process.env.JWT_SECRET ||
  "CHANGE_THIS_VIDEOHUB_SECRET";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  "CHANGE_THIS_ADMIN_PASSWORD";


/* =========================================================
   IDRIVE E2 / S3 CONFIGURATION

   DO NOT PUT REAL SECRETS IN GITHUB.

   Use environment variables:
   S3_ACCESS_KEY_ID
   S3_SECRET_ACCESS_KEY
   S3_BUCKET
   S3_REGION
   S3_ENDPOINT
========================================================= */

const S3_ACCESS_KEY_ID =
  process.env.S3_ACCESS_KEY_ID || "";

const S3_SECRET_ACCESS_KEY =
  process.env.S3_SECRET_ACCESS_KEY || "";

const S3_BUCKET =
  process.env.S3_BUCKET ||
  "videohub-storage";

const S3_REGION =
  process.env.S3_REGION ||
  "us-west-4";

const S3_ENDPOINT =
  process.env.S3_ENDPOINT ||
  "https://s3.us-west-4.idrivee2.com";


/* =========================================================
   LIMITS
========================================================= */

const MAX_VIDEO_SIZE =
  30 * 1024 * 1024 * 1024;

const MAX_TITLE_LENGTH = 255;

const MAX_DESCRIPTION_LENGTH = 5000;

const MAX_COMMENT_LENGTH = 2000;


/* =========================================================
   EXPRESS MIDDLEWARE
========================================================= */

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb"
  })
);

app.use(
  express.static(
    PUBLIC_DIR,
    {
      extensions: ["html"],
      maxAge: "1h"
    }
  )
);


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (DATABASE_URL) {

  pool = new Pool({
    connectionString:
      DATABASE_URL,

    ssl: {
      rejectUnauthorized: false
    },

    max: 10,

    idleTimeoutMillis:
      30000,

    connectionTimeoutMillis:
      10000
  });

} else {

  console.warn(
    "WARNING: DATABASE_URL is not configured."
  );

}


/* =========================================================
   S3 / IDRIVE E2
========================================================= */

let s3 = null;

if (
  S3_ACCESS_KEY_ID &&
  S3_SECRET_ACCESS_KEY
) {

  s3 = new S3Client({

    region:
      S3_REGION,

    endpoint:
      S3_ENDPOINT,

    forcePathStyle:
      true,

    credentials: {

      accessKeyId:
        S3_ACCESS_KEY_ID,

      secretAccessKey:
        S3_SECRET_ACCESS_KEY

    }

  });

} else {

  console.warn(
    "WARNING: S3/IDrive e2 credentials are not configured."
  );

}


/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {

  if (!pool) {

    console.warn(
      "Database initialization skipped."
    );

    return;

  }


  const client =
    await pool.connect();


  try {

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (

        id SERIAL PRIMARY KEY,

        name VARCHAR(120) NOT NULL,

        email VARCHAR(255)
          UNIQUE NOT NULL,

        password_hash TEXT NOT NULL,

        role VARCHAR(30)
          DEFAULT 'user',

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP

      );


      CREATE TABLE IF NOT EXISTS videos (

        id SERIAL PRIMARY KEY,

        user_id INTEGER
          REFERENCES users(id)
          ON DELETE SET NULL,

        title VARCHAR(255)
          NOT NULL,

        description TEXT
          DEFAULT '',

        object_key TEXT
          UNIQUE NOT NULL,

        filename TEXT
          NOT NULL,

        mime_type VARCHAR(150),

        size BIGINT
          DEFAULT 0,

        views BIGINT
          DEFAULT 0,

        likes BIGINT
          DEFAULT 0,

        downloads BIGINT
          DEFAULT 0,

        status VARCHAR(30)
          DEFAULT 'ready',

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP,

        updated_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP

      );


      CREATE TABLE IF NOT EXISTS comments (

        id SERIAL PRIMARY KEY,

        video_id INTEGER
          REFERENCES videos(id)
          ON DELETE CASCADE,

        user_id INTEGER
          REFERENCES users(id)
          ON DELETE SET NULL,

        text TEXT NOT NULL,

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP

      );


      CREATE TABLE IF NOT EXISTS likes (

        id SERIAL PRIMARY KEY,

        video_id INTEGER
          REFERENCES videos(id)
          ON DELETE CASCADE,

        user_id INTEGER
          REFERENCES users(id)
          ON DELETE CASCADE,

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(video_id, user_id)

      );


      CREATE TABLE IF NOT EXISTS revenue (

        id SERIAL PRIMARY KEY,

        video_id INTEGER
          REFERENCES videos(id)
          ON DELETE CASCADE,

        amount NUMERIC(12,2)
          DEFAULT 0,

        source VARCHAR(100)
          DEFAULT 'ads',

        status VARCHAR(30)
          DEFAULT 'pending',

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP

      );


      CREATE INDEX IF NOT EXISTS
      idx_videos_created
      ON videos(created_at DESC);


      CREATE INDEX IF NOT EXISTS
      idx_videos_user
      ON videos(user_id);


      CREATE INDEX IF NOT EXISTS
      idx_comments_video
      ON comments(video_id);


      CREATE INDEX IF NOT EXISTS
      idx_likes_video
      ON likes(video_id);

    `);


    /*
     * Ensure an admin account exists.
     *
     * This account is used internally so
     * admin JWTs have a real database user_id.
     */

    const adminEmail =
      "admin@videohub.local";


    const adminCheck =
      await client.query(
        `
        SELECT id
        FROM users
        WHERE email = $1
        `,
        [adminEmail]
      );


    if (
      adminCheck.rows.length === 0
    ) {

      const passwordHash =
        await bcrypt.hash(
          ADMIN_PASSWORD,
          12
        );


      await client.query(
        `
        INSERT INTO users
        (
          name,
          email,
          password_hash,
          role
        )
        VALUES
        (
          'VideoHub Admin',
          $1,
          $2,
          'admin'
        )
        `,
        [
          adminEmail,
          passwordHash
        ]
      );

    } else {

      /*
       * Keep admin role correct.
       */

      await client.query(
        `
        UPDATE users
        SET role = 'admin'
        WHERE email = $1
        `,
        [adminEmail]
      );

    }


    console.log(
      "PostgreSQL database initialized."
    );

  } catch (error) {

    console.error(
      "DATABASE INITIALIZATION ERROR:",
      error
    );

  } finally {

    client.release();

  }

}


/* =========================================================
   HELPERS
========================================================= */

function makeObjectKey(
  filename
) {

  const extension =
    path
      .extname(
        filename || ""
      )
      .toLowerCase()
      .replace(
        /[^a-z0-9.]/g,
        ""
      );


  const random =
    crypto
      .randomBytes(16)
      .toString("hex");


  return( 
    `videos/${Date.now()}-${random}${extension}`;

}


function safeFileName(
  filename
) {

  return path
    .basename(
      filename || "video"
    )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

}


function isValidId(
  value
) {

  return /^[0-9]+$/.test(
    String(value || "")
  );

}


function isAllowedVideoType(
  contentType
) {

  const type =
    String(
      contentType || ""
    )
      .toLowerCase()
      .split(";")[0]
      .trim();


  return (
    type.startsWith("video/")
  );

}


function createToken(
  user,
  expiresIn = "30d"
) {

  return jwt.sign(

    {
      id:
        user.id,

      email:
        user.email,

      role:
        user.role

    },

    JWT_SECRET,

    {
      expiresIn
    }

  );

}


function getTokenFromRequest(
  req
) {

  const authorization =
    req.headers.authorization ||
    "";


  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {

    return null;

  }


  return authorization
    .substring(7)
    .trim();

}


function getUserFromRequest(
  req
) {

  const token =
    getTokenFromRequest(
      req
    );


  if (!token) {

    return null;

  }


  try {

    return jwt.verify(
      token,
      JWT_SECRET
    );

  } catch {

    return null;

  }

}


function requireAuth(
  req,
  res,
  next
) {

  const user =
    getUserFromRequest(
      req
    );


  if (!user) {

    return res
      .status(401)
      .json({

        success:
          false,

        error:
          "Authentication required."

      });

  }


  req.user =
    user;


  next();

}


function requireAdmin(
  req,
  res,
  next
) {

  const user =
    getUserFromRequest(
      req
    );


  if (
    !user ||
    user.role !== "admin"
  ) {

    return res
      .status(403)
      .json({

        success:
          false,

        error:
          "Admin access required."

      });

  }


  req.user =
    user;


  next();

}


function formatVideo(
  row
) {

  return {

    id:
      row.id,

    userId:
      row.user_id,

    title:
      row.title,

    description:
      row.description || "",

    objectKey:
      row.object_key,

    originalName:
      row.filename,

    fileName:
      path.basename(
        row.object_key
      ),

    contentType:
      row.mime_type,

    mimeType:
      row.mime_type,

    size:
      Number(
        row.size || 0
      ),

    views:
      Number(
        row.views || 0
      ),

    likes:
      Number(
        row.likes || 0
      ),

    downloads:
      Number(
        row.downloads || 0
      ),

    status:
      row.status,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at

  };

}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  async (
    req,
    res
  ) => {

    let database =
      "not configured";


    if (pool) {

      try {

        await pool.query(
          "SELECT 1"
        );

        database =
          "connected";

      } catch {

        database =
          "connection failed";

      }

    }


    res.json({

      success:
        true,

      service:
        "VideoHub",

      database,

      storage:
        s3
          ? "configured"
          : "not configured",

      bucket:
        S3_BUCKET,

      region:
        S3_REGION,

      time:
        new Date()
          .toISOString()

    });

  }
);


/* =========================================================
   USER REGISTER
========================================================= */

app.post(
  "/api/auth/register",
  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Database is not configured."

          });

      }


      const name =
        String(
          req.body.name || ""
        )
          .trim()
          .slice(
            0,
            120
          );


      const email =
        String(
          req.body.email || ""
        )
          .trim()
          .toLowerCase()
          .slice(
            0,
            255
          );


      const password =
        String(
          req.body.password || ""
        );


      if (
        !name ||
        !email ||
        !password
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Name, email and password are required."

          });

      }


      if (
        password.length < 6
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Password must be at least 6 characters."

          });

      }


      const existing =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE email = $1
          `,
          [email]
        );


      if (
        existing.rows.length
      ) {

        return res
          .status(409)
          .json({

            success:
              false,

            error:
              "An account with this email already exists."

          });

      }


      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );


      const result =
        await pool.query(
          `
          INSERT INTO users
          (
            name,
            email,
            password_hash,
            role
          )
          VALUES
          (
            $1,
            $2,
            $3,
            'user'
          )
          RETURNING
            id,
            name,
            email,
            role,
            created_at
          `,
          [
            name,
            email,
            passwordHash
          ]
        );


      const user =
        result.rows[0];


      const token =
        createToken(
          user
        );


      res
        .status(201)
        .json({

          success:
            true,

          token,

          user

        });

    } catch (error) {

      console.error(
        "REGISTER ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Registration failed."

        });

    }

  }
);


/* =========================================================
   USER LOGIN
========================================================= */

app.post(
  "/api/auth/login",
  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Database is not configured."

          });

      }


      const email =
        String(
          req.body.email || ""
        )
          .trim()
          .toLowerCase();


      const password =
        String(
          req.body.password || ""
        );


      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            email,
            password_hash,
            role,
            created_at
          FROM users
          WHERE email = $1
          `,
          [email]
        );


      if (
        !result.rows.length
      ) {

        return res
          .status(401)
          .json({

            success:
              false,

            error:
              "Invalid email or password."

          });

      }


      const user =
        result.rows[0];


      const valid =
        await bcrypt.compare(
          password,
          user.password_hash
        );


      if (!valid) {

        return res
          .status(401)
          .json({

            success:
              false,

            error:
              "Invalid email or password."

          });

      }


      const token =
        createToken(
          user
        );


      res.json({

        success:
          true,

        token,

        user: {

          id:
            user.id,

          name:
            user.name,

          email:
            user.email,

          role:
            user.role,

          createdAt:
            user.created_at

        }

      });

    } catch (error) {

      console.error(
        "LOGIN ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Login failed."

        });

    }

  }
);


/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  "/api/auth/me",
  requireAuth,
  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Database is not configured."

          });

      }


      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            email,
            role,
            created_at
          FROM users
          WHERE id = $1
          `,
          [req.user.id]
        );


      if (
        !result.rows.length
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              "User not found."

          });

      }


      res.json({

        success:
          true,

        user:
          result.rows[0]

      });

    } catch (error) {

      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Unable to load user."

        });

    }

  }
);


/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  async (
    req,
    res
  ) => {

    try {

      const password =
        String(
          req.body.password || ""
        );


      if (
        !password ||
        password !==
          ADMIN_PASSWORD
      ) {

        return res
          .status(401)
          .json({

            success:
              false,

            error:
              "Invalid admin password."

          });

      }


      /*
       * Find the database admin account.
       */

      let adminId =
        null;


      if (pool) {

        const result =
          await pool.query(
            `
            SELECT
              id,
              name,
              email,
              role
            FROM users
            WHERE email =
              'admin@videohub.local'
            LIMIT 1
            `
          );


        if (
          result.rows.length
        ) {

          adminId =
            result.rows[0].id;

        }

      }


      /*
       * Admin ID is required for likes,
       * comments and video ownership.
       */

      if (!adminId) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Admin database account is not ready."

          });

      }


      const token =
        jwt.sign(

          {
            id:
              adminId,

            email:
              "admin@videohub.local",

            role:
              "admin"

          },

          JWT_SECRET,

          {
            expiresIn:
              "7d"
          }

        );


      res.json({

        success:
          true,

        token

      });

    } catch (error) {

      console.error(
        "ADMIN LOGIN ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Admin login failed."

        });

    }

  }
);


/* =========================================================
   ADMIN STATUS
========================================================= */

app.get(
  "/api/admin/status",
  (
    req,
    res
  ) => {

    const user =
      getUserFromRequest(
        req
      );


    res.json({

      success:
        true,

      admin:
        !!user &&
        user.role ===
          "admin"

    });

  }
);


/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/api/admin/logout",
  (
    req,
    res
  ) => {

    /*
     * JWT logout is handled client-side
     * by removing the token.
     */

    res.json({

      success:
        true

    });

  }
);


/* =========================================================
   CREATE PRESIGNED UPLOAD URL
========================================================= */

app.post(
  "/api/upload/presign",
  requireAuth,
  async (
    req,
    res
  ) => {

    try {

      if (!s3) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "IDrive e2 storage is not configured."

          });

      }


      const filename =
        String(
          req.body.filename || ""
        )
          .trim();


      const contentType =
        String(
          req.body.contentType || ""
        )
          .trim()
          .toLowerCase();


      const size =
        Number(
          req.body.size || 0
        );


      if (!filename) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Filename is required."

          });

      }


      if (
        !isAllowedVideoType(
          contentType
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Only video files are allowed."

          });

      }


      if (
        !Number.isFinite(size) ||
        size <= 0
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Invalid file size."

          });

      }


      if (
        size >
        MAX_VIDEO_SIZE
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Maximum video size is 30 GB."

          });

      }


      const objectKey =
        makeObjectKey(
          filename
        );


      const command =
        new PutObjectCommand({

          Bucket:
            S3_BUCKET,

          Key:
            objectKey,

          ContentType:
            contentType,

          Metadata: {

            originalname:
              safeFileName(
                filename
              )

          }

        });


      const uploadUrl =
        await getSignedUrl(
          s3,
          command,
          {
            expiresIn:
              30 * 60
          }
        );


      res.json({

        success:
          true,

        uploadUrl,

        objectKey,

        expiresIn:
          1800

      });

    } catch (error) {

      console.error(
        "PRESIGN ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Unable to create upload URL."

        });

    }

  }
);


/* =========================================================
   COMPLETE UPLOAD
========================================================= */

app.post(
  "/api/upload/complete",
  requireAuth,
  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Database is not configured."

          });

      }


      if (!s3) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Storage is not configured."

          });

      }


      const objectKey =
        String(
          req.body.objectKey || ""
        )
          .trim();


      const filename =
        String(
          req.body.filename || ""
        )
          .trim();


      const title =
        String(
          req.body.title || ""
        )
          .trim()
          .slice(
            0,
            MAX_TITLE_LENGTH
          );


      const description =
        String(
          req.body.description || ""
        )
          .trim()
          .slice(
            0,
            MAX_DESCRIPTION_LENGTH
          );


      const mimeType =
        String(
          req.body.mimeType ||
          req.body.contentType ||
          ""
        )
          .trim()
          .toLowerCase();


      const requestedSize =
        Number(
          req.body.size || 0
        );


      if (!objectKey) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Object key is required."

          });

      }


      if (!title) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Video title is required."

          });

      }


      /*
       * Security:
       * only objects inside videos/
       * can be registered.
       */

      if (
        !objectKey.startsWith(
          "videos/"
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Invalid storage object."

          });

      }


      /*
       * Verify object exists in IDrive.
       */

      const head =
        await s3.send(

          new HeadObjectCommand({

            Bucket:
              S3_BUCKET,

            Key:
              objectKey

          })

        );


      const actualSize =
        Number(
          head.ContentLength ||
          requestedSize ||
          0
        );


      if (
        actualSize <= 0
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Uploaded object is empty."

          });

      }


      if (
        actualSize >
        MAX_VIDEO_SIZE
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Uploaded video is larger than 30GB."

          });

      }


      const result =
        await pool.query(
          `
          INSERT INTO videos
          (
            user_id,
            title,
            description,
            object_key,
            filename,
            mime_type,
            size,
            status
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'ready'
          )
          RETURNING *
          `,
          [
            req.user.id,

            title,

            description,

            objectKey,

            filename ||
              path.basename(
                objectKey
              ),

            mimeType ||
              head.ContentType ||
              "video/mp4",

            actualSize

          ]
        );


      res
        .status(201)
        .json({

          success:
            true,

          video:
            formatVideo(
              result.rows[0]
            )

        });

    } catch (error) {

      console.error(
        "COMPLETE UPLOAD ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Unable to complete upload."

        });

    }

  }
);


/* =========================================================
   GET ALL VIDEOS
========================================================= */

app.get(
  "/api/videos",
  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Database is not configured."

          });

      }


      const result =
        await pool.query(
          `
          SELECT
            v.*,

            (
              SELECT COUNT(*)
              FROM comments c
              WHERE c.video_id =
                v.id
            ) AS comments_count

          FROM videos v

          WHERE v.status =
            'ready'

          ORDER BY
            v.created_at DESC
          `
        );


      const videos =
        result.rows.map(
          (row) => ({

            ...formatVideo(
              row
            ),

            commentsCount:
              Number(
                row.comments_count ||
                0
              )

          })
        );


      const statsResult =
        await pool.query(
          `
          SELECT

            COUNT(*)::int
              AS total_videos,

            COALESCE(
              SUM(views),
              0
            )::bigint
              AS total_views,

            COALESCE(
              SUM(likes),
              0
            )::bigint
              AS total_likes,

            COALESCE(
              SUM(downloads),
              0
            )::bigint
              AS total_downloads

          FROM videos

          WHERE status =
            'ready'
          `
        );


      const stats =
        statsResult.rows[0];


      res.json({

        success:
          true,

        count:
          videos.length,

        videos,

        stats: {

          totalVideos:
            Number(
              stats.total_videos ||
              0
            ),

          totalViews:
            Number(
              stats.total_views ||
              0
            ),

          totalLikes:
            Number(
              stats.total_likes ||
              0
            ),

          totalDownloads:
            Number(
              stats.total_downloads ||
              0
            )

        }

      });

    } catch (error) {

      console.error(
        "GET VIDEOS ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Unable to load videos."

        });

    }

  }
);


/* =========================================================
   GET ONE VIDEO
========================================================= */

app.get(
  "/api/videos/:id",
  async (
    req,
    res
  ) => {

    try {

      if (
        !isValidId(
          req.params.id
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Invalid video ID."

          });

      }


      const result =
        await pool.query(
          `
          SELECT
            v.*,

            (
              SELECT COUNT(*)
              FROM comments c
              WHERE c.video_id =
                v.id
            ) AS comments_count

          FROM videos v

          WHERE v.id = $1
          `,
          [req.params.id]
        );


      if (
        !result.rows.length
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              "Video not found."

          });

      }


      const row =
        result.rows[0];


      res.json({

        success:
          true,

        video: {

          ...formatVideo(
            row
          ),

          commentsCount:
            Number(
              row.comments_count ||
              0
            )

        }

      });

    } catch (error) {

      console.error(
        "GET VIDEO ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Unable to load video."

        });

    }

  }
);


/* =========================================================
   STREAM VIDEO
========================================================= */

app.get(
  "/api/videos/:id/stream",
  async (
    req,
    res
  ) => {

    try {

      if (!pool || !s3) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Video storage is not configured."

          });

      }


      if (
        !isValidId(
          req.params.id
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Invalid video ID."

          });

      }


      const result =
        await pool.query(
          `
          SELECT *
          FROM videos
          WHERE id = $1
          `,
          [req.params.id]
        );


      if (
        !result.rows.length
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              "Video not found."

          });

      }


      const video =
        result.rows[0];


      const head =
        await s3.send(

          new HeadObjectCommand({

            Bucket:
              S3_BUCKET,

            Key:
              video.object_key

          })

        );


      const totalSize =
        Number(
          head.ContentLength ||
          video.size ||
          0
        );


      const contentType =
        video.mime_type ||
        head.ContentType ||
        "video/mp4";


      res.setHeader(
        "Content-Type",
        contentType
      );

      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=3600"
      );


      const range =
        req.headers.range;


      if (!range) {

        const command =
          new GetObjectCommand({

            Bucket:
              S3_BUCKET,

            Key:
              video.object_key

          });


        const object =
          await s3.send(
            command
          );


        res.setHeader(
          "Content-Length",
          String(
            totalSize
          )
        );


        object.Body.pipe(
          res
        );


        return;

      }


      const match =
        range.match(
          /^bytes=(\d*)-(\d*)$/
        );


      if (!match) {

        res.status(416);

        res.setHeader(
          "Content-Range",
          `bytes */${totalSize}`
        );

        return res.end();

      }


      let start =
        match[1]
          ? Number(match[1])
          : 0;


      let end =
        match[2]
          ? Number(match[2])
          : totalSize - 1;


      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= totalSize
      ) {

        res.status(416);

        res.setHeader(
          "Content-Range",
          `bytes */${totalSize}`
        );

        return res.end();

      }


      if (
        end >= totalSize
      ) {

        end =
          totalSize - 1;

      }


      const contentLength =
        end -
        start +
        1;


      const command =
        new GetObjectCommand({

          Bucket:
            S3_BUCKET,

          Key:
            video.object_key,

          Range:
            `bytes=${start}-${end}`
        });


      const object =
        await s3.send(
          command
        );


      res.status(206);


      res.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${totalSize}`
      );


      res.setHeader(
        "Content-Length",
        String(
          contentLength
        )
      );


      object.Body.pipe(
        res
      );

    } catch (error) {

      console.error(
        "STREAM ERROR:",
        error
      );


      if (
        !res.headersSent
      ) {

        res
          .status(500)
          .json({

            success:
              false,

            error:
              "Unable to stream video."

          });

      } else {

        res.end();

      }

    }

  }
);


/* =========================================================
   VIDEO VIEW
========================================================= */

app.post(
  "/api/videos/:id/view",
  async (
    req,
    res
  ) => {

    try {

      if (!pool) {

        return res
          .status(500)
          .json({

            success:
              false,

            error:
              "Database is not configured."

          });

      }


      const result =
        await pool.query(
          `
          UPDATE videos
          SET views =
            views + 1
          WHERE id = $1
          RETURNING views
          `,
          [req.params.id]
        );


      if (
        !result.rows.length
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              "Video not found."

          });

      }


      res.json({

        success:
          true,

        views:
          Number(
            result.rows[0].views
          )

      });

    } catch (error) {

      console.error(
        "VIEW ERROR:",
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            "Unable to update views."

        });

    }

  }
);


/* =========================================================
   LIKE VIDEO
========================================================= */

app.post(
  "/api/videos/:id/like",
  requireAuth,
  async (
    req,
    res
  ) => {

    if (!pool) {

      return res
        .status(500)
        .json({

          success:
            false,

          error:
            "Database is not configured."

        });

    }


    const client =
      await pool.connect();


    try {

      await client.query(
        "BEGIN"
      );


      const video =
        await client.query(
          `
          SELECT
            id,
            likes
          FROM videos
          WHERE id = $1
          FOR UPDATE
          `,
          [req.params.id]
        );


      if (
        !video.rows.length
      ) {

        await client.query(
          "ROLLBACK"
        );


        return res
          .status(404)
          .json({

            success:
              false,

            error:
              "Video not found."

          });

      }


      const existing =
        await client.query(
          `
          SELECT id
          FROM likes
          WHERE video_id = $1
          AND user_id = $2
          `,
          [
            req.params.id,
            req.user.id
          ]
        );


      let liked;


      if (
        existing.rows.length
      ) {

        await client.query(
          `
          DELETE FROM likes
          WHERE video_id = $1
          AND user_id = $2
          `,
          [
            req.params.id,
            req.user.id
          ]
        );


        await client.query(
          `
          UPDATE videos
          SET likes =
            GREATEST(
              likes - 1,
              0
            )
          WHERE id = $1
          `,
          [req.params.id]
        );


        liked =
          false;

      } else {

        await client.query(
          `
          INSERT INTO likes
          (
            video_id,
            user_id
          )
          VALUES
          (
            $1,
            $2
          )
          `,
          [
            req.params.id,
            req.user.id
          ]
        );


        await client.query(
          `
