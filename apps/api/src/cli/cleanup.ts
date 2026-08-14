import '../load-env.js';
import { runCleanup } from '../cleanup.js';
import { loadConfig } from '../config.js';
import { connectNodeDatabase } from '../infrastructure/database-node.js';
import { R2StorageProvider } from '../infrastructure/storage/r2.js';
import { consoleLogger } from '../infrastructure/telemetry.js';

const config = loadConfig();
if (config.storageDriver !== 'r2') throw new Error('Cleanup CLI requires STORAGE_DRIVER=r2');
const db = connectNodeDatabase(config.databaseUrl, config.databaseAuthToken);
const storage = new R2StorageProvider(config.r2Bucket!, {
  endpoint: config.r2Endpoint!,
  region: config.r2Region,
  accessKeyId: config.r2AccessKeyId!,
  secretAccessKey: config.r2SecretAccessKey!,
});
try {
  await runCleanup(config, db, storage, consoleLogger);
} finally {
  await db.close();
}
