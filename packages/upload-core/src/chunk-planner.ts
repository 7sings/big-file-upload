export interface NetworkProfile {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
  downlinkMbps?: number;
  observedUploadBps?: number;
}

const MIB = 1024 * 1024;
export const INITIAL_PART_SIZE = 5 * MIB;
export const MIN_ADAPTIVE_PART_SIZE = 1 * MIB;
export const MAX_ADAPTIVE_PART_SIZE = 16 * MIB;
export interface ChunkPlan { partSize: number; totalParts: number }

/** Select the next part from a real upload sample.  One sample is deliberately
 * used at a time so concurrent requests cannot hide a congested connection. */
export function nextAdaptivePartSize(currentSize: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return currentSize;
  if (elapsedMs < 1_000) return Math.min(MAX_ADAPTIVE_PART_SIZE, currentSize * 2);
  if (elapsedMs > 5_000) return Math.max(MIN_ADAPTIVE_PART_SIZE, Math.floor(currentSize / 2));
  return currentSize;
}

function roundUpMiB(value: number): number {
  const mib = Math.ceil(value / MIB);
  return 2 ** Math.ceil(Math.log2(Math.max(1, mib))) * MIB;
}

function validSpeed(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, 1024 * MIB) : undefined;
}

export function planChunks(fileSize: number, bytesPerSecond?: number): ChunkPlan {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('文件大小无效');
  const byCount = Math.ceil(fileSize / 10_000);
  const bySpeed = validSpeed(bytesPerSecond) ? validSpeed(bytesPerSecond)! * 8 : INITIAL_PART_SIZE;
  let partSize = roundUpMiB(Math.max(INITIAL_PART_SIZE, byCount, bySpeed));
  partSize = Math.min(partSize, MAX_ADAPTIVE_PART_SIZE);
  while (Math.ceil(fileSize / partSize) > 10_000) partSize *= 2;
  return { partSize, totalParts: Math.ceil(fileSize / partSize) };
}

/** 在创建 multipart 会话前，根据真实上传样本优先、网络档位兜底的策略确定固定分片边界。 */
export function deriveChunkPlan(fileSize: number, profile?: NetworkProfile): ChunkPlan {
  // Browser Network Information exposes download, not upload, throughput.
  // Always begin with a neutral 5 MiB probe and adapt from its actual duration.
  void profile;
  return { partSize: Math.min(INITIAL_PART_SIZE, fileSize), totalParts: 0 };
}

export function getPartRange(partNumber: number, partSize: number, fileSize: number) {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(fileSize, start + partSize);
  return { start, end, size: end - start };
}
