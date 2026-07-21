import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface Mailer { sendOtp(email: string, code: string, expiresInSeconds: number): Promise<void> }

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[invalid-email]';
  return `${local.slice(0, 2)}***@${domain}`;
}

export class ConsoleMailer implements Mailer {
  async sendOtp(email:string,code:string,expiresInSeconds:number):Promise<void>{ console.info(`[mail] OTP for ${email}: ${code} (expires in ${expiresInSeconds}s)`); }
}

export class NodemailerMailer implements Mailer {
  private readonly transport;
  private readonly from:string;

  constructor(options:{host:string;port:number;secure:boolean;user?:string;pass?:string;from:string;logger?:FastifyBaseLogger}) {
    this.from=options.from;
    this.logger=options.logger;
    this.transport=nodemailer.createTransport({host:options.host,port:options.port,secure:options.secure,auth:options.user ? {user:options.user,pass:options.pass}:undefined});
    this.logger?.info({event:'mail.smtp_configured',host:options.host,port:options.port,secure:options.secure,hasAuth:Boolean(options.user),from:maskEmail(options.from.match(/<([^>]+)>/)?.[1] ?? options.from)},'SMTP mailer configured');
  }

  private readonly logger?:FastifyBaseLogger;

  async sendOtp(email:string,code:string,expiresInSeconds:number):Promise<void>{
    const recipient=maskEmail(email);
    const started=Date.now();
    this.logger?.info({event:'mail.otp_sending',recipient,expiresInSeconds},'Sending OTP email');
    try {
      const result=await this.transport.sendMail({from:this.from,to:email,subject:'Your Big Upload sign-in code',text:`Your sign-in code is ${code}. It expires in ${Math.ceil(expiresInSeconds/60)} minutes.`});
      this.logger?.info({event:'mail.otp_sent',recipient,messageId:result.messageId,acceptedCount:result.accepted.length,rejectedCount:result.rejected.length,response:result.response,durationMs:Date.now()-started},'OTP email accepted by SMTP server');
    } catch (error) {
      this.logger?.error({err:error,event:'mail.otp_failed',recipient,durationMs:Date.now()-started},'SMTP failed to send OTP email');
      throw error;
    }
  }
}
