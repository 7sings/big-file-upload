import { ALLOWED_MIME_TYPES } from '@big-upload/shared';

const decoder = new TextDecoder();
function ascii(buffer: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...buffer.subarray(start, start + length));
}
function startsWith(buffer: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => buffer[index] === byte);
}

export function detectContentType(buffer: Uint8Array): string | null {
  if (buffer.length >= 3 && startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buffer.length >= 8 && startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') return 'image/webp';
  if (buffer.length >= 4 && startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(buffer, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(buffer, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(buffer, 0, 4) === '%PDF') return 'application/pdf';
  if (
    ascii(buffer, 0, 3) === 'ID3' ||
    (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)
  )
    return 'audio/mpeg';
  if (buffer.length >= 12 && ascii(buffer, 4, 4) === 'ftyp') {
    const brand = ascii(buffer, 8, 4).toLowerCase();
    if (brand.includes('m4a') || brand.includes('m4b') || brand.includes('f4a')) return 'audio/mp4';
    if (brand.trim() === 'qt') return 'video/quicktime';
    return 'video/mp4';
  }
  if (buffer.length > 0) {
    let suspicious = 0;
    for (const byte of buffer) {
      if (byte === 0) suspicious += 4;
      else if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
    }
    const decoded = decoder.decode(buffer);
    if (!decoded.includes('�') && suspicious / buffer.length < 0.02) return 'text/plain';
  }
  return null;
}
export function isAllowedContentType(value: string | null): value is string {
  return value !== null && ALLOWED_MIME_TYPES.has(value);
}
