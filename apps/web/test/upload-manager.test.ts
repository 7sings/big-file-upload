import { describe, expect, it } from 'vitest';
import { fingerprintsMatch, isLikelySupported } from '../src/features/upload-manager';

function file(name: string, type: string) { return new File(['content'], name, { type, lastModified: 123 }); }

describe('client file filtering', () => {
  it('accepts the supported preview families', () => {
    expect(isLikelySupported(file('photo.jpg', 'image/jpeg'))).toBe(true);
    expect(isLikelySupported(file('movie.mp4', 'video/mp4'))).toBe(true);
    expect(isLikelySupported(file('iphone-video.mov', 'video/quicktime'))).toBe(true);
    expect(isLikelySupported(file('notes.txt', 'text/plain'))).toBe(true);
    expect(isLikelySupported(file('document.pdf', 'application/pdf'))).toBe(true);
  });

  it('rejects active and archive content', () => {
    expect(isLikelySupported(file('page.html', 'text/html'))).toBe(false);
    expect(isLikelySupported(file('vector.svg', 'image/svg+xml'))).toBe(false);
    expect(isLikelySupported(file('archive.zip', 'application/zip'))).toBe(false);
  });

  it('uses extension only when the browser provides no mime', () => {
    expect(isLikelySupported(file('recording.m4a', ''))).toBe(true);
    expect(isLikelySupported(file('malware.pdf.exe', ''))).toBe(false);
    expect(isLikelySupported(file('fake.jpg', 'application/x-msdownload'))).toBe(false);
  });
});

describe('resume fingerprint matching', () => {
  const candidate = {
    quickFingerprint: 'sample-md5:abc:100',
    sampledBytes: 100,
    ranges: [{ offset: 0, length: 100, sha256: 'range-a' }],
  };

  it('requires both sampled MD5 and saved range SHA-256 values', () => {
    expect(fingerprintsMatch({ quickFingerprint: candidate.quickFingerprint, rangeHashes: candidate.ranges }, candidate)).toBe(true);
    expect(fingerprintsMatch({ quickFingerprint: 'sample-md5:other:100', rangeHashes: candidate.ranges }, candidate)).toBe(false);
    expect(fingerprintsMatch({ quickFingerprint: candidate.quickFingerprint, rangeHashes: [{ ...candidate.ranges[0]!, sha256: 'range-b' }] }, candidate)).toBe(false);
  });
});
