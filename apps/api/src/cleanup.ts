import type { Config } from './config.js';
import type { Database } from './infrastructure/database.js';
import type { StorageProvider } from './infrastructure/storage/types.js';
import type { Logger } from './infrastructure/telemetry.js';

export async function runCleanup(
  config: Config,
  db: Database,
  storage: StorageProvider,
  logger: Logger,
): Promise<{ scanned: number; cleaned: number; failed: number }> {
  let cleaned = 0;
  let failed = 0;
  let scanned = 0;
  const started = Date.now();
  const cutoff = Date.now() - config.uploadStaleAfterSeconds * 1000;
  for (const upload of await db.staleUploads(cutoff)) {
    scanned++;
    try {
      await storage.abortMultipart(upload.objectKey, upload.storageUploadId);
      await db.setUploadStatus(upload.id, 'EXPIRED');
      cleaned++;
    } catch (error) {
      failed++;
      logger.warn({
        event: 'upload.cleanup_failed',
        uploadId: upload.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info({
    event: 'upload.cleanup_completed',
    scanned,
    cleaned,
    failed,
    durationMs: Date.now() - started,
  });
  return { scanned, cleaned, failed };
}
