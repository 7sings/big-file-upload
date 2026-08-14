import '../load-env.js';
import { loadConfig } from '../config.js';
import { connectNodeDatabase } from '../infrastructure/database-node.js';
const config = loadConfig();
const db = connectNodeDatabase(config.databaseUrl, config.databaseAuthToken);
try {
  await db.migrate();
  console.info('Database migrations completed');
} finally {
  await db.close();
}
