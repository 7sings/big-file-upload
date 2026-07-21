import nodemailer from 'nodemailer';

export interface Mailer { sendOtp(email: string, code: string, expiresInSeconds: number): Promise<void> }
export class ConsoleMailer implements Mailer { async sendOtp(email:string,code:string,expiresInSeconds:number):Promise<void>{ console.info(`[mail] OTP for ${email}: ${code} (expires in ${expiresInSeconds}s)`); } }
export class NodemailerMailer implements Mailer {
  private readonly transport;
  constructor(options:{host:string;port:number;secure:boolean;user?:string;pass?:string;from:string}) { this.from=options.from; this.transport=nodemailer.createTransport({host:options.host,port:options.port,secure:options.secure,auth:options.user ? {user:options.user,pass:options.pass}:undefined}); }
  private readonly from:string;
  async sendOtp(email:string,code:string,expiresInSeconds:number):Promise<void>{ await this.transport.sendMail({from:this.from,to:email,subject:'Your Big Upload sign-in code',text:`Your sign-in code is ${code}. It expires in ${Math.ceil(expiresInSeconds/60)} minutes.`}); }
}
