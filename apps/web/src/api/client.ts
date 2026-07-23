import type { ApiErrorPayload, CurrentUser, FileRecord, OtpRequest, OtpVerify, UploadedPart } from '@big-upload/shared';
import type { FileListResponse, PrepareRequest, PrepareResponse, PresignedPart, PreviewTicket, ServerUpload, UploadPrepared } from '../types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code = 'HTTP_ERROR', public requestId?: string, public retryAfterSeconds?: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  let response: Response;
  try { response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' }); }
  catch { throw new ApiError('无法连接服务器，请检查网络或 API 服务。', 0, 'NETWORK_ERROR'); }
  if (!response.ok) {
    let payload: ApiErrorPayload | undefined;
    try { payload = await response.json() as ApiErrorPayload; } catch { /* non-JSON error */ }
    const retryAfterSeconds = payload?.error?.retryAfterSeconds ?? (Number(response.headers.get('retry-after') || 0) || undefined);
    throw new ApiError(payload?.error?.message ?? `请求失败 (${response.status})`, response.status, payload?.error?.code, payload?.error?.requestId, retryAfterSeconds);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

interface PrepareWireUpload extends ServerUpload { resumed?: boolean }
type PreparedWireResponse =
  | { kind: 'instant'; file: FileRecord }
  | { kind: 'upload'; upload: PrepareWireUpload; resumed?: boolean }
  | { kind: 'dedupe_challenge'; challengeId: string; ranges: Array<{ offset: number; length: number }> };

function normalizePrepared(result: Exclude<PreparedWireResponse, { kind: 'dedupe_challenge' }>): UploadPrepared {
  if (result.kind === 'instant') return { instant: true, file: result.file };
  return { instant: false, uploadId: result.upload.id, partSize: result.upload.partSize, totalParts: result.upload.totalParts, uploadedParts: result.upload.uploadedParts ?? [], resumed: result.resumed ?? result.upload.resumed };
}

export const api = {
  requestOtp: (body: OtpRequest) => request<{ challengeId: string; expiresAt?: number; resendAfter?: number }>('/auth/otp/request', { method: 'POST', body: JSON.stringify(body) }),
  verifyOtp: (body: OtpVerify) => request<{ user: CurrentUser } | CurrentUser>('/auth/otp/verify', { method: 'POST', body: JSON.stringify(body) }),
  me: () => request<{ user: CurrentUser } | CurrentUser>('/auth/me'),
  config: () => request<{ maxFileSizeBytes: number }>('/config'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  prepare: async (body: PrepareRequest): Promise<PrepareResponse> => {
    const result = await request<PreparedWireResponse>('/uploads/prepare', { method: 'POST', body: JSON.stringify(body) });
    if (result.kind === 'dedupe_challenge') return { challenge: true, challengeId: result.challengeId, ranges: result.ranges };
    return normalizePrepared(result);
  },
  verifyDedupe: async (challengeId: string, hashes: string[]): Promise<UploadPrepared> => normalizePrepared(await request<Exclude<PreparedWireResponse, { kind: 'dedupe_challenge' }>>('/uploads/dedupe/verify', { method: 'POST', body: JSON.stringify({ challengeId, hashes }) })),
  activeUploads: () => request<{ uploads: ServerUpload[] }>('/uploads?state=active'),
  uploadStatus: (uploadId: string) => request<{ upload: ServerUpload }>(`/uploads/${encodeURIComponent(uploadId)}`),
  presign: (uploadId: string, partNumbers: number[]) => request<{ parts: PresignedPart[] }>(`/uploads/${encodeURIComponent(uploadId)}/presign`, { method: 'POST', body: JSON.stringify({ partNumbers }) }),
  ack: (uploadId: string, parts: UploadedPart[]) => request<{ uploadedParts: UploadedPart[] }>(`/uploads/${encodeURIComponent(uploadId)}/ack`, { method: 'POST', body: JSON.stringify({ parts }) }),
  pause: (uploadId: string) => request<{ upload: ServerUpload }>(`/uploads/${encodeURIComponent(uploadId)}/pause`, { method: 'POST' }),
  resume: (uploadId: string) => request<{ upload: ServerUpload }>(`/uploads/${encodeURIComponent(uploadId)}/resume`, { method: 'POST' }),
  complete: (uploadId: string) => request<{ file?: FileRecord; upload?: { status: string } }>(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' }),
  abort: (uploadId: string) => request<void>(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }),
  files: async () => { const files: FileRecord[] = []; let before: number | undefined; do { const query = before ? `?limit=100&before=${before}` : '?limit=100'; const result = await request<FileListResponse | FileRecord[]>(`/files${query}`); if (Array.isArray(result)) { files.push(...result); break; } files.push(...result.files); before = result.nextCursor; } while (before); return files; },
  preview: (fileId: string) => request<PreviewTicket>(`/files/${encodeURIComponent(fileId)}/preview`, { method: 'POST' }),
  text: (fileId: string) => request<{ content: string }>(`/files/${encodeURIComponent(fileId)}/text`),
  deleteFile: (fileId: string) => request<void>(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
  downloadUrl: (fileId: string) => `${API_BASE}/files/${encodeURIComponent(fileId)}/download`,
};

export function unwrapUser(value: { user: CurrentUser } | CurrentUser): CurrentUser { return 'user' in value ? value.user : value; }
