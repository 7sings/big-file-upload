import { createClient } from '@libsql/client';
import { Database } from './database.js';

export function connectNodeDatabase(url: string, authToken?: string): Database {
  return new Database(createClient({ url, authToken }));
}
