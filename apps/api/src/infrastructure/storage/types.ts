import type { Readable } from 'node:stream';
import type { UploadedPart } from '@big-upload/shared';

export interface MultipartUpload { uploadId: string; objectKey: string }
export interface SignedUrl { url: string; expiresAt: number }
export interface DownloadOptions { contentType?: string; contentDisposition?: string }
export interface StorageProvider {
  createMultipart(objectKey: string, contentType: string): Promise<MultipartUpload>;
  signPartUpload(objectKey: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<SignedUrl>;
  completeMultipart(objectKey: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(objectKey: string, uploadId: string): Promise<void>;
  signDownload(objectKey: string, expiresInSeconds: number, options?: DownloadOptions): Promise<SignedUrl>;
  readRange(objectKey: string, start: number, endInclusive: number): Promise<Buffer>;
  deleteObject(objectKey: string): Promise<void>;
}
export interface LocalStorageAccess {
  verifyPartSignature(uploadId:string,partNumber:number,expiresAt:number,signature:string):boolean;
  writePart(uploadId:string,partNumber:number,stream:Readable):Promise<{etag:string;size:number}>;
  verifyObjectSignature(token:string,expiresAt:number,signature:string):string|null;
  objectPath(objectKey:string):string;
}
