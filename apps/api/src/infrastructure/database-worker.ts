import { createClient } from '@libsql/client/web';
import { Database } from './database.js';

export function connectWorkerDatabase(url: string, authToken?: string): Database {
  return new Database(createClient({ url, authToken }));
}
