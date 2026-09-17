const express = require("express"); const crypto = require("crypto"); const path = require("path"); const bcrypt = require("bcryptjs"); const jwt = require("jsonwebtoken"); const { Pool } = require("pg");

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

/* ========================================================= BASIC CONFIG ========================================================= */

const PORT = process.env.PORT || 10000;

const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.json({ limit: "10mb" })); app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

/* ========================================================= ENVIRONMENT ========================================================= */

const DATABASE_URL = process.env.DATABASE_URL;

const JWT_SECRET = process.env.JWT_SECRET || "VideoHub-development-secret-change-this";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "CHANGE_ADMIN_PASSWORD";

/* Access Key ID is not a secret by itself. Secret Access Key MUST be stored in Render Environment Variables. */

const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "aabgP1PKuw0y0rhvl1UQ";

const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

const S3_BUCKET = process.env.S3_BUCKET || "videohub-storage";

const S3_REGION = process.env.S3_REGION || "us-west-4";

const S3_ENDPOINT = process.env.S3_ENDPOINT || "https://s3.us-west-4.idrivee2.com";

/* ========================================================= DATABASE ========================================================= */

if (!DATABASE_URL) { console.warn( "WARNING: DATABASE_URL is not configured." ); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

/* ========================================================= IDRIVE E2 / S3 ========================================================= */

let s3 = null;

if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) { s3 = new S3Client({ region: S3_REGION, endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } }); } else { console.warn( "WARNING: IDrive e2 credentials are not configured." ); }

/* ========================================================= DATABASE INITIALIZATION ========================================================= */

async function initializeDatabase() { if (!DATABASE_URL) { console.warn( "Database initialization skipped because DATABASE_URL is missing." );

return; 

}

const client = await pool.connect();

try { await client.query(` CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL, role VARCHAR(30) DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE IF NOT EXISTS videos ( id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, title VARCHAR(255) NOT NULL, description TEXT DEFAULT '', object_key TEXT UNIQUE NOT NULL, filename TEXT NOT NULL, mime_type VARCHAR(150), size BIGINT DEFAULT 0, views BIGINT DEFAULT 0, likes BIGINT DEFAULT 0, downloads BIGINT DEFAULT 0, status VARCHAR(30) DEFAULT 'ready', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ); CREATE TABLE IF NOT EXISTS comments ( id SERIAL PRIMARY KEY, video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, text TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ); CREATE TABLE IF NOT EXISTS likes ( id SERIAL PRIMARY KEY, video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(video_id, user_id) ); CREATE TABLE IF NOT EXISTS revenue ( id SERIAL PRIMARY KEY, video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE, amount NUMERIC(12,2) DEFAULT 0, source VARCHAR(100) DEFAULT 'ads', status VARCHAR(30) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ); `); console.log("PostgreSQL database initialized."); 

} catch (error) { console.error( "Database initialization error:", error.message ); } finally { client.release(); } }

/* ========================================================= HELPERS ========================================================= */

function makeObjectKey(filename) { const extension = path.extname(filename || "") .toLowerCase() .replace(/[^a-z0-9.]/g, "");

const random = crypto.randomBytes(12).toString("hex");

return videos/${Date.now()}-${random}${extension}; }

function safeFileName(filename) { return path .basename(filename || "video") .replace(/[^a-zA-Z0-9.-]/g, ""); }

function createToken(user) { return jwt.sign( { id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" } ); }

function getTokenFromRequest(req) { const auth = req.headers.authorization || "";

if (!auth.startsWith("Bearer ")) { return null; }

return auth.substring(7); }

function getUserFromRequest(req) { const token = getTokenFromRequest(req);

if (!token) { return null; }

try { return jwt.verify( token, JWT_SECRET ); } catch { return null; } }

function requireAuth(req, res, next) { const user = getUserFromRequest(req);

if (!user) { return res.status(401).json({ success: false, message: "Authentication required." }); }

req.user = user;

next(); }

function requireAdmin(req, res, next) { const user = getUserFromRequest(req);

if (!user || user.role !== "admin") { return res.status(403).json({ success: false, message: "Admin access required." }); }

req.user = user;

next(); }

function formatVideo(row) { return { id: row.id, userId: row.user_id, title: row.title, description: row.description || "", objectKey: row.object_key, originalName: row.filename, fileName: path.basename(row.object_key), contentType: row.mime_type, mimeType: row.mime_type, size: Number(row.size || 0), views: Number(row.views || 0), likes: Number(row.likes || 0), downloads: Number(row.downloads || 0), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }

function isAllowedVideoType(contentType) { const allowed = [ "video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v" ];

return allowed.includes( String(contentType || "").toLowerCase() ); }

/* ========================================================= HEALTH ========================================================= */

app.get("/api/health", async (req, res) => { let database = "not configured";

if (DATABASE_URL) { try { await pool.query("SELECT 1"); database = "connected"; } catch { database = "connection failed"; } }

res.json({ success: true, service: "VideoHub", database, storage: s3 ? "configured" : "not configured", bucket: S3_BUCKET, region: S3_REGION, time: new Date().toISOString() }); });

/* ========================================================= AUTH - REGISTER ========================================================= */

app.post( "/api/auth/register", async (req, res) => { try { const name = String(req.body.name || "") .trim() .slice(0, 120);

const email = String(req.body.email || "") .trim() .toLowerCase() .slice(0, 255); const password = String(req.body.password || ""); if (!name || !email || !password) { return res.status(400).json({ success: false, message: "Name, email and password are required." }); } if (password.length < 6) { return res.status(400).json({ success: false, message: "Password must be at least 6 characters." }); } if (!DATABASE_URL) { return res.status(500).json({ success: false, message: "Database is not configured." }); } const existing = await pool.query( "SELECT id FROM users WHERE email = $1", [email] ); if (existing.rows.length) { return res.status(409).json({ success: false, message: "An account with this email already exists." }); } const passwordHash = await bcrypt.hash( password, 12 ); const result = await pool.query( ` INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'user') RETURNING id, name, email, role, created_at `, [ name, email, passwordHash ] ); res.status(201).json({ success: true, message: "Account created successfully.", user: result.rows[0] }); } catch (error) { console.error( "REGISTER ERROR:", error.message ); res.status(500).json({ success: false, message: "Registration failed." }); } 

} );

/* ========================================================= AUTH - LOGIN ========================================================= */

app.post( "/api/auth/login", async (req, res) => { try { const email = String(req.body.email || "") .trim() .toLowerCase();

const password = String(req.body.password || ""); if (!email || !password) { return res.status(400).json({ success: false, message: "Email and password are required." }); } const result = await pool.query( ` SELECT id, name, email, password_hash, role, created_at FROM users WHERE email = $1 `, [email] ); if (!result.rows.length) { return res.status(401).json({ success: false, message: "Invalid email or password." }); } const user = result.rows[0]; const valid = await bcrypt.compare( password, user.password_hash ); if (!valid) { return res.status(401).json({ success: false, message: "Invalid email or password." }); } const token = createToken(user); res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.created_at } }); } catch (error) { console.error( "LOGIN ERROR:", error.message ); res.status(500).json({ success: false, message: "Login failed." }); } 

} );

/* ========================================================= AUTH - CURRENT USER ========================================================= */

app.get( "/api/auth/me", requireAuth, async (req, res) => { try { const result = await pool.query( SELECT id, name, email, role, created_at FROM users WHERE id = $1, [req.user.id] );

if (!result.rows.length) { return res.status(404).json({ success: false, message: "User not found." }); } res.json({ success: true, user: result.rows[0] }); } catch (error) { res.status(500).json({ success: false, message: "Unable to load user." }); } 

} );

/* ========================================================= ADMIN LOGIN ========================================================= */

app.post( "/api/admin/login", async (req, res) => { const password = String(req.body.password || "");

if ( !password || password !== ADMIN_PASSWORD ) { return res.status(401).json({ success: false, message: "Invalid admin password." }); } /* Admin token is a JWT too. This avoids storing sessions only in Render memory. */ const token = jwt.sign( { role: "admin", email: "admin@videohub.local" }, JWT_SECRET, { expiresIn: "7d" } ); res.json({ success: true, token }); 

} );

/* ========================================================= ADMIN STATUS ========================================================= */

app.get( "/api/admin/status", (req, res) => { const user = getUserFromRequest(req);

res.json({ success: true, admin: !!user && user.role === "admin" }); 

} );

/* ========================================================= ADMIN LOGOUT ========================================================= */

app.post( "/api/admin/logout", (req, res) => { /* JWT is stateless. Client should remove the token. */

res.json({ success: true }); 

} );

/* ========================================================= PRESIGNED UPLOAD ========================================================= */

app.post( "/api/upload/presign", requireAuth, async (req, res) => { try { if (!s3) { return res.status(500).json({ success: false, message: "IDrive e2 storage is not configured." }); }

const filename = String(req.body.filename || "") .trim(); const contentType = String(req.body.contentType || "") .trim(); const size = Number(req.body.size || 0); if (!filename) { return res.status(400).json({ success: false, message: "Filename is required." }); } if (!isAllowedVideoType(contentType)) { return res.status(400).json({ success: false, message: "Only supported video files are allowed." }); } if (!Number.isFinite(size) || size <= 0) { return res.status(400).json({ success: false, message: "Invalid file size." }); } /* Maximum requested size: 30 GB. Actual IDrive account/storage limits may still apply. */ const maxSize = 30 * 1024 * 1024 * 1024; if (size > maxSize) { return res.status(400).json({ success: false, message: "Maximum allowed video size is 30 GB." }); } const objectKey = makeObjectKey(filename); const command = new PutObjectCommand({ Bucket: S3_BUCKET, Key: objectKey, ContentType: contentType, Metadata: { originalname: safeFileName(filename) } }); const uploadUrl = await getSignedUrl( s3, command, { expiresIn: 60 * 30 } ); res.json({ success: true, uploadUrl, objectKey, expiresIn: 1800 }); } catch (error) { console.error( "PRESIGN ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to create upload URL." }); } 

} );

/* ========================================================= COMPLETE UPLOAD ========================================================= */

app.post( "/api/upload/complete", requireAuth, async (req, res) => { try { const objectKey = String(req.body.objectKey || "") .trim();

const filename = String(req.body.filename || "") .trim(); const title = String( req.body.title || path.parse(filename).name || "Untitled Video" ) .trim() .slice(0, 255); const description = String(req.body.description || "") .trim() .slice(0, 5000); const mimeType = String(req.body.mimeType || "") .trim(); const size = Number(req.body.size || 0); if (!objectKey || !filename) { return res.status(400).json({ success: false, message: "Upload information is incomplete." }); } if (!s3) { return res.status(500).json({ success: false, message: "Storage is not configured." }); } /* Verify that the object actually exists in IDrive e2 before creating the DB record. */ const head = await s3.send( new HeadObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }) ); const actualSize = Number( head.ContentLength || size || 0 ); const actualMime = head.ContentType || mimeType || "video/mp4"; const result = await pool.query( ` INSERT INTO videos ( user_id, title, description, object_key, filename, mime_type, size, status ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready') RETURNING * `, [ req.user.id, title, description, objectKey, filename, actualMime, actualSize ] ); const video = formatVideo( result.rows[0] ); res.status(201).json({ success: true, message: "Video uploaded successfully.", videoId: video.id, objectKey: video.objectKey, video }); } catch (error) { console.error( "UPLOAD COMPLETE ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to complete video upload." }); } 

} );

/* ========================================================= GET ALL VIDEOS ========================================================= */

app.get( "/api/videos", async (req, res) => { try { const search = String(req.query.search || "") .trim();

let result; if (search) { result = await pool.query( ` SELECT * FROM videos WHERE status = 'ready' AND ( title ILIKE $1 OR description ILIKE $1 OR filename ILIKE $1 ) ORDER BY created_at DESC `, [`%${search}%`] ); } else { result = await pool.query( ` SELECT * FROM videos WHERE status = 'ready' ORDER BY created_at DESC ` ); } const list = result.rows.map(formatVideo); const totals = await pool.query(` SELECT COUNT(*)::int AS total_videos, COALESCE(SUM(views), 0)::bigint AS total_views, COALESCE(SUM(likes), 0)::bigint AS total_likes, COALESCE(SUM(downloads), 0)::bigint AS total_downloads FROM videos WHERE status = 'ready' `); const stats = totals.rows[0]; res.json({ success: true, count: list.length, videos: list, stats: { totalVideos: Number( stats.total_videos || 0 ), totalViews: Number( stats.total_views || 0 ), totalLikes: Number( stats.total_likes || 0 ), totalDownloads: Number( stats.total_downloads || 0 ) } }); } catch (error) { console.error( "GET VIDEOS ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to load videos." }); } 

} );

/* ========================================================= GET SINGLE VIDEO ========================================================= */

app.get( "/api/videos/:id", async (req, res) => { try { const result = await pool.query( SELECT * FROM videos WHERE id = $1, [req.params.id] );

if (!result.rows.length) { return res.status(404).json({ success: false, message: "Video not found." }); } const video = formatVideo( result.rows[0] ); res.json({ success: true, video }); } catch (error) { console.error( "GET VIDEO ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to load video." }); } 

} );

/* ========================================================= STREAM VIDEO ========================================================= */

app.get( "/api/videos/:id/stream", async (req, res) => { try { if (!s3) { return res.status(500).send( "Storage is not configured." ); }

const result = await pool.query( ` SELECT * FROM videos WHERE id = $1 `, [req.params.id] ); if (!result.rows.length) { return res.status(404).send( "Video not found." ); } const video = result.rows[0]; const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: video.object_key, ResponseContentType: video.mime_type || "video/mp4" }); const streamUrl = await getSignedUrl( s3, command, { expiresIn: 60 * 60 } ); res.redirect(streamUrl); } catch (error) { console.error( "STREAM ERROR:", error.message ); res.status(500).send( "Unable to stream video." ); } 

} );

/* ========================================================= LEGACY STREAM ROUTE ========================================================= */

app.get( "/videos/:id", async (req, res) => { try { const result = await pool.query( SELECT object_key FROM videos WHERE id = $1, [req.params.id] );

if (!result.rows.length) { return res.status(404).send( "Video not found." ); } if (!s3) { return res.status(500).send( "Storage is not configured." ); } const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: result.rows[0].object_key }); const streamUrl = await getSignedUrl( s3, command, { expiresIn: 60 * 60 } ); res.redirect(streamUrl); } catch (error) { console.error( "LEGACY STREAM ERROR:", error.message ); res.status(500).send( "Unable to stream video." ); } 

} );

/* ========================================================= VIEW ========================================================= */

app.post( "/api/videos/:id/view", async (req, res) => { try { const result = await pool.query( UPDATE videos SET views = views + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING views, [req.params.id] );

if (!result.rows.length) { return res.status(404).json({ success: false, message: "Video not found." }); } res.json({ success: true, views: Number( result.rows[0].views ) }); } catch (error) { res.status(500).json({ success: false, message: "Unable to update views." }); } 

} );

/* ========================================================= LIKE / UNLIKE ========================================================= */

app.post( "/api/videos/:id/like", requireAuth, async (req, res) => { const client = await pool.connect();

try { await client.query( "BEGIN" ); const video = await client.query( ` SELECT id FROM videos WHERE id = $1 `, [req.params.id] ); if (!video.rows.length) { await client.query( "ROLLBACK" ); return res.status(404).json({ success: false, message: "Video not found." }); } const existing = await client.query( ` SELECT id FROM likes WHERE video_id = $1 AND user_id = $2 `, [ req.params.id, req.user.id ] ); let liked; if (existing.rows.length) { await client.query( ` DELETE FROM likes WHERE video_id = $1 AND user_id = $2 `, [ req.params.id, req.user.id ] ); await client.query( ` UPDATE videos SET likes = GREATEST(likes - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE id = $1 `, [req.params.id] ); liked = false; } else { await client.query( ` INSERT INTO likes (video_id, user_id) VALUES ($1, $2) `, [ req.params.id, req.user.id ] ); await client.query( ` UPDATE videos SET likes = likes + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 `, [req.params.id] ); liked = true; } const count = await client.query( ` SELECT likes FROM videos WHERE id = $1 `, [req.params.id] ); await client.query( "COMMIT" ); res.json({ success: true, liked, likes: Number( count.rows[0].likes ) }); } catch (error) { await client.query( "ROLLBACK" ); console.error( "LIKE ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to update like." }); } finally { client.release(); } 

} );

/* ========================================================= CHECK LIKE ========================================================= */

app.get( "/api/videos/:id/like", requireAuth, async (req, res) => { try { const result = await pool.query( SELECT id FROM likes WHERE video_id = $1 AND user_id = $2, [ req.params.id, req.user.id ] );

res.json({ success: true, liked: result.rows.length > 0 }); } catch (error) { res.status(500).json({ success: false, liked: false }); } 

} );

/* ========================================================= COMMENTS - GET ========================================================= */

app.get( "/api/videos/:id/comments", async (req, res) => { try { const result = await pool.query( SELECT c.id, c.video_id, c.user_id, c.text, c.created_at, COALESCE( u.name, 'Anonymous' ) AS name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.video_id = $1 ORDER BY c.created_at DESC, [req.params.id] );

res.json({ success: true, comments: result.rows.map( row => ({ id: row.id, videoId: row.video_id, userId: row.user_id, name: row.name, text: row.text, createdAt: row.created_at }) ) }); } catch (error) { console.error( "COMMENTS GET ERROR:", error.message ); res.status(500).json({ success: false, comments: [] }); } 

} );

/* ========================================================= COMMENTS - POST ========================================================= */

app.post( "/api/videos/:id/comments", requireAuth, async (req, res) => { try { const text = String(req.body.text || "") .trim() .slice(0, 1000);

if (!text) { return res.status(400).json({ success: false, message: "Comment is required." }); } const video = await pool.query( ` SELECT id FROM videos WHERE id = $1 `, [req.params.id] ); if (!video.rows.length) { return res.status(404).json({ success: false, message: "Video not found." }); } const result = await pool.query( ` INSERT INTO comments (video_id, user_id, text) VALUES ($1, $2, $3) RETURNING id, video_id, user_id, text, created_at `, [ req.params.id, req.user.id, text ] ); const comment = result.rows[0]; res.status(201).json({ success: true, comment: { id: comment.id, videoId: comment.video_id, userId: comment.user_id, name: req.user.email, text: comment.text, createdAt: comment.created_at } }); } catch (error) { console.error( "COMMENTS POST ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to post comment." }); } 

} );

/* ========================================================= DOWNLOAD ========================================================= */

app.get( "/api/videos/:id/download", async (req, res) => { try { const result = await pool.query( SELECT * FROM videos WHERE id = $1, [req.params.id] );

if (!result.rows.length) { return res.status(404).json({ success: false, message: "Video not found." }); } if (!s3) { return res.status(500).json({ success: false, message: "Storage is not configured." }); } const video = result.rows[0]; await pool.query( ` UPDATE videos SET downloads = downloads + 1 WHERE id = $1 `, [req.params.id] ); const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: video.object_key, ResponseContentType: video.mime_type || "application/octet-stream", ResponseContentDisposition: `attachment; filename="${safeFileName( video.filename )}"` }); const downloadUrl = await getSignedUrl( s3, command, { expiresIn: 60 * 30 } ); res.json({ success: true, downloadUrl }); } catch (error) { console.error( "DOWNLOAD ERROR:", error.message ); res.status(500).json({ success: false, message: "Download failed." }); } 

} );

/* ========================================================= EDIT VIDEO ========================================================= */

app.put( "/api/videos/:id", requireAuth, async (req, res) => { try { const current = await pool.query( SELECT * FROM videos WHERE id = $1, [req.params.id] );

if (!current.rows.length) { return res.status(404).json({ success: false, message: "Video not found." }); } const video = current.rows[0]; const isOwner = Number(video.user_id) === Number(req.user.id); const isAdmin = req.user.role === "admin"; if (!isOwner && !isAdmin) { return res.status(403).json({ success: false, message: "You cannot edit this video." }); } const title = req.body.title !== undefined ? String(req.body.title) .trim() .slice(0, 255) : video.title; const description = req.body.description !== undefined ? String(req.body.description) .trim() .slice(0, 5000) : video.description; const result = await pool.query( ` UPDATE videos SET title = $1, description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING * `, [ title, description, req.params.id ] ); res.json({ success: true, video: formatVideo( result.rows[0] ) }); } catch (error) { console.error( "EDIT ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to edit video." }); } 

} );

/* ========================================================= DELETE VIDEO ========================================================= */

app.delete( "/api/videos/:id", requireAuth, async (req, res) => { try { const result = await pool.query( SELECT * FROM videos WHERE id = $1, [req.params.id] );

if (!result.rows.length) { return res.status(404).json({ success: false, message: "Video not found." }); } const video = result.rows[0]; const isOwner = Number(video.user_id) === Number(req.user.id); const isAdmin = req.user.role === "admin"; if (!isOwner && !isAdmin) { return res.status(403).json({ success: false, message: "You cannot delete this video." }); } if (s3) { try { await s3.send( new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: video.object_key }) ); } catch (storageError) { console.error( "STORAGE DELETE ERROR:", storageError.message ); } } await pool.query( ` DELETE FROM videos WHERE id = $1 `, [req.params.id] ); res.json({ success: true, message: "Video deleted successfully." }); } catch (error) { console.error( "DELETE ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to delete video." }); } 

} );

/* ========================================================= ADMIN STATISTICS ========================================================= */

app.get( "/api/admin/stats", requireAdmin, async (req, res) => { try { const stats = await pool.query(SELECT COUNT(*)::int AS total_videos, COALESCE( SUM(views), 0 )::bigint AS total_views, COALESCE( SUM(likes), 0 )::bigint AS total_likes, COALESCE( SUM(downloads), 0 )::bigint AS total_downloads FROM videos);

const users = await pool.query(` SELECT COUNT(*)::int AS total_users FROM users `); const revenue = await pool.query(` SELECT COALESCE( SUM(amount), 0 )::numeric AS total_revenue FROM revenue WHERE status = 'paid' `); const s = stats.rows[0]; res.json({ success: true, totalVideos: Number( s.total_videos || 0 ), totalUsers: Number( users.rows[0] .total_users || 0 ), totalViews: Number( s.total_views || 0 ), totalLikes: Number( s.total_likes || 0 ), totalDownloads: Number( s.total_downloads || 0 ), revenue: Number( revenue.rows[0] .total_revenue || 0 ) }); } catch (error) { console.error( "ADMIN STATS ERROR:", error.message ); res.status(500).json({ success: false, message: "Unable to load statistics." }); } 

} );

/* ========================================================= ADMIN STATISTICS - OLD COMPATIBILITY ROUTE ========================================================= */

app.get( "/api/admin/statistics", requireAdmin, async (req, res) => { try { const result = await pool.query(SELECT COUNT(*)::int AS videos, COALESCE( SUM(views), 0 )::bigint AS views, COALESCE( SUM(likes), 0 )::bigint AS likes, COALESCE( SUM(downloads), 0 )::bigint AS downloads, COALESCE( SUM(size), 0 )::bigint AS storage_bytes FROM videos);

const row = result.rows[0]; res.json({ success: true, statistics: { videos: Number(row.videos || 0), views: Number(row.views || 0), likes: Number(row.likes || 0), downloads: Number(row.downloads || 0), storageBytes: Number( row.storage_bytes || 0 ), storageGB: Number( row.storage_bytes || 0 ) / (1024 * 1024 * 1024) } }); } catch (error) { res.status(500).json({ success: false, message: "Unable to load statistics." }); } 

} );

/* ========================================================= ADMIN VIDEOS ========================================================= */

app.get( "/api/admin/videos", requireAdmin, async (req, res) => { try { const result = await pool.query(SELECT * FROM videos ORDER BY created_at DESC LIMIT 100);

res.json({ success: true, videos: result.rows.map( formatVideo ) }); } catch (error) { res.status(500).json({ success: false, message: "Unable to load admin videos." }); } 

} );

/* ========================================================= ADMIN USERS ========================================================= */

app.get( "/api/admin/users", requireAdmin, async (req, res) => { try { const result = await pool.query(SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 100);

res.json({ success: true, users: result.rows }); } catch (error) { res.status(500).json({ success: false, message: "Unable to load users." }); } 

} );

/* ========================================================= ADMIN REVENUE ========================================================= */

app.get( "/api/admin/revenue", requireAdmin, async (req, res) => { try { const result = await pool.query(SELECT r.id, r.video_id, r.amount, r.source, r.status, r.created_at, v.title AS video_title FROM revenue r LEFT JOIN videos v ON v.id = r.video_id ORDER BY r.created_at DESC LIMIT 100);

res.json({ success: true, revenue: result.rows }); } catch (error) { res.status(500).json({ success: false, message: "Unable to load revenue." }); } 

} );

/* ========================================================= MONETIZATION ========================================================= */

app.get( "/api/admin/monetization", requireAdmin, async (req, res) => { res.json({ success: true, monetization: { enabled: false, provider: null, message: "Connect an approved advertising provider before activating real monetization." } }); } );

/* ========================================================= STORAGE TEST ========================================================= */

app.get( "/api/admin/storage-test", requireAdmin, async (req, res) => { try { if (!s3) { return res.status(500).json({ success: false, storage: "Not configured" }); }

await s3.send( new HeadBucketCommand({ Bucket: S3_BUCKET }) ); res.json({ success: true, storage: "Connected", bucket: S3_BUCKET, region: S3_REGION }); } catch (error) { console.error( "STORAGE TEST ERROR:", error.message ); res.status(500).json({ success: false, storage: "Connection failed", error: error.message }); } 

} );

/* ========================================================= ERROR HANDLER ========================================================= */

app.use( (error, req, res, next) => { console.error( "SERVER ERROR:", error );

res.status(500).json({ success: false, message: error.message || "Internal server error." }); 

} );

/* ========================================================= SPA FALLBACK ========================================================= */

/* Express 5 compatible wildcard. This must be AFTER API routes. */

app.get( "/{*splat}", (req, res) => { res.sendFile( path.join( PUBLIC_DIR, "index.html" ) ); } );

/* ========================================================= START ========================================================= */

async function startServer() { await initializeDatabase();

app.listen( PORT, () => { console.log( VideoHub running on port ${PORT} );

console.log( `IDrive e2 bucket: ${S3_BUCKET}` ); console.log( `IDrive e2 region: ${S3_REGION}` ); console.log( `Database: ${ DATABASE_URL ? "configured" : "NOT CONFIGURED" }` ); console.log( `Storage: ${ s3 ? "configured" : "NOT CONFIGURED" }` ); } 

); }

startServer().catch( error => { console.error( "SERVER START ERROR:", error );

process.exit(1); 

} );

