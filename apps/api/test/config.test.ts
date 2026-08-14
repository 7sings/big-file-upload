import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('Worker configuration', () => {
  it('loads local defaults without cloud credentials', () => {
    const config = loadConfig({}, {});
    expect(config.nodeEnv).toBe('development');
    expect(config.mailDriver).toBe('console');
    expect(config.storageDriver).toBe('local');
  });

  it('requires Resend and R2 credentials in production mode', () => {
    const source = {
      NODE_ENV: 'production',
      MAIL_DRIVER: 'resend',
      STORAGE_DRIVER: 'r2',
      COOKIE_SECRET: 'x'.repeat(32),
      OTP_PEPPER: 'y'.repeat(32),
    };
    expect(() => loadConfig({}, source)).toThrow('R2 configuration is incomplete');
  });

  it('loads Worker string bindings and validates positive integers', () => {
    const source = {
      NODE_ENV: 'production',
      MAIL_DRIVER: 'resend',
      STORAGE_DRIVER: 'r2',
      COOKIE_SECRET: 'x'.repeat(32),
      OTP_PEPPER: 'y'.repeat(32),
      DATABASE_URL: 'libsql://example.turso.io',
      DATABASE_AUTH_TOKEN: 'token',
      RESEND_API_KEY: 're_test',
      MAIL_FROM: 'Big Upload <login@example.com>',
      R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      R2_BUCKET: 'uploads',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      MAX_ACTIVE_UPLOADS_PER_USER: '7',
    };
    expect(loadConfig({}, source).maxActiveUploadsPerUser).toBe(7);
    expect(() => loadConfig({}, { ...source, OTP_TTL_SECONDS: '0' })).toThrow(
      'OTP_TTL_SECONDS must be a positive integer',
    );
  });
});
