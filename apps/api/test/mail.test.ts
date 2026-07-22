import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NodemailerMailer, ResendMailer } from '../src/infrastructure/mail.js';

const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).filter(server=>server.listening).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))))});

async function listen(server:Server):Promise<number>{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})});
  servers.push(server);
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

describe('ResendMailer',()=>{
  it('sends the OTP through the Resend HTTPS API',async()=>{
    const requests:Array<{url:string;init?:RequestInit}>=[];
    const fetchMock=async(input:string|URL|Request,init?:RequestInit)=>{requests.push({url:String(input),init});return new Response(JSON.stringify({id:'email_123'}),{status:200,headers:{'content-type':'application/json'}})};
    const value=new ResendMailer({apiKey:'re_test',apiUrl:'https://api.resend.com/',timeoutMs:500,from:'Big Upload <login@example.com>',fetch:fetchMock});
    await value.sendOtp('person@example.com','123456',600);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.resend.com/emails');
    expect(requests[0]?.init?.headers).toEqual(expect.objectContaining({authorization:'Bearer re_test'}));
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(expect.objectContaining({from:'Big Upload <login@example.com>',to:['person@example.com']}));
  });

  it('surfaces a Resend API rejection without exposing the token',async()=>{
    const fetchMock=async()=>new Response(JSON.stringify({message:'The from address is not verified'}),{status:403,headers:{'content-type':'application/json'}});
    const value=new ResendMailer({apiKey:'re_secret',apiUrl:'https://api.resend.com',timeoutMs:500,from:'Big Upload <login@example.com>',fetch:fetchMock});
    await expect(value.sendOtp('person@example.com','123456',600)).rejects.toMatchObject({message:'The from address is not verified',code:'RESEND_403'});
  });
});
