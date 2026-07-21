import '../load-env.js';
import { loadConfig } from '../config.js';
import { Database } from '../infrastructure/database.js';
const config=loadConfig();const db=Database.connect(config.databaseUrl,config.databaseAuthToken);try{await db.migrate();console.info('Database migrations completed')}finally{await db.close()}
