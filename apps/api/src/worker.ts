import { applySecurityHeaders, createApp, type AppServices } from './app.js';
import { runCleanup } from './cleanup.js';
import { loadConfig, type Config, type ConfigSource } from './config.js';
import { connectWorkerDatabase } from './infrastructure/database-worker.js';
import { DurableObjectKvStore } from './infrastructure/kv-do.js';
import { ResendMailer } from './infrastructure/mail.js';
import { R2StorageProvider } from './infrastructure/storage/r2.js';
import { consoleLogger } from './infrastructure/telemetry.js';

export { KvDurableObject } from './infrastructure/kv-do.js';

const app = createApp();

function source(env: Env): ConfigSource {
  return {
    NODE_ENV: 'production',
    MAIL_DRIVER: 'resend',
    STORAGE_DRIVER: 'r2',
    COOKIE_SECRET: env.COOKIE_SECRET,
    OTP_PEPPER: env.OTP_PEPPER,
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_AUTH_TOKEN: env.DATABASE_AUTH_TOKEN,
    RESEND_API_KEY: env.RESEND_API_KEY,
    RESEND_API_URL: env.RESEND_API_URL,
    RESEND_TIMEOUT_MS: env.RESEND_TIMEOUT_MS,
    MAIL_FROM: env.MAIL_FROM,
    R2_ENDPOINT: env.R2_ENDPOINT,
    R2_REGION: env.R2_REGION,
    R2_BUCKET: env.R2_BUCKET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    MAX_FILE_SIZE_BYTES: env.MAX_FILE_SIZE_BYTES,
    MAX_ACTIVE_UPLOADS_PER_USER: env.MAX_ACTIVE_UPLOADS_PER_USER,
    UPLOAD_STALE_AFTER_SECONDS: env.UPLOAD_STALE_AFTER_SECONDS,
    PART_URL_TTL_SECONDS: env.PART_URL_TTL_SECONDS,
    PREVIEW_URL_TTL_SECONDS: env.PREVIEW_URL_TTL_SECONDS,
    OTP_TTL_SECONDS: env.OTP_TTL_SECONDS,
    SESSION_TTL_SECONDS: env.SESSION_TTL_SECONDS,
    LOG_LEVEL: env.LOG_LEVEL,
  };
}

function createServices(env: Env, config: Config): AppServices {
  const db = connectWorkerDatabase(config.databaseUrl, config.databaseAuthToken);
  const kv = new DurableObjectKvStore(env.KV_DO);
  const mailer = new ResendMailer({
    apiKey: config.resendApiKey!,
    apiUrl: config.resendApiUrl,
    timeoutMs: config.resendTimeoutMs,
    from: config.mailFrom,
    logger: consoleLogger,
  });
  const storage = new R2StorageProvider(config.r2Bucket!, {
    endpoint: config.r2Endpoint!,
    region: config.r2Region,
    accessKeyId: config.r2AccessKeyId!,
    secretAccessKey: config.r2SecretAccessKey!,
    binding: env.UPLOADS,
  });
  return { config, db, kv, mailer, storage, logger: consoleLogger };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig({}, source(env));
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/health/')) {
      const services = createServices(env, config);
      return app.fetch(request, { SERVICES: services }, ctx);
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    applySecurityHeaders(headers, config);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const config = loadConfig({}, source(env));
    const services = createServices(env, config);
    ctx.waitUntil(runCleanup(services.config, services.db, services.storage, services.logger));
  },
} satisfies ExportedHandler<Env>;
