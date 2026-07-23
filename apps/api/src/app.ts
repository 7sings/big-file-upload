import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { Type, type Static } from '@sinclair/typebox';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AckPartsSchema, DedupeVerifySchema, OtpRequestSchema, OtpVerifySchema, PrepareUploadSchema, type CurrentUser, type PrepareUpload } from '@big-upload/shared';
import { deriveChunkPlan, getPartRange } from '@big-upload/upload-core';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { loadConfig, type Config } from './config.js';
import { Database, type FileRow, type UploadRow } from './infrastructure/database.js';
import { MemoryKvStore, RedisKvStore, type KvStore } from './infrastructure/kv.js';
import { ConsoleMailer, NodemailerMailer, ResendMailer, type Mailer } from './infrastructure/mail.js';
import { LocalStorageProvider, R2StorageProvider, type LocalStorageAccess, type StorageProvider } from './infrastructure/storage/index.js';
import { detectContentType, isAllowedContentType } from './content-type.js';
import { Telemetry } from './infrastructure/telemetry.js';

const SESSION_COOKIE='big_upload_session';
const activeStates=new Set(['INITIATED','UPLOADING','PAUSED']);
class ApiError extends Error { constructor(readonly statusCode:number,readonly code:string,message:string,readonly retryAfterSeconds?:number){super(message)} }
interface Session { user:CurrentUser; expiresAt:number }
interface OtpChallenge { email:string;hash:string;attempts:number;expiresAt:number }
interface DedupeChallenge { userId:string;fileId:string;objectKey:string;ranges:Array<{offset:number;length:number}>;upload:PrepareUpload;expiresAt:number }
export interface AppDependencies { config?:Partial<Config>; db?:Database; kv?:KvStore; mailer?:Mailer; storage?:StorageProvider }
export interface BuiltApp { app:FastifyInstance; config:Config; db:Database; kv:KvStore; storage:StorageProvider; close():Promise<void> }

const fileDto=(row:FileRow)=>({id:row.id,originalName:row.originalName,byteSize:row.byteSize,detectedMime:row.detectedMime,status:row.status,createdAt:row.createdAt});
const hashOtp=(challengeId:string,code:string,pepper:string)=>createHash('sha256').update(`${challengeId}:${code}:${pepper}`).digest('hex');
const opaqueKey=(value:string,pepper:string)=>createHash('sha256').update(`${pepper}:${value}`).digest('hex');
function safeHashEqual(a:string,b:string):boolean{const aa=Buffer.from(a);const bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb)}
function expectedPartSize(upload:UploadRow,partNumber:number):number{return getPartRange(partNumber,upload.partSize,upload.byteSize).size}
function asLocal(storage:StorageProvider):LocalStorageAccess|null{return 'writePart' in storage ? storage as StorageProvider&LocalStorageAccess:null}
function parseByteRange(value:string|undefined,size:number):{start:number;end:number}|null {
  if(!value)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match)return null;
  let start=match[1]?Number(match[1]):NaN;let end=match[2]?Number(match[2]):NaN;
  if(Number.isNaN(start)){const suffix=end;if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1}else{if(!Number.isSafeInteger(start)||start<0||start>=size)return null;end=Number.isNaN(end)?size-1:Math.min(end,size-1)}
  if(!Number.isSafeInteger(end)||end<start)return null;return{start,end};
}
function contentDisposition(name:string):string{return `attachment; filename*=UTF-8''${encodeURIComponent(name.replace(/[\r\n]/g,''))}`}
function dedupeRanges(size:number):Array<{offset:number;length:number}>{
  const length=Math.min(64*1024,size);if(length<=0)return[];const maxOffset=Math.max(0,size-length);if(maxOffset===0)return[{offset:0,length}];const offsets=new Set<number>([0,maxOffset]);
  const target=Math.min(5,maxOffset+1,Math.max(2,Math.ceil(size/length)));while(offsets.size<target)offsets.add(randomInt(0,maxOffset+1));
  return[...offsets].sort((a,b)=>a-b).map(offset=>({offset,length:Math.min(length,size-offset)}));
}

export async function buildApp(deps:AppDependencies={}):Promise<BuiltApp>{
  const config=loadConfig(deps.config); const ownDb=!deps.db; const ownKv=!deps.kv;
  const db=deps.db??Database.connect(config.databaseUrl,config.databaseAuthToken); await db.migrate();
  const kv=deps.kv??(config.redisDriver==='redis'?await RedisKvStore.connect(config.redisUrl!):new MemoryKvStore());
  const app=Fastify({logger:{level:config.logLevel},bodyLimit:1024*1024,routerOptions:{maxParamLength:512},trustProxy:config.nodeEnv==='production'}).withTypeProvider<TypeBoxTypeProvider>();
  const telemetry=new Telemetry(app.log);
  const mailer=deps.mailer??(config.mailDriver==='smtp'?new NodemailerMailer({host:config.smtpHost!,port:config.smtpPort,secure:config.smtpSecure,user:config.smtpUser,pass:config.smtpPass,from:config.mailFrom,addressFamily:config.smtpAddressFamily,dnsTimeoutMs:config.smtpDnsTimeoutMs,connectionTimeoutMs:config.smtpConnectionTimeoutMs,greetingTimeoutMs:config.smtpGreetingTimeoutMs,socketTimeoutMs:config.smtpSocketTimeoutMs,logger:app.log}):config.mailDriver==='resend'?new ResendMailer({apiKey:config.resendApiKey!,apiUrl:config.resendApiUrl,timeoutMs:config.resendTimeoutMs,from:config.mailFrom,logger:app.log}):new ConsoleMailer());
  const storage=deps.storage??(config.storageDriver==='r2'?new R2StorageProvider(config.r2Bucket!,{endpoint:config.r2Endpoint!,region:config.r2Region,accessKeyId:config.r2AccessKeyId!,secretAccessKey:config.r2SecretAccessKey!}):new LocalStorageProvider(config.localStoragePath,config.publicOrigin,config.localSigningSecret));
  // Multipart data is PUT directly from the browser to the configured R2 endpoint.
  // Keep CSP strict, but allow that exact origin when R2 storage is enabled.
  const storageBrowserSources=config.storageDriver==='r2'?[new URL(config.r2Endpoint!).origin]:[];
  await app.register(helmet,{contentSecurityPolicy:{directives:{
    scriptSrc:["'self'","'wasm-unsafe-eval'"],
    connectSrc:["'self'",...storageBrowserSources],
    imgSrc:["'self'",'data:',...storageBrowserSources],
    mediaSrc:["'self'",...storageBrowserSources],
    frameSrc:["'self'",...storageBrowserSources],
  }}}); await app.register(cookie,{secret:config.cookieSecret}); await app.register(cors,{origin:config.appOrigin,credentials:true,exposedHeaders:['etag','content-length','content-range']});
  let servesWeb=false;const webDist=fileURLToPath(new URL('../../web/dist/',import.meta.url));
  if(config.nodeEnv==='production'){try{await access(webDist);await app.register(fastifyStatic,{root:webDist,prefix:'/'});servesWeb=true}catch{app.log.warn({webDist},'Web dist directory is unavailable; API-only mode enabled')}}
  app.addContentTypeParser('application/octet-stream',(request,payload,done)=>done(null,payload));
  app.setErrorHandler((error,request,reply)=>{const err=error instanceof Error?error:new Error(String(error));const status='statusCode'in err&&typeof err.statusCode==='number'?err.statusCode:500;const validation='validation'in err&&Array.isArray(err.validation);const api=err instanceof ApiError?err:new ApiError(status,validation?'VALIDATION_ERROR':'INTERNAL_ERROR',config.nodeEnv==='production'&&status>=500?'Internal server error':err.message);if(api.statusCode>=500)request.log.error(err);if(api.retryAfterSeconds)reply.header('retry-after',api.retryAfterSeconds);reply.status(api.statusCode).send({error:{code:api.code,message:api.message,requestId:request.id,retryAfterSeconds:api.retryAfterSeconds}})});
  app.get('/health/live',async()=>({ok:true})); app.get('/health/ready',async()=>({ok:true}));

  async function session(request:FastifyRequest):Promise<Session|null>{const raw=request.cookies[SESSION_COOKIE];if(!raw)return null;const unsigned=request.unsignCookie(raw);if(!unsigned.valid||!unsigned.value)return null;const value=await kv.get(`session:${unsigned.value}`);if(!value)return null;return JSON.parse(value) as Session}
  async function requireUser(request:FastifyRequest):Promise<CurrentUser>{const current=await session(request);if(!current||current.expiresAt<=Date.now())throw new ApiError(401,'UNAUTHENTICATED','Authentication required');return current.user}
  async function ownedUpload(request:FastifyRequest,id:string):Promise<UploadRow>{const user=await requireUser(request);const value=await db.getUpload(id);if(!value||value.userId!==user.id)throw new ApiError(404,'UPLOAD_NOT_FOUND','Upload not found');return value}
  async function ownedFile(request:FastifyRequest,id:string):Promise<FileRow>{const user=await requireUser(request);const value=await db.getFile(id);if(!value||value.userId!==user.id)throw new ApiError(404,'FILE_NOT_FOUND','File not found');return value}
  const uploadDto=async(value:UploadRow)=>({id:value.id,status:value.status,fileName:value.originalName,byteSize:value.byteSize,declaredMime:value.declaredMime,lastModified:value.lastModified,quickFingerprint:value.quickFingerprint,partSize:value.partSize,totalParts:value.totalParts,uploadedParts:await db.listParts(value.id),expiresAt:value.expiresAt,error:value.error});
  async function createUpload(user:CurrentUser,body:PrepareUpload){
    if(await db.countActiveUploads(user.id)>=config.maxActiveUploadsPerUser)throw new ApiError(429,'TOO_MANY_ACTIVE_UPLOADS','Too many active uploads');
    const id=randomUUID();const plan=deriveChunkPlan(body.size,body.networkProfile);const objectKey=`quarantine/${user.id}/${id}`;const multipart=await storage.createMultipart(objectKey,body.declaredMime||'application/octet-stream');const now=Date.now();
    const value:UploadRow={id,userId:user.id,storageUploadId:multipart.uploadId,objectKey,originalName:body.name,byteSize:body.size,declaredMime:body.declaredMime,quickFingerprint:body.quickFingerprint,lastModified:body.lastModified,partSize:plan.partSize,totalParts:plan.totalParts,status:'INITIATED',createdAt:now,updatedAt:now,expiresAt:now+config.uploadStaleAfterSeconds*1000,error:null};
    await db.createUpload(value);telemetry.event('upload.prepared',{outcome:'new',networkTier:body.networkProfile?.effectiveType??'unknown',storageDriver:config.storageDriver});return{kind:'upload' as const,upload:await uploadDto(value),resumed:false};
  }

  app.post('/api/auth/otp/request',{schema:{body:OtpRequestSchema}},async(request,reply)=>{const email=request.body.email.trim().toLowerCase();const emailKey=opaqueKey(email,config.otpPepper);const ipKey=opaqueKey(request.ip,config.otpPepper);const cooldownKey=`otp:resend:${emailKey}`;if(!await kv.setIfAbsent(cooldownKey,'1',60)){telemetry.event('otp.rejected',{reason:'cooldown'});throw new ApiError(429,'OTP_RESEND_COOLDOWN','Please wait before requesting another code',60)}const emailCount=await kv.increment(`otp:rate:email:${emailKey}`,600);const ipCount=await kv.increment(`otp:rate:ip:${ipKey}`,600);if(emailCount>5||ipCount>20){await kv.delete(cooldownKey);telemetry.event('otp.rejected',{reason:emailCount>5?'email_rate':'ip_rate'});throw new ApiError(429,'OTP_RATE_LIMITED','Too many OTP requests',600)}const challengeId=randomUUID();const code=String(randomInt(0,1_000_000)).padStart(6,'0');const expiresAt=Date.now()+config.otpTtlSeconds*1000;const challenge:OtpChallenge={email,hash:hashOtp(challengeId,code,config.otpPepper),attempts:0,expiresAt};await kv.set(`otp:${challengeId}`,JSON.stringify(challenge),config.otpTtlSeconds);try{await mailer.sendOtp(email,code,config.otpTtlSeconds)}catch(error){await kv.delete(cooldownKey);telemetry.event('otp.rejected',{reason:'mail_failure'});throw error}telemetry.event('otp.sent',{outcome:'success'});return reply.status(202).send({challengeId,expiresAt,resendAfter:60})});
  app.post('/api/auth/otp/verify',{schema:{body:OtpVerifySchema}},async(request,reply)=>{const key=`otp:${request.body.challengeId}`;const raw=await kv.get(key);if(!raw)throw new ApiError(400,'OTP_CHALLENGE_EXPIRED','OTP challenge has expired');const value=JSON.parse(raw) as OtpChallenge;if(value.expiresAt<=Date.now()){await kv.delete(key);throw new ApiError(400,'OTP_CHALLENGE_EXPIRED','OTP challenge has expired')}if(value.attempts>=5){await kv.delete(key);throw new ApiError(429,'OTP_ATTEMPTS_EXCEEDED','Too many verification attempts')}if(!safeHashEqual(value.hash,hashOtp(request.body.challengeId,request.body.code,config.otpPepper))){value.attempts++;await kv.set(key,JSON.stringify(value),Math.max(1,Math.ceil((value.expiresAt-Date.now())/1000)));throw new ApiError(400,'OTP_INVALID','Invalid verification code')}await kv.delete(key);const user=await db.getOrCreateUser(value.email);const token=randomUUID()+randomUUID();const expiresAt=Date.now()+config.sessionTtlSeconds*1000;await kv.set(`session:${token}`,JSON.stringify({user:{id:user.id,email:user.email},expiresAt} satisfies Session),config.sessionTtlSeconds);reply.setCookie(SESSION_COOKIE,token,{path:'/',httpOnly:true,sameSite:'lax',secure:config.nodeEnv==='production',signed:true,maxAge:config.sessionTtlSeconds});return{user:{id:user.id,email:user.email},expiresAt}});
  app.get('/api/auth/me',async request=>({user:(await requireUser(request))}));
  app.get('/api/config',async request=>{await requireUser(request);return{maxFileSizeBytes:config.maxFileSizeBytes}});
  app.post('/api/auth/logout',async(request,reply)=>{const raw=request.cookies[SESSION_COOKIE];if(raw){const token=request.unsignCookie(raw);if(token.valid&&token.value)await kv.delete(`session:${token.value}`)}reply.clearCookie(SESSION_COOKIE,{path:'/'}).status(204).send()});

  app.post('/api/uploads/prepare',{schema:{body:PrepareUploadSchema}},async(request)=>{
    const user=await requireUser(request);const body=request.body;
    if(body.size>config.maxFileSizeBytes)throw new ApiError(413,'FILE_TOO_LARGE','File exceeds configured maximum size');
    const resumable=await db.findResumable(user.id,body.quickFingerprint,body.size,body.lastModified);
    if(resumable){telemetry.event('upload.prepared',{outcome:'resumed'});return{kind:'upload' as const,upload:await uploadDto(resumable),resumed:true}}
    const ready=await db.findReadyFile(user.id,body.quickFingerprint,body.size);
    if(ready){const challengeId=randomUUID();const ranges=dedupeRanges(body.size);const challenge:DedupeChallenge={userId:user.id,fileId:ready.id,objectKey:ready.objectKey,ranges,upload:body,expiresAt:Date.now()+300_000};await kv.set(`dedupe:${challengeId}`,JSON.stringify(challenge),300);telemetry.event('upload.prepared',{outcome:'dedupe_challenge'});return{kind:'dedupe_challenge',challengeId,ranges}}
    return createUpload(user,body);
  });
  app.post('/api/uploads/dedupe/verify',{schema:{body:DedupeVerifySchema}},async request=>{
    const user=await requireUser(request);const key=`dedupe:${request.body.challengeId}`;const raw=await kv.get(key);
    if(!raw)throw new ApiError(400,'DEDUPE_CHALLENGE_EXPIRED','Dedupe challenge has expired');const challenge=JSON.parse(raw) as DedupeChallenge;await kv.delete(key);
    if(challenge.userId!==user.id||challenge.expiresAt<=Date.now())throw new ApiError(400,'DEDUPE_CHALLENGE_EXPIRED','Dedupe challenge has expired');
    const matches=request.body.hashes.length===challenge.ranges.length&&(await Promise.all(challenge.ranges.map(async(range,index)=>createHash('sha256').update(await storage.readRange(challenge.objectKey,range.offset,range.offset+range.length-1)).digest('hex')===request.body.hashes[index]))).every(Boolean);
    if(matches){const ready=await db.getFile(challenge.fileId);if(ready&&ready.userId===user.id)return{kind:'instant',file:fileDto(ready)}}
    return createUpload(user,challenge.upload);
  });
  app.get('/api/uploads',{schema:{querystring:Type.Object({state:Type.Optional(Type.Literal('active'))})}},async request=>{const user=await requireUser(request);const uploads=await Promise.all((await db.listResumableUploads(user.id)).map(uploadDto));telemetry.event('upload.active_listed',{outcome:'success'});return{uploads}});
  app.get('/api/uploads/:id',{schema:{params:Type.Object({id:Type.String()})}},async request=>({upload:await uploadDto(await ownedUpload(request,request.params.id))}));
  const PresignBody=Type.Object({partNumbers:Type.Array(Type.Integer({minimum:1,maximum:10000}),{minItems:1,maxItems:32})});
  const presign=async(request:FastifyRequest<{Params:{id:string};Body:Static<typeof PresignBody>}>)=>{const value=await ownedUpload(request,request.params.id);if(!activeStates.has(value.status))throw new ApiError(409,'INVALID_UPLOAD_STATE','Upload cannot accept parts');const unique=[...new Set(request.body.partNumbers)];const acknowledged=new Set((await db.listParts(value.id)).map(part=>part.partNumber));const parts=[];for(const partNumber of unique){if(partNumber>value.totalParts)throw new ApiError(400,'INVALID_PART_NUMBER','Part number is outside upload plan');if(acknowledged.has(partNumber))continue;const signed=await storage.signPartUpload(value.objectKey,value.storageUploadId,partNumber,config.partUrlTtlSeconds);parts.push({partNumber,url:signed.url,method:'PUT',headers:{'content-type':'application/octet-stream'},expiresAt:signed.expiresAt})}if(value.status==='INITIATED')await db.setUploadStatus(value.id,'UPLOADING');return{parts}};
  app.post('/api/uploads/:id/part-urls',{schema:{params:Type.Object({id:Type.String()}),body:PresignBody}},presign); app.post('/api/uploads/:id/presign',{schema:{params:Type.Object({id:Type.String()}),body:PresignBody}},presign);
  const ack=async(request:FastifyRequest<{Params:{id:string};Body:Static<typeof AckPartsSchema>}>)=>{const value=await ownedUpload(request,request.params.id);if(!activeStates.has(value.status))throw new ApiError(409,'INVALID_UPLOAD_STATE','Upload cannot acknowledge parts');for(const part of request.body.parts){if(part.partNumber>value.totalParts)throw new ApiError(400,'INVALID_PART_NUMBER','Part number is outside upload plan');if(part.size!==expectedPartSize(value,part.partNumber))throw new ApiError(400,'INVALID_PART_SIZE',`Part ${part.partNumber} has an invalid size`);await db.upsertPart(value.id,part.partNumber,part.etag.replaceAll('"',''),part.size)}if(value.status==='INITIATED')await db.setUploadStatus(value.id,'UPLOADING');telemetry.event('upload.part_acknowledged',{count:request.body.parts.length});return{uploadedParts:await db.listParts(value.id)}};
  app.post('/api/uploads/:id/parts',{schema:{params:Type.Object({id:Type.String()}),body:AckPartsSchema}},ack);app.post('/api/uploads/:id/ack',{schema:{params:Type.Object({id:Type.String()}),body:AckPartsSchema}},ack);app.post('/api/uploads/:id/parts/ack',{schema:{params:Type.Object({id:Type.String()}),body:AckPartsSchema}},ack);
  app.post('/api/uploads/:id/pause',{schema:{params:Type.Object({id:Type.String()})}},async request=>{const value=await ownedUpload(request,request.params.id);if(!['INITIATED','UPLOADING'].includes(value.status))throw new ApiError(409,'INVALID_UPLOAD_STATE','Upload cannot be paused');await db.setUploadStatus(value.id,'PAUSED');return{upload:await uploadDto((await db.getUpload(value.id))!)}});
  app.post('/api/uploads/:id/resume',{schema:{params:Type.Object({id:Type.String()})}},async request=>{const value=await ownedUpload(request,request.params.id);if(value.status!=='PAUSED')throw new ApiError(409,'INVALID_UPLOAD_STATE','Upload is not paused');await db.setUploadStatus(value.id,'UPLOADING');return{upload:await uploadDto((await db.getUpload(value.id))!)}});
  app.post('/api/uploads/:id/complete',{schema:{params:Type.Object({id:Type.String()})}},async request=>{const value=await ownedUpload(request,request.params.id);if(value.status==='READY'){const existing=await db.findReadyFile(value.userId,value.quickFingerprint,value.byteSize);return{upload:await uploadDto(value),file:existing?fileDto(existing):undefined}}if(!activeStates.has(value.status))throw new ApiError(409,'INVALID_UPLOAD_STATE','Upload cannot be completed');const parts=await db.listParts(value.id);if(parts.length!==value.totalParts||parts.some((part,index)=>part.partNumber!==index+1||part.size!==expectedPartSize(value,part.partNumber)))throw new ApiError(409,'UPLOAD_NOT_COMPLETE','All parts must be acknowledged');await db.setUploadStatus(value.id,'COMPLETING');try{await storage.completeMultipart(value.objectKey,value.storageUploadId,parts);await db.setUploadStatus(value.id,'VERIFYING');const sample=await storage.readRange(value.objectKey,0,65535);const detected=detectContentType(sample);if(!isAllowedContentType(detected)){await db.setUploadStatus(value.id,'REJECTED',`Unsupported content type: ${detected??'unknown'}`);await storage.deleteObject(value.objectKey);throw new ApiError(415,'FILE_TYPE_REJECTED','File content type is not allowed')}const fileId=randomUUID();const createdAt=Date.now();const file:FileRow={id:fileId,userId:value.userId,uploadId:value.id,objectKey:value.objectKey,originalName:value.originalName,byteSize:value.byteSize,detectedMime:detected,quickFingerprint:value.quickFingerprint,status:'READY',createdAt,deletedAt:null};await db.createFile(file);await db.setUploadStatus(value.id,'READY');return{upload:await uploadDto((await db.getUpload(value.id))!),file:fileDto(file)}}catch(error){if(error instanceof ApiError)throw error;await db.setUploadStatus(value.id,'FAILED',error instanceof Error?error.message:String(error));throw error}});
  const cancel=async(request:FastifyRequest<{Params:{id:string}}>,reply:FastifyReply)=>{const value=await ownedUpload(request,request.params.id);if(!['READY','ABORTED','EXPIRED','REJECTED'].includes(value.status))await storage.abortMultipart(value.objectKey,value.storageUploadId);await db.setUploadStatus(value.id,'ABORTED');reply.status(204).send()};
  app.post('/api/uploads/:id/cancel',{schema:{params:Type.Object({id:Type.String()})}},cancel);app.delete('/api/uploads/:id',{schema:{params:Type.Object({id:Type.String()})}},cancel);

  const local=asLocal(storage);
  async function sendStoredFile(request:FastifyRequest,value:FileRow,reply:FastifyReply,download:boolean){
    if(!local){const disposition=download?contentDisposition(value.originalName):'inline';const signed=await storage.signDownload(value.objectKey,config.previewUrlTtlSeconds,{contentType:value.detectedMime,contentDisposition:disposition});return reply.redirect(signed.url)}
    const path=local.objectPath(value.objectKey);const info=await stat(path);const rangeHeader=request.headers.range;const range=parseByteRange(rangeHeader,info.size);
    reply.header('accept-ranges','bytes').header('content-type',value.detectedMime).header('content-disposition',download?contentDisposition(value.originalName):'inline');
    if(rangeHeader&&!range)return reply.header('content-range',`bytes */${info.size}`).status(416).send();
    if(range){const length=range.end-range.start+1;reply.header('content-range',`bytes ${range.start}-${range.end}/${info.size}`).header('content-length',length).status(206);return reply.send(createReadStream(path,{start:range.start,end:range.end}))}
    reply.header('content-length',info.size);return reply.send(createReadStream(path));
  }

  app.get('/api/files',{schema:{querystring:Type.Object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),before:Type.Optional(Type.Integer({minimum:1}))})}},async request=>{const user=await requireUser(request);const limit=request.query.limit??50;const rows=await db.listFiles(user.id,limit+1,request.query.before);const more=rows.length>limit;const selected=rows.slice(0,limit);return{files:selected.map(fileDto),nextCursor:more?selected.at(-1)?.createdAt:undefined}});
  app.get('/api/files/:id',{schema:{params:Type.Object({id:Type.String()})}},async request=>{const value=await ownedFile(request,request.params.id);const preview=await storage.signDownload(value.objectKey,config.previewUrlTtlSeconds,{contentType:value.detectedMime,contentDisposition:'inline'});return{file:fileDto(value),previewUrl:preview.url,previewExpiresAt:preview.expiresAt}});
  app.post('/api/files/:id/preview',{schema:{params:Type.Object({id:Type.String()})}},async request=>{const value=await ownedFile(request,request.params.id);const signed=await storage.signDownload(value.objectKey,config.previewUrlTtlSeconds,{contentType:value.detectedMime,contentDisposition:'inline'});return{url:signed.url,expiresAt:signed.expiresAt,mime:value.detectedMime}});
  app.get('/api/files/:id/preview',{schema:{params:Type.Object({id:Type.String()})}},async(request,reply)=>sendStoredFile(request,await ownedFile(request,request.params.id),reply,false));
  app.get('/api/files/:id/download',{schema:{params:Type.Object({id:Type.String()})}},async(request,reply)=>sendStoredFile(request,await ownedFile(request,request.params.id),reply,true));
  app.get('/api/files/:id/text',{schema:{params:Type.Object({id:Type.String()})}},async request=>{const value=await ownedFile(request,request.params.id);if(value.detectedMime!=='text/plain')throw new ApiError(415,'NOT_TEXT_FILE','File is not plain text');if(value.byteSize>1024*1024)throw new ApiError(413,'TEXT_PREVIEW_TOO_LARGE','Text preview is limited to 1 MiB');return{content:(await storage.readRange(value.objectKey,0,value.byteSize-1)).toString('utf8')}});
  app.delete('/api/files/:id',{schema:{params:Type.Object({id:Type.String()})}},async(request,reply)=>{const value=await ownedFile(request,request.params.id);await storage.deleteObject(value.objectKey);await db.softDeleteFile(value.id);reply.status(204).send()});

  if(local){app.put('/local-storage/parts/:uploadId/:partNumber',{schema:{params:Type.Object({uploadId:Type.String(),partNumber:Type.Integer({minimum:1})}),querystring:Type.Object({expires:Type.Integer(),signature:Type.String()})}},async(request,reply)=>{if(!local.verifyPartSignature(request.params.uploadId,request.params.partNumber,request.query.expires,request.query.signature))throw new ApiError(403,'INVALID_STORAGE_SIGNATURE','Invalid or expired upload URL');const result=await local.writePart(request.params.uploadId,request.params.partNumber,request.body as Readable);reply.header('etag',`"${result.etag}"`).header('x-uploaded-size',result.size).status(200).send()});app.get('/local-storage/objects/:token',{schema:{params:Type.Object({token:Type.String()}),querystring:Type.Object({expires:Type.Integer(),signature:Type.String()})}},async(request,reply)=>{const objectKey=local.verifyObjectSignature(request.params.token,request.query.expires,request.query.signature);if(!objectKey)throw new ApiError(403,'INVALID_STORAGE_SIGNATURE','Invalid or expired download URL');const path=local.objectPath(objectKey);const info=await stat(path);const rangeHeader=request.headers.range;const range=parseByteRange(rangeHeader,info.size);reply.header('accept-ranges','bytes').type('application/octet-stream');if(rangeHeader&&!range)return reply.header('content-range',`bytes */${info.size}`).status(416).send();if(range){reply.header('content-range',`bytes ${range.start}-${range.end}/${info.size}`).header('content-length',range.end-range.start+1).status(206);return reply.send(createReadStream(path,{start:range.start,end:range.end}))}reply.header('content-length',info.size);return reply.send(createReadStream(path))})}
  if(servesWeb)app.setNotFoundHandler((request,reply)=>{const path=request.raw.url?.split('?',1)[0]??'/';if(request.method==='GET'&&!path.startsWith('/api/')&&!path.startsWith('/local-storage/')&&!path.startsWith('/health/'))return reply.type('text/html').sendFile('index.html');throw new ApiError(404,'NOT_FOUND','Route not found')});
  await app.ready();
  return{app,config,db,kv,storage,async close(){await app.close();if(ownKv)await kv.close();if(ownDb)await db.close()}};
}
