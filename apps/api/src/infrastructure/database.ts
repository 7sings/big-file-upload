import { createClient, type Client, type InValue, type Row } from '@libsql/client';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, storage_upload_id TEXT NOT NULL, object_key TEXT NOT NULL, original_name TEXT NOT NULL, byte_size INTEGER NOT NULL, declared_mime TEXT NOT NULL, quick_fingerprint TEXT NOT NULL, last_modified INTEGER NOT NULL, part_size INTEGER NOT NULL, total_parts INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS uploads_user_status ON uploads(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS uploads_resume ON uploads(user_id, quick_fingerprint, byte_size)`,
  `CREATE INDEX IF NOT EXISTS uploads_resume_modified ON uploads(user_id, quick_fingerprint, byte_size, last_modified, status)`,
  `CREATE TABLE IF NOT EXISTS upload_parts (upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, part_number INTEGER NOT NULL, etag TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(upload_id, part_number))`,
  `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, upload_id TEXT REFERENCES uploads(id), object_key TEXT NOT NULL, original_name TEXT NOT NULL, byte_size INTEGER NOT NULL, detected_mime TEXT NOT NULL, quick_fingerprint TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS files_user_created ON files(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS files_dedupe ON files(user_id, quick_fingerprint, byte_size, status)`,
];

export interface UserRow { id: string; email: string; createdAt: number }
export interface UploadRow { id: string; userId: string; storageUploadId: string; objectKey: string; originalName: string; byteSize: number; declaredMime: string; quickFingerprint: string; lastModified: number; partSize: number; totalParts: number; status: string; createdAt: number; updatedAt: number; expiresAt: number; error: string | null }
export interface PartRow { partNumber: number; etag: string; size: number }
export interface FileRow { id: string; userId: string; uploadId: string | null; objectKey: string; originalName: string; byteSize: number; detectedMime: string; quickFingerprint: string; status: string; createdAt: number; deletedAt: number | null }

const num = (value: unknown) => Number(value);
function upload(row: Row): UploadRow { return { id: String(row.id), userId: String(row.user_id), storageUploadId: String(row.storage_upload_id), objectKey: String(row.object_key), originalName: String(row.original_name), byteSize: num(row.byte_size), declaredMime: String(row.declared_mime), quickFingerprint: String(row.quick_fingerprint), lastModified: num(row.last_modified), partSize: num(row.part_size), totalParts: num(row.total_parts), status: String(row.status), createdAt: num(row.created_at), updatedAt: num(row.updated_at), expiresAt: num(row.expires_at), error: row.error == null ? null : String(row.error) }; }
function file(row: Row): FileRow { return { id: String(row.id), userId: String(row.user_id), uploadId: row.upload_id == null ? null : String(row.upload_id), objectKey: String(row.object_key), originalName: String(row.original_name), byteSize: num(row.byte_size), detectedMime: String(row.detected_mime), quickFingerprint: String(row.quick_fingerprint), status: String(row.status), createdAt: num(row.created_at), deletedAt: row.deleted_at == null ? null : num(row.deleted_at) }; }

export class Database {
  constructor(readonly client: Client) {}
  static connect(url: string, authToken?: string): Database { return new Database(createClient({ url, authToken })); }
  async migrate(): Promise<void> { for (const sql of MIGRATIONS) await this.client.execute(sql); }
  async close(): Promise<void> { this.client.close(); }
  private async rows(sql: string, args: InValue[] = []): Promise<Row[]> { return (await this.client.execute({ sql, args })).rows; }
  async getOrCreateUser(email: string): Promise<UserRow> {
    const normalized = email.trim().toLowerCase(); const now = Date.now(); const id = randomUUID();
    await this.client.execute({ sql: `INSERT INTO users(id,email,created_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING`, args: [id, normalized, now] });
    const row = (await this.rows(`SELECT * FROM users WHERE email=?`, [normalized]))[0]; if (!row) throw new Error('User creation failed');
    return { id: String(row.id), email: String(row.email), createdAt: num(row.created_at) };
  }
  async countActiveUploads(userId: string): Promise<number> { const row = (await this.rows(`SELECT COUNT(*) AS count FROM uploads WHERE user_id=? AND status IN ('INITIATED','UPLOADING','PAUSED','COMPLETING','VERIFYING')`, [userId]))[0]; return num(row?.count ?? 0); }
  async findResumable(userId: string, fingerprint: string, size: number, lastModified: number): Promise<UploadRow | null> { const row = (await this.rows(`SELECT * FROM uploads WHERE user_id=? AND quick_fingerprint=? AND byte_size=? AND last_modified=? AND status IN ('INITIATED','UPLOADING','PAUSED') AND expires_at>? ORDER BY created_at DESC LIMIT 1`, [userId, fingerprint, size, lastModified, Date.now()]))[0]; return row ? upload(row) : null; }
  async listResumableUploads(userId: string, limit = 50): Promise<UploadRow[]> { return (await this.rows(`SELECT * FROM uploads WHERE user_id=? AND status IN ('INITIATED','UPLOADING','PAUSED') AND expires_at>? ORDER BY updated_at DESC LIMIT ?`, [userId, Date.now(), limit])).map(upload); }
  async findReadyFile(userId: string, fingerprint: string, size: number): Promise<FileRow | null> { const row = (await this.rows(`SELECT * FROM files WHERE user_id=? AND quick_fingerprint=? AND byte_size=? AND status='READY' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId, fingerprint, size]))[0]; return row ? file(row) : null; }
  async createUpload(value: UploadRow): Promise<void> { await this.client.execute({ sql: `INSERT INTO uploads(id,user_id,storage_upload_id,object_key,original_name,byte_size,declared_mime,quick_fingerprint,last_modified,part_size,total_parts,status,created_at,updated_at,expires_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [value.id,value.userId,value.storageUploadId,value.objectKey,value.originalName,value.byteSize,value.declaredMime,value.quickFingerprint,value.lastModified,value.partSize,value.totalParts,value.status,value.createdAt,value.updatedAt,value.expiresAt,value.error] }); }
  async getUpload(id: string): Promise<UploadRow | null> { const row = (await this.rows(`SELECT * FROM uploads WHERE id=?`, [id]))[0]; return row ? upload(row) : null; }
  async setUploadStatus(id: string, status: string, error: string | null = null): Promise<void> { await this.client.execute({ sql: `UPDATE uploads SET status=?, error=?, updated_at=? WHERE id=?`, args: [status,error,Date.now(),id] }); }
  async setUploadTotalParts(id: string, totalParts: number): Promise<void> { await this.client.execute({ sql: `UPDATE uploads SET total_parts=?, updated_at=? WHERE id=?`, args: [totalParts,Date.now(),id] }); }
  async listParts(uploadId: string): Promise<PartRow[]> { return (await this.rows(`SELECT part_number,etag,byte_size FROM upload_parts WHERE upload_id=? ORDER BY part_number`, [uploadId])).map(row => ({ partNumber:num(row.part_number),etag:String(row.etag),size:num(row.byte_size) })); }
  async upsertPart(uploadId: string, partNumber: number, etag: string, size: number): Promise<void> { await this.client.execute({ sql: `INSERT INTO upload_parts(upload_id,part_number,etag,byte_size,created_at) VALUES(?,?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag,byte_size=excluded.byte_size`, args: [uploadId,partNumber,etag,size,Date.now()] }); }
  async createFile(value: FileRow): Promise<void> { await this.client.execute({ sql: `INSERT INTO files(id,user_id,upload_id,object_key,original_name,byte_size,detected_mime,quick_fingerprint,status,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, args: [value.id,value.userId,value.uploadId,value.objectKey,value.originalName,value.byteSize,value.detectedMime,value.quickFingerprint,value.status,value.createdAt,value.deletedAt] }); }
  async getFile(id: string): Promise<FileRow | null> { const row = (await this.rows(`SELECT * FROM files WHERE id=? AND deleted_at IS NULL`, [id]))[0]; return row ? file(row) : null; }
  async listFiles(userId: string, limit: number, before?: number): Promise<FileRow[]> { const args: InValue[] = [userId]; let clause=''; if (before) { clause=' AND created_at<?'; args.push(before); } args.push(limit); return (await this.rows(`SELECT * FROM files WHERE user_id=? AND status='READY' AND deleted_at IS NULL${clause} ORDER BY created_at DESC LIMIT ?`,args)).map(file); }
  async softDeleteFile(id: string): Promise<void> { await this.client.execute({ sql:`UPDATE files SET deleted_at=?,status='DELETED' WHERE id=?`,args:[Date.now(),id] }); }
  async staleUploads(cutoff: number): Promise<UploadRow[]> { return (await this.rows(`SELECT * FROM uploads WHERE status IN ('INITIATED','UPLOADING','PAUSED','FAILED') AND updated_at<?`,[cutoff])).map(upload); }
}
