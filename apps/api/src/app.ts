import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { FormatRegistry, Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  AckPartsSchema,
  DedupeVerifySchema,
  OtpRequestSchema,
  OtpVerifySchema,
  PrepareUploadSchema,
  type CurrentUser,
  type PrepareUpload,
} from '@big-upload/shared';
import { deriveChunkPlan, getPartRange } from '@big-upload/upload-core';
import { loadConfig, type Config } from './config.js';
import { Database, type FileRow, type UploadRow } from './infrastructure/database.js';
import { MemoryKvStore, type KvStore } from './infrastructure/kv.js';
import { ConsoleMailer, ResendMailer, type Mailer } from './infrastructure/mail.js';
import type { LocalStorageAccess, StorageProvider } from './infrastructure/storage/types.js';
import { detectContentType, isAllowedContentType } from './content-type.js';
import { consoleLogger, type Logger, Telemetry } from './infrastructure/telemetry.js';

const SESSION_COOKIE = 'big_upload_session';
const activeStates = new Set(['INITIATED', 'UPLOADING', 'PAUSED']);
const decoder = new TextDecoder();
if (!FormatRegistry.Has('email'))
  FormatRegistry.Set('email', (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

interface Session {
  user: CurrentUser;
  expiresAt: number;
}
interface OtpChallenge {
  email: string;
  hash: string;
  attempts: number;
  expiresAt: number;
}
interface DedupeChallenge {
  userId: string;
  fileId: string;
  objectKey: string;
  ranges: Array<{ offset: number; length: number }>;
  upload: PrepareUpload;
  expiresAt: number;
}

export interface AppServices {
  config: Config;
  db: Database;
  kv: KvStore;
  mailer: Mailer;
  storage: StorageProvider;
  logger: Logger;
}

type AppEnv = { Bindings: { SERVICES: AppServices }; Variables: { requestId: string } };
export interface AppDependencies {
  config?: Partial<Config>;
  db?: Database;
  kv?: KvStore;
  mailer?: Mailer;
  storage?: StorageProvider;
  logger?: Logger;
}
interface InjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}
interface InjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json<T = unknown>(): T;
}
type TestApp = ReturnType<typeof createApp> & {
  inject(options: InjectOptions): Promise<InjectResponse>;
};
export interface BuiltApp {
  app: TestApp;
  config: Config;
  db: Database;
  kv: KvStore;
  storage: StorageProvider;
  close(): Promise<void>;
}

const fileDto = (row: FileRow) => ({
  id: row.id,
  originalName: row.originalName,
  byteSize: row.byteSize,
  detectedMime: row.detectedMime,
  status: row.status,
  createdAt: row.createdAt,
});
const expectedPartSize = (upload: UploadRow, partNumber: number) =>
  getPartRange(partNumber, upload.partSize, upload.byteSize).size;
const asLocal = (storage: StorageProvider): LocalStorageAccess | null =>
  'writePart' in storage ? (storage as StorageProvider & LocalStorageAccess) : null;

function parseByteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start)) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
    end = Number.isNaN(end) ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

function contentDisposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name.replace(/[\r\n]/g, ''))}`;
}
function randomInt(maxExclusive: number): number {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0]! >= limit);
  return value[0]! % maxExclusive;
}
function dedupeRanges(size: number): Array<{ offset: number; length: number }> {
  const length = Math.min(64 * 1024, size);
  if (length <= 0) return [];
  const maxOffset = Math.max(0, size - length);
  if (maxOffset === 0) return [{ offset: 0, length }];
  const offsets = new Set<number>([0, maxOffset]);
  const target = Math.min(5, maxOffset + 1, Math.max(2, Math.ceil(size / length)));
  while (offsets.size < target) offsets.add(randomInt(maxOffset + 1));
  return [...offsets]
    .sort((a, b) => a - b)
    .map((offset) => ({ offset, length: Math.min(length, size - offset) }));
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(
    typeof value === 'string' ? new TextEncoder().encode(value) : value,
  );
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes.buffer));
}
function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
const hashOtp = (challengeId: string, code: string, pepper: string) =>
  sha256(`${challengeId}:${code}:${pepper}`);
const opaqueKey = (value: string, pepper: string) => sha256(`${pepper}:${value}`);

async function validatedBody<T extends TSchema>(c: Context<AppEnv>, schema: T): Promise<Static<T>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
  }
  if (!Value.Check(schema, value))
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body is invalid');
  return value as Static<T>;
}

function services(c: Context<AppEnv>): AppServices {
  return c.env.SERVICES;
}
export function applySecurityHeaders(headers: Headers, config: Config): void {
  const sources = config.storageDriver === 'r2' ? [new URL(config.r2Endpoint!).origin] : [];
  headers.set(
    'content-security-policy',
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${sources.join(' ')}; img-src 'self' data: ${sources.join(' ')}; media-src 'self' ${sources.join(' ')}; frame-src 'self' ${sources.join(' ')}; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`.replaceAll(
      / +;/g,
      ';',
    ),
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'SAMEORIGIN');
}
function requestId(c: Context<AppEnv>): string {
  return c.get('requestId');
}
function routeParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, 'VALIDATION_ERROR', `Missing route parameter: ${name}`);
  return value;
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
    applySecurityHeaders(c.res.headers, services(c).config);
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => {
        throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body exceeds 1 MiB');
      },
    }),
  );

  app.onError((error, c) => {
    const { config, logger } = services(c);
    const api =
      error instanceof ApiError
        ? error
        : new ApiError(
            500,
            'INTERNAL_ERROR',
            config.nodeEnv === 'production' ? 'Internal server error' : error.message,
          );
    if (api.statusCode >= 500)
      logger.error({
        event: 'request.failed',
        requestId: requestId(c),
        method: c.req.method,
        path: c.req.path,
        error: error.message,
      });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (api.retryAfterSeconds) headers.set('retry-after', String(api.retryAfterSeconds));
    return new Response(
      JSON.stringify({
        error: {
          code: api.code,
          message: api.message,
          requestId: requestId(c),
          retryAfterSeconds: api.retryAfterSeconds,
        },
      }),
      { status: api.statusCode, headers },
    );
  });
  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: 'Route not found', requestId: requestId(c) } },
      404,
    ),
  );
  app.get('/health/live', (c) => c.json({ ok: true }));
  app.get('/health/ready', (c) => c.json({ ok: true }));

  async function session(c: Context<AppEnv>): Promise<Session | null> {
    const { config, kv } = services(c);
    const token = await getSignedCookie(c, config.cookieSecret, SESSION_COOKIE);
    if (!token) return null;
    const value = await kv.get(`session:${token}`);
    if (!value) return null;
    return JSON.parse(value) as Session;
  }
  async function requireUser(c: Context<AppEnv>): Promise<CurrentUser> {
    const current = await session(c);
    if (!current || current.expiresAt <= Date.now())
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    return current.user;
  }
  async function ownedUpload(c: Context<AppEnv>, id: string): Promise<UploadRow> {
    const user = await requireUser(c);
    const value = await services(c).db.getUpload(id);
    if (!value || value.userId !== user.id)
      throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
    return value;
  }
  async function ownedFile(c: Context<AppEnv>, id: string): Promise<FileRow> {
    const user = await requireUser(c);
    const value = await services(c).db.getFile(id);
    if (!value || value.userId !== user.id)
      throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found');
    return value;
  }
  const uploadDto = async (db: Database, value: UploadRow) => ({
    id: value.id,
    status: value.status,
    fileName: value.originalName,
    byteSize: value.byteSize,
    declaredMime: value.declaredMime,
    lastModified: value.lastModified,
    quickFingerprint: value.quickFingerprint,
    partSize: value.partSize,
    totalParts: value.totalParts,
    uploadedParts: await db.listParts(value.id),
    expiresAt: value.expiresAt,
    error: value.error,
  });
  async function createUpload(c: Context<AppEnv>, user: CurrentUser, body: PrepareUpload) {
    const { config, db, storage } = services(c);
    const telemetry = new Telemetry(services(c).logger);
    if ((await db.countActiveUploads(user.id)) >= config.maxActiveUploadsPerUser)
      throw new ApiError(429, 'TOO_MANY_ACTIVE_UPLOADS', 'Too many active uploads');
    const id = crypto.randomUUID();
    const plan = deriveChunkPlan(body.size, body.networkProfile);
    const objectKey = `quarantine/${user.id}/${id}`;
    const multipart = await storage.createMultipart(
      objectKey,
      body.declaredMime || 'application/octet-stream',
    );
    const now = Date.now();
    const value: UploadRow = {
      id,
      userId: user.id,
      storageUploadId: multipart.uploadId,
      objectKey,
      originalName: body.name,
      byteSize: body.size,
      declaredMime: body.declaredMime,
      quickFingerprint: body.quickFingerprint,
      lastModified: body.lastModified,
      partSize: plan.partSize,
      totalParts: plan.totalParts,
      status: 'INITIATED',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + config.uploadStaleAfterSeconds * 1000,
      error: null,
    };
    await db.createUpload(value);
    telemetry.event('upload.prepared', {
      outcome: 'new',
      networkTier: body.networkProfile?.effectiveType ?? 'unknown',
      storageDriver: config.storageDriver,
    });
    return { kind: 'upload' as const, upload: await uploadDto(db, value), resumed: false };
  }

  app.post('/api/auth/otp/request', async (c) => {
    const { config, kv, mailer, logger } = services(c);
    const telemetry = new Telemetry(logger);
    const body = await validatedBody(c, OtpRequestSchema);
    const email = body.email.trim().toLowerCase();
    const emailKey = await opaqueKey(email, config.otpPepper);
    const ip =
      c.req.header('CF-Connecting-IP') ??
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
      'unknown';
    const ipKey = await opaqueKey(ip, config.otpPepper);
    const cooldownKey = `otp:resend:${emailKey}`;
    if (!(await kv.setIfAbsent(cooldownKey, '1', 60))) {
      telemetry.event('otp.rejected', { reason: 'cooldown' });
      throw new ApiError(
        429,
        'OTP_RESEND_COOLDOWN',
        'Please wait before requesting another code',
        60,
      );
    }
    const emailCount = await kv.increment(`otp:rate:email:${emailKey}`, 600);
    const ipCount = await kv.increment(`otp:rate:ip:${ipKey}`, 600);
    if (emailCount > 5 || ipCount > 20) {
      await kv.delete(cooldownKey);
      telemetry.event('otp.rejected', { reason: emailCount > 5 ? 'email_rate' : 'ip_rate' });
      throw new ApiError(429, 'OTP_RATE_LIMITED', 'Too many OTP requests', 600);
    }
    const challengeId = crypto.randomUUID();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + config.otpTtlSeconds * 1000;
    const challenge: OtpChallenge = {
      email,
      hash: await hashOtp(challengeId, code, config.otpPepper),
      attempts: 0,
      expiresAt,
    };
    await kv.set(`otp:${challengeId}`, JSON.stringify(challenge), config.otpTtlSeconds);
    try {
      await mailer.sendOtp(email, code, config.otpTtlSeconds);
    } catch (error) {
      await kv.delete(cooldownKey);
      telemetry.event('otp.rejected', { reason: 'mail_failure' });
      throw error;
    }
    telemetry.event('otp.sent', { outcome: 'success' });
    return c.json({ challengeId, expiresAt, resendAfter: 60 }, 202);
  });
  app.post('/api/auth/otp/verify', async (c) => {
    const { config, kv, db } = services(c);
    const body = await validatedBody(c, OtpVerifySchema);
    const key = `otp:${body.challengeId}`;
    const raw = await kv.get(key);
    if (!raw) throw new ApiError(400, 'OTP_CHALLENGE_EXPIRED', 'OTP challenge has expired');
    const value = JSON.parse(raw) as OtpChallenge;
    if (value.expiresAt <= Date.now()) {
      await kv.delete(key);
      throw new ApiError(400, 'OTP_CHALLENGE_EXPIRED', 'OTP challenge has expired');
    }
    if (value.attempts >= 5) {
      await kv.delete(key);
      throw new ApiError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many verification attempts');
    }
    if (!safeHashEqual(value.hash, await hashOtp(body.challengeId, body.code, config.otpPepper))) {
      value.attempts++;
      await kv.set(
        key,
        JSON.stringify(value),
        Math.max(1, Math.ceil((value.expiresAt - Date.now()) / 1000)),
      );
      throw new ApiError(400, 'OTP_INVALID', 'Invalid verification code');
    }
    await kv.delete(key);
    const user = await db.getOrCreateUser(value.email);
    const token = crypto.randomUUID() + crypto.randomUUID();
    const expiresAt = Date.now() + config.sessionTtlSeconds * 1000;
    await kv.set(
      `session:${token}`,
      JSON.stringify({ user: { id: user.id, email: user.email }, expiresAt } satisfies Session),
      config.sessionTtlSeconds,
    );
    await setSignedCookie(c, SESSION_COOKIE, token, config.cookieSecret, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.nodeEnv === 'production',
      maxAge: config.sessionTtlSeconds,
    });
    return c.json({ user: { id: user.id, email: user.email }, expiresAt });
  });
  app.get('/api/auth/me', async (c) => c.json({ user: await requireUser(c) }));
  app.get('/api/config', async (c) => {
    await requireUser(c);
    return c.json({ maxFileSizeBytes: services(c).config.maxFileSizeBytes });
  });
  app.post('/api/auth/logout', async (c) => {
    const { config, kv } = services(c);
    const token = await getSignedCookie(c, config.cookieSecret, SESSION_COOKIE);
    if (token) await kv.delete(`session:${token}`);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.post('/api/uploads/prepare', async (c) => {
    const { config, db, kv, logger } = services(c);
    const telemetry = new Telemetry(logger);
    const user = await requireUser(c);
    const body = await validatedBody(c, PrepareUploadSchema);
    if (body.size > config.maxFileSizeBytes)
      throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds configured maximum size');
    const resumable = await db.findResumable(
      user.id,
      body.quickFingerprint,
      body.size,
      body.lastModified,
    );
    if (resumable) {
      telemetry.event('upload.prepared', { outcome: 'resumed' });
      return c.json({
        kind: 'upload' as const,
        upload: await uploadDto(db, resumable),
        resumed: true,
      });
    }
    const ready = await db.findReadyFile(user.id, body.quickFingerprint, body.size);
    if (ready) {
      const challengeId = crypto.randomUUID();
      const ranges = dedupeRanges(body.size);
      const challenge: DedupeChallenge = {
        userId: user.id,
        fileId: ready.id,
        objectKey: ready.objectKey,
        ranges,
        upload: body,
        expiresAt: Date.now() + 300_000,
      };
      await kv.set(`dedupe:${challengeId}`, JSON.stringify(challenge), 300);
      telemetry.event('upload.prepared', { outcome: 'dedupe_challenge' });
      return c.json({ kind: 'dedupe_challenge', challengeId, ranges });
    }
    return c.json(await createUpload(c, user, body));
  });
  app.post('/api/uploads/dedupe/verify', async (c) => {
    const { kv, storage, db } = services(c);
    const user = await requireUser(c);
    const body = await validatedBody(c, DedupeVerifySchema);
    const key = `dedupe:${body.challengeId}`;
    const raw = await kv.get(key);
    if (!raw) throw new ApiError(400, 'DEDUPE_CHALLENGE_EXPIRED', 'Dedupe challenge has expired');
    const challenge = JSON.parse(raw) as DedupeChallenge;
    await kv.delete(key);
    if (challenge.userId !== user.id || challenge.expiresAt <= Date.now())
      throw new ApiError(400, 'DEDUPE_CHALLENGE_EXPIRED', 'Dedupe challenge has expired');
    const hashes = await Promise.all(
      challenge.ranges.map((range) =>
        storage
          .readRange(challenge.objectKey, range.offset, range.offset + range.length - 1)
          .then(sha256),
      ),
    );
    const matches =
      body.hashes.length === hashes.length &&
      hashes.every((hash, index) => hash === body.hashes[index]);
    if (matches) {
      const ready = await db.getFile(challenge.fileId);
      if (ready && ready.userId === user.id)
        return c.json({ kind: 'instant', file: fileDto(ready) });
    }
    return c.json(await createUpload(c, user, challenge.upload));
  });
  app.get('/api/uploads', async (c) => {
    const { db, logger } = services(c);
    const user = await requireUser(c);
    const uploads = await Promise.all(
      (await db.listResumableUploads(user.id)).map((value) => uploadDto(db, value)),
    );
    new Telemetry(logger).event('upload.active_listed', { outcome: 'success' });
    return c.json({ uploads });
  });
  app.get('/api/uploads/:id', async (c) => {
    const { db } = services(c);
    return c.json({ upload: await uploadDto(db, await ownedUpload(c, routeParam(c, 'id'))) });
  });

  const PresignBody = Type.Object({
    partNumbers: Type.Array(Type.Integer({ minimum: 1, maximum: 10000 }), {
      minItems: 1,
      maxItems: 32,
    }),
  });
  const presign = async (c: Context<AppEnv>) => {
    const { db, storage, config } = services(c);
    const body = await validatedBody(c, PresignBody);
    const value = await ownedUpload(c, routeParam(c, 'id'));
    if (!activeStates.has(value.status))
      throw new ApiError(409, 'INVALID_UPLOAD_STATE', 'Upload cannot accept parts');
    const unique = [...new Set(body.partNumbers)];
    const acknowledged = new Set((await db.listParts(value.id)).map((part) => part.partNumber));
    const parts = [];
    for (const partNumber of unique) {
      if (partNumber > value.totalParts)
        throw new ApiError(400, 'INVALID_PART_NUMBER', 'Part number is outside upload plan');
      if (acknowledged.has(partNumber)) continue;
      const signed = await storage.signPartUpload(
        value.objectKey,
        value.storageUploadId,
        partNumber,
        config.partUrlTtlSeconds,
      );
      parts.push({
        partNumber,
        url: signed.url,
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        expiresAt: signed.expiresAt,
      });
    }
    if (value.status === 'INITIATED') await db.setUploadStatus(value.id, 'UPLOADING');
    return c.json({ parts });
  };
  app.post('/api/uploads/:id/part-urls', presign);
  app.post('/api/uploads/:id/presign', presign);
  const ack = async (c: Context<AppEnv>) => {
    const { db, logger } = services(c);
    const body = await validatedBody(c, AckPartsSchema);
    const value = await ownedUpload(c, routeParam(c, 'id'));
    if (!activeStates.has(value.status))
      throw new ApiError(409, 'INVALID_UPLOAD_STATE', 'Upload cannot acknowledge parts');
    for (const part of body.parts) {
      if (part.partNumber > value.totalParts)
        throw new ApiError(400, 'INVALID_PART_NUMBER', 'Part number is outside upload plan');
      if (part.size !== expectedPartSize(value, part.partNumber))
        throw new ApiError(400, 'INVALID_PART_SIZE', `Part ${part.partNumber} has an invalid size`);
      await db.upsertPart(value.id, part.partNumber, part.etag.replaceAll('"', ''), part.size);
    }
    if (value.status === 'INITIATED') await db.setUploadStatus(value.id, 'UPLOADING');
    new Telemetry(logger).event('upload.part_acknowledged', { count: body.parts.length });
    return c.json({ uploadedParts: await db.listParts(value.id) });
  };
  app.post('/api/uploads/:id/parts', ack);
  app.post('/api/uploads/:id/ack', ack);
  app.post('/api/uploads/:id/parts/ack', ack);
  app.post('/api/uploads/:id/pause', async (c) => {
    const { db } = services(c);
    const value = await ownedUpload(c, routeParam(c, 'id'));
    if (!['INITIATED', 'UPLOADING'].includes(value.status))
      throw new ApiError(409, 'INVALID_UPLOAD_STATE', 'Upload cannot be paused');
    await db.setUploadStatus(value.id, 'PAUSED');
    return c.json({ upload: await uploadDto(db, (await db.getUpload(value.id))!) });
  });
  app.post('/api/uploads/:id/resume', async (c) => {
    const { db } = services(c);
    const value = await ownedUpload(c, routeParam(c, 'id'));
    if (value.status !== 'PAUSED')
      throw new ApiError(409, 'INVALID_UPLOAD_STATE', 'Upload is not paused');
    await db.setUploadStatus(value.id, 'UPLOADING');
    return c.json({ upload: await uploadDto(db, (await db.getUpload(value.id))!) });
  });
  app.post('/api/uploads/:id/complete', async (c) => {
    const { db, storage } = services(c);
    const value = await ownedUpload(c, routeParam(c, 'id'));
    if (value.status === 'READY') {
      const existing = await db.findReadyFile(value.userId, value.quickFingerprint, value.byteSize);
      return c.json({
        upload: await uploadDto(db, value),
        file: existing ? fileDto(existing) : undefined,
      });
    }
    if (!activeStates.has(value.status))
      throw new ApiError(409, 'INVALID_UPLOAD_STATE', 'Upload cannot be completed');
    const parts = await db.listParts(value.id);
    if (
      parts.length !== value.totalParts ||
      parts.some(
        (part, index) =>
          part.partNumber !== index + 1 || part.size !== expectedPartSize(value, part.partNumber),
      )
    )
      throw new ApiError(409, 'UPLOAD_NOT_COMPLETE', 'All parts must be acknowledged');
    await db.setUploadStatus(value.id, 'COMPLETING');
    try {
      await storage.completeMultipart(value.objectKey, value.storageUploadId, parts);
      await db.setUploadStatus(value.id, 'VERIFYING');
      const detected = detectContentType(await storage.readRange(value.objectKey, 0, 65535));
      if (!isAllowedContentType(detected)) {
        await db.setUploadStatus(
          value.id,
          'REJECTED',
          `Unsupported content type: ${detected ?? 'unknown'}`,
        );
        await storage.deleteObject(value.objectKey);
        throw new ApiError(415, 'FILE_TYPE_REJECTED', 'File content type is not allowed');
      }
      const file: FileRow = {
        id: crypto.randomUUID(),
        userId: value.userId,
        uploadId: value.id,
        objectKey: value.objectKey,
        originalName: value.originalName,
        byteSize: value.byteSize,
        detectedMime: detected,
        quickFingerprint: value.quickFingerprint,
        status: 'READY',
        createdAt: Date.now(),
        deletedAt: null,
      };
      await db.createFile(file);
      await db.setUploadStatus(value.id, 'READY');
      return c.json({
        upload: await uploadDto(db, (await db.getUpload(value.id))!),
        file: fileDto(file),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      await db.setUploadStatus(
        value.id,
        'FAILED',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
  const cancel = async (c: Context<AppEnv>) => {
    const { db, storage } = services(c);
    const value = await ownedUpload(c, routeParam(c, 'id'));
    if (!['READY', 'ABORTED', 'EXPIRED', 'REJECTED'].includes(value.status))
      await storage.abortMultipart(value.objectKey, value.storageUploadId);
    await db.setUploadStatus(value.id, 'ABORTED');
    return c.body(null, 204);
  };
  app.post('/api/uploads/:id/cancel', cancel);
  app.delete('/api/uploads/:id', cancel);

  async function sendStoredFile(c: Context<AppEnv>, value: FileRow, download: boolean) {
    const { storage, config } = services(c);
    const local = asLocal(storage);
    if (!local) {
      const signed = await storage.signDownload(value.objectKey, config.previewUrlTtlSeconds, {
        contentType: value.detectedMime,
        contentDisposition: download ? contentDisposition(value.originalName) : 'inline',
      });
      return c.redirect(signed.url);
    }
    const rangeHeader = c.req.header('range');
    const range = parseByteRange(rangeHeader, value.byteSize);
    if (rangeHeader && !range)
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${value.byteSize}` },
      });
    const object = await local.readObject(value.objectKey, range?.start, range?.end);
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'content-type': value.detectedMime,
      'content-disposition': download ? contentDisposition(value.originalName) : 'inline',
      'content-length': String(object.end - object.start + 1),
    });
    if (range) headers.set('content-range', `bytes ${object.start}-${object.end}/${object.size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  }
  app.get('/api/files', async (c) => {
    const { db } = services(c);
    const user = await requireUser(c);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)));
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (!Number.isSafeInteger(limit) || (before !== undefined && !Number.isSafeInteger(before)))
      throw new ApiError(400, 'VALIDATION_ERROR', 'Query parameters are invalid');
    const rows = await db.listFiles(user.id, limit + 1, before);
    const more = rows.length > limit;
    const selected = rows.slice(0, limit);
    return c.json({
      files: selected.map(fileDto),
      nextCursor: more ? selected.at(-1)?.createdAt : undefined,
    });
  });
  app.get('/api/files/:id', async (c) => {
    const { storage, config } = services(c);
    const value = await ownedFile(c, routeParam(c, 'id'));
    const preview = await storage.signDownload(value.objectKey, config.previewUrlTtlSeconds, {
      contentType: value.detectedMime,
      contentDisposition: 'inline',
    });
    return c.json({
      file: fileDto(value),
      previewUrl: preview.url,
      previewExpiresAt: preview.expiresAt,
    });
  });
  app.post('/api/files/:id/preview', async (c) => {
    const { storage, config } = services(c);
    const value = await ownedFile(c, routeParam(c, 'id'));
    const signed = await storage.signDownload(value.objectKey, config.previewUrlTtlSeconds, {
      contentType: value.detectedMime,
      contentDisposition: 'inline',
    });
    return c.json({ url: signed.url, expiresAt: signed.expiresAt, mime: value.detectedMime });
  });
  app.get('/api/files/:id/preview', async (c) =>
    sendStoredFile(c, await ownedFile(c, routeParam(c, 'id')), false),
  );
  app.get('/api/files/:id/download', async (c) =>
    sendStoredFile(c, await ownedFile(c, routeParam(c, 'id')), true),
  );
  app.get('/api/files/:id/text', async (c) => {
    const value = await ownedFile(c, routeParam(c, 'id'));
    if (value.detectedMime !== 'text/plain')
      throw new ApiError(415, 'NOT_TEXT_FILE', 'File is not plain text');
    if (value.byteSize > 1024 * 1024)
      throw new ApiError(413, 'TEXT_PREVIEW_TOO_LARGE', 'Text preview is limited to 1 MiB');
    return c.json({
      content: decoder.decode(
        await services(c).storage.readRange(value.objectKey, 0, value.byteSize - 1),
      ),
    });
  });
  app.delete('/api/files/:id', async (c) => {
    const { storage, db } = services(c);
    const value = await ownedFile(c, routeParam(c, 'id'));
    await storage.deleteObject(value.objectKey);
    await db.softDeleteFile(value.id);
    return c.body(null, 204);
  });

  app.put('/local-storage/parts/:uploadId/:partNumber', async (c) => {
    const local = asLocal(services(c).storage);
    if (!local) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    const partNumber = Number(routeParam(c, 'partNumber'));
    const expires = Number(c.req.query('expires'));
    const signature = c.req.query('signature') ?? '';
    if (
      !Number.isSafeInteger(partNumber) ||
      !Number.isSafeInteger(expires) ||
      !local.verifyPartSignature(routeParam(c, 'uploadId'), partNumber, expires, signature)
    )
      throw new ApiError(403, 'INVALID_STORAGE_SIGNATURE', 'Invalid or expired upload URL');
    if (!c.req.raw.body) throw new ApiError(400, 'VALIDATION_ERROR', 'Request body is required');
    const result = await local.writePart(routeParam(c, 'uploadId'), partNumber, c.req.raw.body);
    return new Response(null, {
      status: 200,
      headers: { etag: `"${result.etag}"`, 'x-uploaded-size': String(result.size) },
    });
  });
  app.get('/local-storage/objects/:token', async (c) => {
    const local = asLocal(services(c).storage);
    if (!local) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    const expires = Number(c.req.query('expires'));
    const objectKey = local.verifyObjectSignature(
      routeParam(c, 'token'),
      expires,
      c.req.query('signature') ?? '',
    );
    if (!objectKey)
      throw new ApiError(403, 'INVALID_STORAGE_SIGNATURE', 'Invalid or expired download URL');
    const info = await local.readObject(objectKey);
    const rangeHeader = c.req.header('range');
    const range = parseByteRange(rangeHeader, info.size);
    if (rangeHeader && !range)
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${info.size}` },
      });
    const object = range ? await local.readObject(objectKey, range.start, range.end) : info;
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      'content-length': String(object.end - object.start + 1),
    });
    if (range) headers.set('content-range', `bytes ${object.start}-${object.end}/${object.size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  });

  return app;
}

export async function buildApp(deps: AppDependencies = {}): Promise<BuiltApp> {
  const config = loadConfig(deps.config);
  if (!deps.db) throw new Error('Database dependency is required');
  if (!deps.storage) throw new Error('Storage dependency is required');
  await deps.db.migrate();
  const kv = deps.kv ?? new MemoryKvStore();
  const logger = deps.logger ?? consoleLogger;
  const mailer =
    deps.mailer ??
    (config.mailDriver === 'resend'
      ? new ResendMailer({
          apiKey: config.resendApiKey!,
          apiUrl: config.resendApiUrl,
          timeoutMs: config.resendTimeoutMs,
          from: config.mailFrom,
          logger,
        })
      : new ConsoleMailer());
  const app = createApp();
  const servicesValue: AppServices = {
    config,
    db: deps.db,
    kv,
    mailer,
    storage: deps.storage,
    logger,
  };
  const boundApp = Object.assign(app, {
    async inject(options: InjectOptions): Promise<InjectResponse> {
      const headers = new Headers(options.headers);
      let body: BodyInit | undefined;
      if (options.payload !== undefined) {
        if (options.payload instanceof Uint8Array || typeof options.payload === 'string')
          body = options.payload as BodyInit;
        else {
          headers.set('content-type', 'application/json');
          body = JSON.stringify(options.payload);
        }
      }
      const response = await app.fetch(
        new Request(new URL(options.url, 'http://localhost'), {
          method: options.method ?? 'GET',
          headers,
          body,
        }),
        { SERVICES: servicesValue },
      );
      const text = await response.text();
      const responseHeaders = Object.fromEntries(response.headers.entries());
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: text,
        json<T = unknown>(): T {
          return JSON.parse(text) as T;
        },
      };
    },
  }) as TestApp;
  return {
    app: boundApp,
    config,
    db: deps.db,
    kv,
    storage: deps.storage,
    async close() {
      await kv.close();
      await deps.db!.close();
    },
  };
}
