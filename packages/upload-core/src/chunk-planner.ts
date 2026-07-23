export interface NetworkProfile {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
  downlinkMbps?: number;
  observedUploadBps?: number;
}

const MIB = 1024 * 1024;
export const FIXED_PART_SIZE = 8 * MIB;
const MAX_MULTIPART_PARTS = 10_000;
export interface ChunkPlan { partSize: number; totalParts: number }

export function planChunks(fileSize: number): ChunkPlan {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('文件大小无效');
  const totalParts = Math.ceil(fileSize / FIXED_PART_SIZE);
  if (totalParts > MAX_MULTIPART_PARTS) throw new Error('文件超过固定 8 MiB 分片的 10,000 片上限');
  return { partSize: FIXED_PART_SIZE, totalParts };
}

/** 所有新 multipart 会话统一采用 8 MiB 分片；网络画像只用于遥测，不参与分片边界。 */
export function deriveChunkPlan(fileSize: number, profile?: NetworkProfile): ChunkPlan {
  void profile;
  return planChunks(fileSize);
}

export function getPartRange(partNumber: number, partSize: number, fileSize: number) {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(fileSize, start + partSize);
  return { start, end, size: end - start };
}
