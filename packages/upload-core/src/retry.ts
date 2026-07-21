export function retryDelay(attempt: number, random = Math.random): number {
  const cap = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  return Math.floor(random() * cap);
}
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || [500, 502, 503, 504].includes(status);
}
