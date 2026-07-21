import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { UploadedPart } from '@big-upload/shared';
import type { DownloadOptions, LocalStorageAccess, MultipartUpload, SignedUrl, StorageProvider } from './types.js';

export class LocalStorageProvider implements StorageProvider, LocalStorageAccess {
  private readonly root:string;
  constructor(root:string,private readonly publicOrigin:string,private readonly secret:string){this.root=resolve(root)}
  private sign(value:string):string{return createHmac('sha256',this.secret).update(value).digest('base64url')}
  private safeEqual(a:string,b:string):boolean{const aa=Buffer.from(a);const bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb)}
  private partPath(uploadId:string,partNumber:number):string{return join(this.root,'multipart',uploadId,String(partNumber))}
  objectPath(objectKey:string):string{const path=resolve(this.root,'objects',objectKey);const base=resolve(this.root,'objects');if(!path.startsWith(`${base}/`))throw new Error('Unsafe object key');return path}
  async createMultipart(objectKey:string):Promise<MultipartUpload>{const uploadId=randomUUID();await mkdir(join(this.root,'multipart',uploadId),{recursive:true});return{uploadId,objectKey}}
  async signPartUpload(_objectKey:string,uploadId:string,partNumber:number,expiresInSeconds:number):Promise<SignedUrl>{const expiresAt=Date.now()+expiresInSeconds*1000;const signature=this.sign(`part:${uploadId}:${partNumber}:${expiresAt}`);return{url:`${this.publicOrigin}/local-storage/parts/${encodeURIComponent(uploadId)}/${partNumber}?expires=${expiresAt}&signature=${signature}`,expiresAt}}
  verifyPartSignature(uploadId:string,partNumber:number,expiresAt:number,signature:string):boolean{return expiresAt>Date.now()&&this.safeEqual(this.sign(`part:${uploadId}:${partNumber}:${expiresAt}`),signature)}
  async writePart(uploadId:string,partNumber:number,stream:Readable):Promise<{etag:string;size:number}>{const path=this.partPath(uploadId,partNumber);await mkdir(dirname(path),{recursive:true});const output=createWriteStream(path,{flags:'w'});const hash=createHash('md5');let size=0;stream.on('data',(chunk:Buffer)=>{size+=chunk.length;hash.update(chunk)});stream.pipe(output);await finished(output);return{etag:hash.digest('hex'),size}}
  async completeMultipart(objectKey:string,uploadId:string,parts:UploadedPart[]):Promise<void>{const target=this.objectPath(objectKey);await mkdir(dirname(target),{recursive:true});const output=createWriteStream(target,{flags:'w'});for(const part of [...parts].sort((a,b)=>a.partNumber-b.partNumber)){const input=createReadStream(this.partPath(uploadId,part.partNumber));for await(const chunk of input){if(!output.write(chunk))await new Promise<void>(resolveDrain=>output.once('drain',resolveDrain));}}output.end();await finished(output);await rm(join(this.root,'multipart',uploadId),{recursive:true,force:true})}
  async abortMultipart(_objectKey:string,uploadId:string):Promise<void>{await rm(join(this.root,'multipart',uploadId),{recursive:true,force:true})}
  async signDownload(objectKey:string,expiresInSeconds:number,options?:DownloadOptions):Promise<SignedUrl>{void options;const expiresAt=Date.now()+expiresInSeconds*1000;const token=Buffer.from(objectKey).toString('base64url');const signature=this.sign(`object:${token}:${expiresAt}`);return{url:`${this.publicOrigin}/local-storage/objects/${token}?expires=${expiresAt}&signature=${signature}`,expiresAt}}
  verifyObjectSignature(token:string,expiresAt:number,signature:string):string|null{if(expiresAt<=Date.now()||!this.safeEqual(this.sign(`object:${token}:${expiresAt}`),signature))return null;try{return Buffer.from(token,'base64url').toString('utf8')}catch{return null}}
  async readRange(objectKey:string,start:number,endInclusive:number):Promise<Buffer>{const handle=await open(this.objectPath(objectKey),'r');try{const info=await handle.stat();const end=Math.min(endInclusive,info.size-1);if(end<start)return Buffer.alloc(0);const buffer=Buffer.alloc(end-start+1);const result=await handle.read(buffer,0,buffer.length,start);return buffer.subarray(0,result.bytesRead)}finally{await handle.close()}}
  async deleteObject(objectKey:string):Promise<void>{await rm(this.objectPath(objectKey),{force:true})}
  async objectSize(objectKey:string):Promise<number>{return (await stat(this.objectPath(objectKey))).size}
}
