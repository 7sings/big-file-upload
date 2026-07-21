CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  declared_mime TEXT NOT NULL,
  quick_fingerprint TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS uploads_user_status ON uploads(user_id, status);
CREATE INDEX IF NOT EXISTS uploads_resume ON uploads(user_id, quick_fingerprint, byte_size);
CREATE INDEX IF NOT EXISTS uploads_resume_modified ON uploads(user_id, quick_fingerprint, byte_size, last_modified, status);
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(upload_id, part_number)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id TEXT REFERENCES uploads(id),
  object_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  detected_mime TEXT NOT NULL,
  quick_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS files_user_created ON files(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_dedupe ON files(user_id, quick_fingerprint, byte_size, status);
