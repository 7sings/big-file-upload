import { describe, expect, it } from 'vitest';
import { R2StorageProvider } from '../src/infrastructure/storage/r2.js';

const options = {
  endpoint: 'https://example.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

describe('R2StorageProvider Worker binding', () => {
  it('uses the native binding for server-side multipart and object operations', async () => {
    const calls: Array<{ name: string; value: unknown }> = [];
    const multipart = {
      key: 'quarantine/file',
      uploadId: 'upload-native',
      uploadPart: async () => ({ partNumber: 1, etag: 'unused' }),
      abort: async () => {
        calls.push({ name: 'abort', value: null });
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        calls.push({ name: 'complete', value: parts });
        return {} as R2Object;
      },
    };
    const binding = {
      createMultipartUpload: async (key: string, value?: R2MultipartOptions) => {
        calls.push({ name: 'create', value: { key, options: value } });
        return multipart;
      },
      resumeMultipartUpload: (key: string, uploadId: string) => {
        calls.push({ name: 'resume', value: { key, uploadId } });
        return multipart;
      },
      get: async (key: string, value?: R2GetOptions) => {
        calls.push({ name: 'get', value: { key, options: value } });
        return { bytes: async () => new Uint8Array([1, 2, 3]) } as R2ObjectBody;
      },
      delete: async (key: string) => {
        calls.push({ name: 'delete', value: key });
      },
    } as R2Bucket;
    const storage = new R2StorageProvider('big-file-upload', { ...options, binding });

    await expect(storage.createMultipart('quarantine/file', 'image/png')).resolves.toEqual({
      uploadId: 'upload-native',
      objectKey: 'quarantine/file',
    });
    await storage.completeMultipart('quarantine/file', 'upload-native', [
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 1, etag: 'etag-1' },
    ]);
    await storage.abortMultipart('quarantine/file', 'upload-native');
    await expect(storage.readRange('quarantine/file', 4, 6)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await storage.deleteObject('quarantine/file');

    expect(calls).toContainEqual({
      name: 'create',
      value: {
        key: 'quarantine/file',
        options: { httpMetadata: { contentType: 'image/png' } },
      },
    });
    expect(calls).toContainEqual({
      name: 'complete',
      value: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
      ],
    });
    expect(calls).toContainEqual({
      name: 'get',
      value: { key: 'quarantine/file', options: { range: { offset: 4, length: 3 } } },
    });
    expect(calls).toContainEqual({ name: 'delete', value: 'quarantine/file' });
  });
});
