import type { FingerprintResult } from '../types';

interface Range { offset: number; length: number }
interface WorkerResponse {
  id: string;
  type: string;
  loaded?: number;
  total?: number;
  result?: FingerprintResult;
  hashes?: string[];
  message?: string;
}

function runWorker<T>(file: File, message: Record<string, unknown>, doneType: string, select: (response: WorkerResponse) => T | undefined, onProgress?: (ratio: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/hash.worker.ts', import.meta.url), { type: 'module' });
    const id = crypto.randomUUID();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.type === 'progress') onProgress?.((event.data.loaded ?? 0) / Math.max(1, event.data.total ?? 1));
      if (event.data.type === doneType) {
        const value = select(event.data);
        if (value !== undefined) { worker.terminate(); resolve(value); }
      }
      if (event.data.type === 'error') { worker.terminate(); reject(new Error(event.data.message ?? '文件哈希计算失败')); }
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('哈希 Worker 启动失败')); };
    worker.postMessage({ id, file, ...message });
  });
}

export function fingerprintFile(file: File, onProgress?: (ratio: number) => void): Promise<FingerprintResult> {
  return runWorker(file, { type: 'fingerprint' }, 'done', (response) => response.result, onProgress);
}

export function hashFileRanges(file: File, ranges: Range[], onProgress?: (ratio: number) => void): Promise<string[]> {
  return runWorker(file, { type: 'ranges', ranges }, 'ranges-done', (response) => response.hashes, onProgress);
}
