import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrency, aggregateProgress, deriveChunkPlan, FIXED_PART_SIZE, planChunks } from '../src/index.js';

describe('上传核心逻辑', () => {
  it('固定 8 MiB 分片并拒绝超过 10,000 片的文件', () => {
    expect(() => planChunks(2 * 1024 ** 4)).toThrow('10,000');
  });
  it('创建会话时确定固定分片计划', () => {
    const plan = deriveChunkPlan(1024 * 1024 * 1024);
    expect(plan.partSize).toBe(FIXED_PART_SIZE);
    expect(plan.totalParts).toBe(128);
  });
  it('快速分片将并发从 2 升至 4、6，连续拥塞降至 1', () => {
    const adaptive = new AdaptiveConcurrency();
    expect(adaptive.value).toBe(2);
    adaptive.onSuccess(800);
    expect(adaptive.onSuccess(800)).toBe(4);
    adaptive.onSuccess(800);
    expect(adaptive.onSuccess(800)).toBe(6);
    expect(adaptive.onCongestion()).toBe(3);
    expect(adaptive.onCongestion()).toBe(1);
  });
  it('按实际字节聚合进度', () => {
    expect(aggregateProgress([
      { partNumber: 1, loaded: 50, size: 100, completed: false },
      { partNumber: 2, loaded: 100, size: 100, completed: true },
    ], 200)).toEqual({ uploaded: 150, ratio: 0.75 });
  });
});
