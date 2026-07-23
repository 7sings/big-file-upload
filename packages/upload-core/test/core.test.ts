import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrency, aggregateProgress, deriveChunkPlan, planChunks } from '../src/index.js';

describe('上传核心逻辑', () => {
  it('分片数量不超过 10000', () => {
    const plan = planChunks(2 * 1024 ** 4);
    expect(plan.totalParts).toBeLessThanOrEqual(10_000);
  });
  it('首片固定为 5MiB，后续按真实耗时自适应', async () => {
    const { INITIAL_PART_SIZE, nextAdaptivePartSize } = await import('../src/index.js');
    expect(deriveChunkPlan(1024 * 1024 * 1024).partSize).toBe(INITIAL_PART_SIZE);
    expect(nextAdaptivePartSize(INITIAL_PART_SIZE, 800)).toBe(10 * 1024 * 1024);
    expect(nextAdaptivePartSize(INITIAL_PART_SIZE, 6_000)).toBe(2.5 * 1024 * 1024);
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
