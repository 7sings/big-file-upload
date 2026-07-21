/// <reference lib="webworker" />
import SparkMD5 from 'spark-md5';

interface Range { offset: number; length: number }
type HashMessage =
  | { id: string; type: 'fingerprint'; file: File }
  | { id: string; type: 'ranges'; file: File; ranges: Range[] };

const SAMPLE_SIZE = 2 * 1024 * 1024;
const MAX_RANGES = 7;

function sampleRanges(size: number): Range[] {
  if (size <= SAMPLE_SIZE * 3) return [{ offset: 0, length: size }];
  const length = Math.min(SAMPLE_SIZE, size);
  const offsets = new Set<number>([0, Math.max(0, size - length), Math.max(0, Math.floor((size - length) / 2))]);
  for (let i = 1; i <= MAX_RANGES - 3; i += 1) offsets.add(Math.max(0, Math.floor(((size - length) * i) / (MAX_RANGES - 2))));
  return [...offsets].sort((a, b) => a - b).map((offset) => ({ offset, length: Math.min(length, size - offset) }));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Ranges(file: File, ranges: Range[], id: string) {
  const results: string[] = [];
  let loaded = 0;
  const total = ranges.reduce((sum, range) => sum + range.length, 0);
  for (const range of ranges) {
    const bytes = await file.slice(range.offset, range.offset + range.length).arrayBuffer();
    results.push(hex(await crypto.subtle.digest('SHA-256', bytes)));
    loaded += range.length;
    self.postMessage({ id, type: 'progress', loaded, total });
  }
  return results;
}

self.onmessage = async (event: MessageEvent<HashMessage>) => {
  const message = event.data;
  try {
    if (message.type === 'ranges') {
      const hashes = await sha256Ranges(message.file, message.ranges, message.id);
      self.postMessage({ id: message.id, type: 'ranges-done', hashes });
      return;
    }

    const spark = new SparkMD5.ArrayBuffer();
    const ranges = sampleRanges(message.file.size);
    const results: Array<{ offset: number; length: number; sha256: string }> = [];
    let sampledBytes = 0;
    const total = ranges.reduce((sum, range) => sum + range.length, 0);
    for (const range of ranges) {
      const bytes = await message.file.slice(range.offset, range.offset + range.length).arrayBuffer();
      spark.append(bytes);
      results.push({ ...range, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) });
      sampledBytes += range.length;
      self.postMessage({ id: message.id, type: 'progress', loaded: sampledBytes, total });
    }
    self.postMessage({ id: message.id, type: 'done', result: { quickFingerprint: `sample-md5:${spark.end()}:${message.file.size}`, sampledBytes, ranges: results } });
  } catch (error) {
    self.postMessage({ id: message.id, type: 'error', message: error instanceof Error ? error.message : '文件指纹计算失败' });
  }
};

export {};
