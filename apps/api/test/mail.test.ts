import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NodemailerMailer } from '../src/infrastructure/mail.js';

const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))});

async function listen(server:Server):Promise<number>{
  servers.push(server);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})});
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Expected TCP server address');
  return address.port;
}

function mailer(port:number,greetingTimeoutMs=500):NodemailerMailer{return new NodemailerMailer({host:'localhost',port,secure:false,from:'Big Upload <no-reply@example.com>',addressFamily:'ipv4',dnsTimeoutMs:500,connectionTimeoutMs:500,greetingTimeoutMs,socketTimeoutMs:500})}

describe('NodemailerMailer',()=>{
  it('uses IPv4 for a hostname and completes SMTP delivery',async()=>{
    let remoteFamily='';
    const server=createServer(socket=>{
      remoteFamily=socket.remoteFamily??'';
      socket.write('220 test SMTP\r\n');
      let buffer='';let inData=false;
      socket.on('data',chunk=>{
        buffer+=chunk.toString();
        while(true){const end=buffer.indexOf('\r\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
          if(inData){if(line==='.') {inData=false;socket.write('250 queued\r\n')}continue}
          if(/^EHLO /i.test(line))socket.write('250-test\r\n250 OK\r\n');
          else if(/^MAIL FROM:/i.test(line)||/^RCPT TO:/i.test(line))socket.write('250 OK\r\n');
          else if(/^DATA$/i.test(line)){inData=true;socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')}
          else if(/^QUIT$/i.test(line)){socket.end('221 bye\r\n');return}
        }
      });
    });
    await mailer(await listen(server)).sendOtp('person@example.com','123456',600);
    expect(remoteFamily).toBe('IPv4');
  });

  it('honors the configured SMTP greeting timeout',async()=>{
    const server=createServer();
    const started=Date.now();
    await expect(mailer(await listen(server),100).sendOtp('person@example.com','123456',600)).rejects.toMatchObject({code:'ETIMEDOUT'});
    expect(Date.now()-started).toBeLessThan(1000);
  });
});
