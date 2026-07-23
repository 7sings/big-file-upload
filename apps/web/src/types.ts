import type { ClientUploadStatus, NetworkProfile, UploadedPart } from '@big-upload/shared';

export interface FingerprintRange { offset: number; length: number; sha256: string }
export interface FingerprintResult { quickFingerprint: string; sampledBytes: number; ranges: FingerprintRange[] }

export interface UploadSession {
  localId: string;
  ownerId: string;
  uploadId?: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  lastModified: number;
  quickFingerprint?: string;
  rangeHashes?: FingerprintRange[];
  partSize?: number;
  totalParts?: number;
  uploadedParts: UploadedPart[];
  status: ClientUploadStatus;
  createdAt: number;
  updatedAt: number;
  lastBytesPerSecond?: number;
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  /** Runtime-only start timestamp for the current active upload interval. */
  elapsedStartedAt?: number;
  expiresAt?: number;
  remoteOnly?: boolean;
}

export interface UploadView extends UploadSession {
  file?: File;
  uploadedBytes: number;
  speed: number;
  etaSeconds: number | null;
  error?: string;
  needsFile?: boolean;
}

export type UploadPrepared =
  | { instant: true; file: import('@big-upload/shared').FileRecord }
  | { instant: false; uploadId: string; partSize: number; totalParts: number; uploadedParts: UploadedPart[]; resumed?: boolean };

export type PrepareResponse = UploadPrepared | {
  challenge: true;
  challengeId: string;
  ranges: Array<{ offset: number; length: number }>;
};

export interface ServerUpload {
  id: string; status: string; fileName: string; byteSize: number; declaredMime: string; lastModified: number; quickFingerprint: string;
  partSize: number; totalParts: number; uploadedParts: UploadedPart[]; expiresAt: number; error?: string | null;
}
export interface PrepareRequest { name: string; size: number; lastModified: number; declaredMime: string; quickFingerprint: string; networkProfile?: NetworkProfile }
export interface PresignedPart { partNumber: number; url: string; headers?: Record<string, string> }
export interface FileListResponse { files: import('@big-upload/shared').FileRecord[]; nextCursor?: number }
export interface PreviewTicket { url: string; expiresAt?: number; mime?: string }
