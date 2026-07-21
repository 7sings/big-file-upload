import './load-env.js';
import { buildApp } from './app.js';

const built=await buildApp();
const shutdown=async()=>{await built.close();process.exit(0)};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
try{await built.app.listen({port:built.config.port,host:built.config.host})}catch(error){built.app.log.error(error);await built.close();process.exit(1)}
