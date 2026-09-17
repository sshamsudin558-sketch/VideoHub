# Modern Video Hub

A modern self-hosted video upload and streaming website.

## Run locally

1. Install Node.js.
2. Open this folder in a terminal.
3. Run:
   npm install
   npm start
4. Open http://localhost:10000

## Storage

Uploaded videos are saved in the `uploads` folder.

For a production deployment, mount persistent storage at the `UPLOAD_DIR` environment variable. A 30 GB capacity requires at least a 30 GB persistent disk. This project does not magically provide 30 GB on a free hosting plan.

## Supported videos

MP4, WebM, OGG, MOV and M4V.

## Important production work

Before exposing this publicly, add authentication, upload quotas, file validation, rate limiting, virus scanning, HTTPS, and a database for user/video metadata.
