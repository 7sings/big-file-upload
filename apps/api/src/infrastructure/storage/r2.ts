import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadedPart } from '@big-upload/shared';
import type { DownloadOptions, MultipartUpload, SignedUrl, StorageProvider } from './types.js';

export class R2StorageProvider implements StorageProvider {
  private readonly client:S3Client;
  constructor(private readonly bucket:string, options:{endpoint:string;region:string;accessKeyId:string;secretAccessKey:string}){this.client=new S3Client({endpoint:options.endpoint,region:options.region,credentials:{accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey},forcePathStyle:true})}
  async createMultipart(objectKey:string,contentType:string):Promise<MultipartUpload>{const result=await this.client.send(new CreateMultipartUploadCommand({Bucket:this.bucket,Key:objectKey,ContentType:contentType}));if(!result.UploadId)throw new Error('R2 did not return an upload id');return{uploadId:result.UploadId,objectKey}}
  async signPartUpload(objectKey:string,uploadId:string,partNumber:number,expiresInSeconds:number):Promise<SignedUrl>{const expiresAt=Date.now()+expiresInSeconds*1000;const url=await getSignedUrl(this.client,new UploadPartCommand({Bucket:this.bucket,Key:objectKey,UploadId:uploadId,PartNumber:partNumber}),{expiresIn:expiresInSeconds});return{url,expiresAt}}
  async completeMultipart(objectKey:string,uploadId:string,parts:UploadedPart[]):Promise<void>{await this.client.send(new CompleteMultipartUploadCommand({Bucket:this.bucket,Key:objectKey,UploadId:uploadId,MultipartUpload:{Parts:[...parts].sort((a,b)=>a.partNumber-b.partNumber).map(part=>({PartNumber:part.partNumber,ETag:part.etag}))}}))}
  async abortMultipart(objectKey:string,uploadId:string):Promise<void>{await this.client.send(new AbortMultipartUploadCommand({Bucket:this.bucket,Key:objectKey,UploadId:uploadId}))}
  async signDownload(objectKey:string,expiresInSeconds:number,options?:DownloadOptions):Promise<SignedUrl>{const expiresAt=Date.now()+expiresInSeconds*1000;const url=await getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:objectKey,ResponseContentType:options?.contentType,ResponseContentDisposition:options?.contentDisposition}),{expiresIn:expiresInSeconds});return{url,expiresAt}}
  async readRange(objectKey:string,start:number,endInclusive:number):Promise<Buffer>{const result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:objectKey,Range:`bytes=${start}-${endInclusive}`}));if(!result.Body)return Buffer.alloc(0);return Buffer.from(await result.Body.transformToByteArray())}
  async deleteObject(objectKey:string):Promise<void>{await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:objectKey}))}
}
