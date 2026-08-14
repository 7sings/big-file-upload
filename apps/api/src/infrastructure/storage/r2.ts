import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadedPart } from '@big-upload/shared';
import type { DownloadOptions, MultipartUpload, SignedUrl, StorageProvider } from './types.js';

export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    options: {
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      binding?: R2Bucket;
    },
  ) {
    this.binding = options.binding;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
    });
  }
  private readonly binding?: R2Bucket;

  async createMultipart(objectKey: string, contentType: string): Promise<MultipartUpload> {
    if (this.binding) {
      const upload = await this.binding.createMultipartUpload(objectKey, {
        httpMetadata: { contentType },
      });
      return { uploadId: upload.uploadId, objectKey };
    }
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) throw new Error('R2 did not return an upload id');
    return { uploadId: result.UploadId, objectKey };
  }
  async signPartUpload(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<SignedUrl> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt };
  }
  async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    if (this.binding) {
      const upload = this.binding.resumeMultipartUpload(objectKey, uploadId);
      await upload.complete(
        [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      );
      return;
    }
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }
  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    if (this.binding) {
      await this.binding.resumeMultipartUpload(objectKey, uploadId).abort();
      return;
    }
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: objectKey, UploadId: uploadId }),
    );
  }
  async signDownload(
    objectKey: string,
    expiresInSeconds: number,
    options?: DownloadOptions,
  ): Promise<SignedUrl> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ResponseContentType: options?.contentType,
        ResponseContentDisposition: options?.contentDisposition,
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt };
  }
  async readRange(objectKey: string, start: number, endInclusive: number): Promise<Uint8Array> {
    if (this.binding) {
      const result = await this.binding.get(objectKey, {
        range: { offset: start, length: endInclusive - start + 1 },
      });
      return result ? result.bytes() : new Uint8Array();
    }
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Range: `bytes=${start}-${endInclusive}`,
      }),
    );
    if (!result.Body) return new Uint8Array();
    return result.Body.transformToByteArray();
  }
  async deleteObject(objectKey: string): Promise<void> {
    if (this.binding) {
      await this.binding.delete(objectKey);
      return;
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}
