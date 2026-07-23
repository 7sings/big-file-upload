import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';

const prepareBody = {
  name: 'movie.mp4',
  size: 10,
  lastModified: 123,
  declaredMime: 'video/mp4',
  quickFingerprint: 'sample-md5:abcdef:10',
};

afterEach(() => vi.unstubAllGlobals());

describe('API contract adapter', () => {
  it('normalizes instant and multipart prepare responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'instant',
        file: { id: 'file-1', originalName: 'movie.mp4', byteSize: 10, detectedMime: 'video/mp4', status: 'READY', createdAt: 1 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: 'upload',
        upload: { id: 'upload-1', partSize: 5, totalParts: 2, uploadedParts: [{ partNumber: 1, etag: 'one', size: 5 }] },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.prepare(prepareBody)).resolves.toMatchObject({ instant: true, file: { id: 'file-1' } });
    await expect(api.prepare(prepareBody)).resolves.toEqual({
      instant: false,
      uploadId: 'upload-1',
      partSize: 5,
      totalParts: 2,
      uploadedParts: [{ partNumber: 1, etag: 'one', size: 5 }],
    });
  });

  it('uses the backend ack, preview, text, and delete routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploadedParts: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://storage.test/file', mime: 'image/png' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: 'hello' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.ack('upload id', [{ partNumber: 1, etag: 'etag', size: 5 }]);
    await api.preview('file id');
    await api.text('file id');
    await api.deleteFile('file id');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/uploads/upload%20id/ack');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/files/file%20id/preview');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/files/file%20id/text');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/files/file%20id');
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
