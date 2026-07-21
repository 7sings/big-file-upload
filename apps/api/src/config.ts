export type RedisDriver = 'memory' | 'redis';
export type MailDriver = 'console' | 'smtp';
export type StorageDriver = 'local' | 'r2';

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function choice<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = (process.env[name] || fallback) as T;
  if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join(', ')}`);
  return value;
}

export interface Config {
  nodeEnv: string; port: number; host: string; appOrigin: string; publicOrigin: string;
  cookieSecret: string; otpPepper: string; localSigningSecret: string;
  databaseUrl: string; databaseAuthToken?: string;
  redisDriver: RedisDriver; redisUrl?: string;
  mailDriver: MailDriver; smtpHost?: string; smtpPort: number; smtpSecure: boolean; smtpUser?: string; smtpPass?: string; mailFrom: string;
  storageDriver: StorageDriver; localStoragePath: string;
  r2Endpoint?: string; r2Region: string; r2Bucket?: string; r2AccessKeyId?: string; r2SecretAccessKey?: string;
  maxFileSizeBytes: number; maxActiveUploadsPerUser: number; uploadStaleAfterSeconds: number;
  partUrlTtlSeconds: number; previewUrlTtlSeconds: number; otpTtlSeconds: number; sessionTtlSeconds: number; logLevel: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const config: Config = {
    nodeEnv,
    port: int('PORT', 3000), host: process.env.HOST || '0.0.0.0',
    appOrigin: process.env.APP_ORIGIN || 'http://localhost:5173',
    publicOrigin: process.env.PUBLIC_ORIGIN || `http://localhost:${int('PORT', 3000)}`,
    cookieSecret: process.env.COOKIE_SECRET || 'development-cookie-secret-at-least-32-chars',
    otpPepper: process.env.OTP_PEPPER || 'development-otp-pepper-at-least-32-chars',
    localSigningSecret: process.env.LOCAL_SIGNING_SECRET || 'development-local-signing-secret-32chars',
    databaseUrl: process.env.DATABASE_URL || 'file:.data/app.db', databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    redisDriver: choice('REDIS_DRIVER', ['memory', 'redis'] as const, 'memory'), redisUrl: process.env.REDIS_URL || undefined,
    mailDriver: choice('MAIL_DRIVER', ['console', 'smtp'] as const, 'console'), smtpHost: process.env.SMTP_HOST || undefined,
    smtpPort: int('SMTP_PORT', 587), smtpSecure: bool('SMTP_SECURE', false), smtpUser: process.env.SMTP_USER || undefined,
    smtpPass: process.env.SMTP_PASS || undefined, mailFrom: process.env.MAIL_FROM || 'Big Upload <no-reply@example.com>',
    storageDriver: choice('STORAGE_DRIVER', ['local', 'r2'] as const, 'local'), localStoragePath: process.env.LOCAL_STORAGE_PATH || '.data/storage',
    r2Endpoint: process.env.R2_ENDPOINT || undefined, r2Region: process.env.R2_REGION || 'auto', r2Bucket: process.env.R2_BUCKET || undefined,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || undefined, r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
    maxFileSizeBytes: int('MAX_FILE_SIZE_BYTES', 5368709120), maxActiveUploadsPerUser: int('MAX_ACTIVE_UPLOADS_PER_USER', 5),
    uploadStaleAfterSeconds: int('UPLOAD_STALE_AFTER_SECONDS', 86400), partUrlTtlSeconds: int('PART_URL_TTL_SECONDS', 900),
    previewUrlTtlSeconds: int('PREVIEW_URL_TTL_SECONDS', 300), otpTtlSeconds: int('OTP_TTL_SECONDS', 600),
    sessionTtlSeconds: int('SESSION_TTL_SECONDS', 604800), logLevel: process.env.LOG_LEVEL || 'info',
  };
  const merged = { ...config, ...overrides };
  if (merged.nodeEnv === 'production') {
    for (const [name, value] of [['COOKIE_SECRET', merged.cookieSecret], ['OTP_PEPPER', merged.otpPepper], ['LOCAL_SIGNING_SECRET', merged.localSigningSecret]] as const) {
      if (value.length < 32 || value.startsWith('development-')) throw new Error(`${name} must be a secure value in production`);
    }
  }
  if (merged.redisDriver === 'redis' && !merged.redisUrl) throw new Error('REDIS_URL is required for redis driver');
  if (merged.storageDriver === 'r2' && (!merged.r2Endpoint || !merged.r2Bucket || !merged.r2AccessKeyId || !merged.r2SecretAccessKey)) throw new Error('R2 configuration is incomplete');
  if (merged.mailDriver === 'smtp' && !merged.smtpHost) throw new Error('SMTP_HOST is required for smtp driver');
  return merged;
}
