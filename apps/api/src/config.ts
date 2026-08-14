export type MailDriver = 'console' | 'resend';
export type StorageDriver = 'local' | 'r2';
export type ConfigSource = Record<string, string | undefined>;

const MAX_TIMER_MS = 2_147_483_647;

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  cookieSecret: string;
  otpPepper: string;
  localSigningSecret: string;
  databaseUrl: string;
  databaseAuthToken?: string;
  mailDriver: MailDriver;
  mailFrom: string;
  resendApiKey?: string;
  resendApiUrl: string;
  resendTimeoutMs: number;
  storageDriver: StorageDriver;
  localStoragePath: string;
  publicOrigin: string;
  r2Endpoint?: string;
  r2Region: string;
  r2Bucket?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  maxFileSizeBytes: number;
  maxActiveUploadsPerUser: number;
  uploadStaleAfterSeconds: number;
  partUrlTtlSeconds: number;
  previewUrlTtlSeconds: number;
  otpTtlSeconds: number;
  sessionTtlSeconds: number;
  logLevel: string;
}

function positiveInt(
  source: ConfigSource,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = source[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function choice<T extends string>(
  source: ConfigSource,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = (source[name] || fallback) as T;
  if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join(', ')}`);
  return value;
}

export function loadConfig(
  overrides: Partial<Config> = {},
  source: ConfigSource = process.env,
): Config {
  const nodeEnv = choice(
    source,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  );
  const config: Config = {
    nodeEnv,
    cookieSecret: source.COOKIE_SECRET || 'development-cookie-secret-at-least-32-chars',
    otpPepper: source.OTP_PEPPER || 'development-otp-pepper-at-least-32-chars',
    localSigningSecret: source.LOCAL_SIGNING_SECRET || 'development-local-signing-secret-32chars',
    databaseUrl: source.DATABASE_URL || 'file:.data/app.db',
    databaseAuthToken: source.DATABASE_AUTH_TOKEN || undefined,
    mailDriver: choice(source, 'MAIL_DRIVER', ['console', 'resend'] as const, 'console'),
    mailFrom: source.MAIL_FROM || 'Big Upload <no-reply@example.com>',
    resendApiKey: source.RESEND_API_KEY || undefined,
    resendApiUrl: source.RESEND_API_URL || 'https://api.resend.com',
    resendTimeoutMs: positiveInt(source, 'RESEND_TIMEOUT_MS', 10_000, MAX_TIMER_MS),
    storageDriver: choice(source, 'STORAGE_DRIVER', ['local', 'r2'] as const, 'local'),
    localStoragePath: source.LOCAL_STORAGE_PATH || '.data/storage',
    publicOrigin: source.PUBLIC_ORIGIN || 'http://localhost:8787',
    r2Endpoint: source.R2_ENDPOINT || undefined,
    r2Region: source.R2_REGION || 'auto',
    r2Bucket: source.R2_BUCKET || undefined,
    r2AccessKeyId: source.R2_ACCESS_KEY_ID || undefined,
    r2SecretAccessKey: source.R2_SECRET_ACCESS_KEY || undefined,
    maxFileSizeBytes: positiveInt(source, 'MAX_FILE_SIZE_BYTES', 5_368_709_120),
    maxActiveUploadsPerUser: positiveInt(source, 'MAX_ACTIVE_UPLOADS_PER_USER', 5),
    uploadStaleAfterSeconds: positiveInt(source, 'UPLOAD_STALE_AFTER_SECONDS', 86_400),
    partUrlTtlSeconds: positiveInt(source, 'PART_URL_TTL_SECONDS', 900),
    previewUrlTtlSeconds: positiveInt(source, 'PREVIEW_URL_TTL_SECONDS', 300),
    otpTtlSeconds: positiveInt(source, 'OTP_TTL_SECONDS', 600),
    sessionTtlSeconds: positiveInt(source, 'SESSION_TTL_SECONDS', 604_800),
    logLevel: source.LOG_LEVEL || 'info',
  };
  const merged = { ...config, ...overrides };
  if (merged.nodeEnv === 'production') {
    for (const [name, value] of [
      ['COOKIE_SECRET', merged.cookieSecret],
      ['OTP_PEPPER', merged.otpPepper],
    ] as const) {
      if (value.length < 32 || value.startsWith('development-'))
        throw new Error(`${name} must be a secure value in production`);
    }
  }
  if (
    merged.storageDriver === 'r2' &&
    (!merged.r2Endpoint || !merged.r2Bucket || !merged.r2AccessKeyId || !merged.r2SecretAccessKey)
  ) {
    throw new Error('R2 configuration is incomplete');
  }
  if (merged.mailDriver === 'resend' && (!merged.resendApiKey || !merged.mailFrom)) {
    throw new Error('RESEND_API_KEY and MAIL_FROM are required for resend driver');
  }
  return merged;
}
