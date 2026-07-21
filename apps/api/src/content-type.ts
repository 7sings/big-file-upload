import { ALLOWED_MIME_TYPES } from '@big-upload/shared';

function ascii(buffer:Buffer,start:number,length:number):string{return buffer.subarray(start,start+length).toString('ascii')}
export function detectContentType(buffer:Buffer):string|null {
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return'image/jpeg';
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return'image/png';
  if(ascii(buffer,0,6)==='GIF87a'||ascii(buffer,0,6)==='GIF89a')return'image/gif';
  if(ascii(buffer,0,4)==='RIFF'&&ascii(buffer,8,4)==='WEBP')return'image/webp';
  if(buffer.length>=4&&buffer[0]===0x1a&&buffer[1]===0x45&&buffer[2]===0xdf&&buffer[3]===0xa3)return'video/webm';
  if(ascii(buffer,0,4)==='RIFF'&&ascii(buffer,8,4)==='WAVE')return'audio/wav';
  if(ascii(buffer,0,4)==='OggS')return'audio/ogg';
  if(ascii(buffer,0,4)==='fLaC')return'audio/flac';
  if(ascii(buffer,0,4)==='%PDF')return'application/pdf';
  if(ascii(buffer,0,3)==='ID3'||(buffer.length>=2&&buffer[0]===0xff&&(buffer[1]!&0xe0)===0xe0))return'audio/mpeg';
  if(buffer.length>=12&&ascii(buffer,4,4)==='ftyp'){
    const brand=ascii(buffer,8,4).toLowerCase();
    if(brand.includes('m4a')||brand.includes('m4b')||brand.includes('f4a'))return'audio/mp4';
    if(brand.trim()==='qt')return'video/quicktime';
    return'video/mp4';
  }
  if(buffer.length>0){let suspicious=0;for(const byte of buffer){if(byte===0)suspicious+=4;else if(byte<7||(byte>13&&byte<32))suspicious++;}const decoded=buffer.toString('utf8');if(!decoded.includes('�')&&suspicious/buffer.length<0.02)return'text/plain';}
  return null;
}
export function isAllowedContentType(value:string|null):value is string{return value!==null&&ALLOWED_MIME_TYPES.has(value)}
