export type UploadStatus =
  | 'INITIATED'
  | 'UPLOADING'
  | 'PAUSED'
  | 'COMPLETING'
  | 'VERIFYING'
  | 'READY'
  | 'ABORTED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'FAILED';

export type ClientUploadStatus =
  | 'HASHING'
  | 'PREPARING'
  | 'UPLOADING'
  | 'PAUSED'
  | 'WAITING_NETWORK'
  | 'COMPLETING'
  | 'VERIFYING'
  | 'SUCCEEDED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELED';

export type NetworkEffectiveType = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
export interface NetworkProfile {
  effectiveType?: NetworkEffectiveType;
  downlinkMbps?: number;
  observedUploadBps?: number;
}

export interface ByteRange { offset: number; length: number }
export interface UploadedPart { partNumber: number; etag: string; size: number }
export interface ApiErrorPayload { error: { code: string; message: string; requestId?: string; retryAfterSeconds?: number } }
export interface CurrentUser { id: string; email: string }
export interface FileRecord {
  id: string;
  originalName: string;
  byteSize: number;
  detectedMime: string;
  status: string;
  createdAt: number;
}
