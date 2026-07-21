export interface NetworkProfile {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
  downlinkMbps?: number;
  observedUploadBps?: number;
}

const MIB = 1024 * 1024;
const MIN_PART = 8 * MIB;
const DEFAULT_PART = 16 * MIB;
const MAX_SOFT_PART = 128 * MIB;
const NETWORK_BPS: Record<NonNullable<NetworkProfile['effectiveType']>, number> = {
  'slow-2g': 50 * 1024,
  '2g': 250 * 1024,
  '3g': 1_000 * 1024,
  '4g': 8 * MIB,
  unknown: 0,
};

export interface ChunkPlan { partSize: number; totalParts: number }

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
  const bySpeed = validSpeed(bytesPerSecond) ? validSpeed(bytesPerSecond)! * 8 : DEFAULT_PART;
  let partSize = roundUpMiB(Math.max(MIN_PART, byCount, bySpeed));
  partSize = Math.min(partSize, MAX_SOFT_PART);
  while (Math.ceil(fileSize / partSize) > 10_000) partSize *= 2;
  return { partSize, totalParts: Math.ceil(fileSize / partSize) };
}

/** 在创建 multipart 会话前，根据真实上传样本优先、网络档位兜底的策略确定固定分片边界。 */
export function deriveChunkPlan(fileSize: number, profile?: NetworkProfile): ChunkPlan {
  const observed = validSpeed(profile?.observedUploadBps);
  if (observed) return planChunks(fileSize, observed);
  const downlink = validSpeed(profile?.downlinkMbps ? profile.downlinkMbps * MIB / 8 : undefined);
  const tier = profile?.effectiveType && NETWORK_BPS[profile.effectiveType] ? NETWORK_BPS[profile.effectiveType] : undefined;
  return planChunks(fileSize, downlink ?? tier);
}

export function getPartRange(partNumber: number, partSize: number, fileSize: number) {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(fileSize, start + partSize);
  return { start, end, size: end - start };
}
