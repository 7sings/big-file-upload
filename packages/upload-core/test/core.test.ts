import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrency, aggregateProgress, deriveChunkPlan, planChunks } from '../src/index.js';

describe('上传核心逻辑', () => {
  it('分片数量不超过 10000', () => {
    const plan = planChunks(2 * 1024 ** 4);
    expect(plan.totalParts).toBeLessThanOrEqual(10_000);
  });
  it('优先使用实测上传速度，并对异常画像安全回退', () => {
    const slow = deriveChunkPlan(1024 * 1024 * 1024, { effectiveType: 'slow-2g' });
    const fast = deriveChunkPlan(1024 * 1024 * 1024, { observedUploadBps: 32 * 1024 * 1024 });
    const invalid = deriveChunkPlan(1024 * 1024 * 1024, { observedUploadBps: Number.NaN });
    expect(fast.partSize).toBeGreaterThan(slow.partSize);
    expect(invalid.totalParts).toBeLessThanOrEqual(10_000);
  });
  it('拥塞时并发减半，稳定时逐步增加', () => {
    const adaptive = new AdaptiveConcurrency(1, 6, 4);
    expect(adaptive.onCongestion()).toBe(2);
    adaptive.onSuccess(); adaptive.onSuccess();
    expect(adaptive.onSuccess()).toBe(3);
  });
  it('按实际字节聚合进度', () => {
    expect(aggregateProgress([
      { partNumber: 1, loaded: 50, size: 100, completed: false },
      { partNumber: 2, loaded: 100, size: 100, completed: true },
    ], 200)).toEqual({ uploaded: 150, ratio: 0.75 });
  });
});
