import '../load-env.js';
import { buildApp } from '../app.js';

const built=await buildApp();
let cleaned=0;let failed=0;let scanned=0;const started=Date.now();
try{
  const cutoff=Date.now()-built.config.uploadStaleAfterSeconds*1000;
  for(const upload of await built.db.staleUploads(cutoff)){
    scanned++;
    try{await built.storage.abortMultipart(upload.objectKey,upload.storageUploadId);await built.db.setUploadStatus(upload.id,'EXPIRED');cleaned++}
    catch(error){failed++;built.app.log.warn({err:error,event:'upload.cleanup_failed'},'Failed to abort stale storage upload')}
  }
  built.app.log.info({event:'upload.cleanup_completed',scanned,cleaned,failed,durationMs:Date.now()-started},'Stale upload cleanup completed');
}finally{await built.close()}
