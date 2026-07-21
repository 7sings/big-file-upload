import { describe, expect, it } from 'vitest';
import { detectContentType } from '../src/content-type.js';

describe('detectContentType',()=>{
  it('detects representative magic bytes',()=>{
    expect(detectContentType(Buffer.from([0xff,0xd8,0xff,0xe0]))).toBe('image/jpeg');
    expect(detectContentType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectContentType(Buffer.from('hello, UTF-8 text\n'))).toBe('text/plain');
    expect(detectContentType(Buffer.from([0,0,0,20,0x66,0x74,0x79,0x70,0x71,0x74,0x20,0x20]))).toBe('video/quicktime');
  });
  it('does not trust random binary data',()=>expect(detectContentType(Buffer.from([0,1,2,3,4,5,0,255]))).toBeNull());
});
