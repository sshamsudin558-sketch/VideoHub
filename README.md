# VideoHub

Modern video sharing and streaming platform with user authentication, video upload, streaming, downloads, likes, comments, admin dashboard, PostgreSQL and S3-compatible object storage.

## Features

- User registration and login
- JWT authentication
- Admin authentication
- Video upload
- Video streaming
- Video download
- Video views
- Likes
- Comments
- Video editing
- Video deletion
- Admin dashboard
- User management
- Revenue tracking
- Storage connection testing
- PostgreSQL database
- S3-compatible object storage
- Responsive modern UI

## Technology

- Node.js
- Express.js
- PostgreSQL
- JWT
- bcrypt
- AWS SDK for S3-compatible storage
- HTML
- CSS
- JavaScript

## Environment Variables

Configure these environment variables before running the server:

```env
PORT=10000

DATABASE_URL=your_postgresql_connection_string

JWT_SECRET=your_secure_jwt_secret

ADMIN_PASSWORD=your_secure_admin_password

S3_ACCESS_KEY_ID=your_storage_access_key

S3_SECRET_ACCESS_KEY=your_storage_secret_key

S3_BUCKET=videohub-storage

S3_REGION=us-west-4

S3_ENDPOINT=https://s3.us-west-4.idrivee2.com
