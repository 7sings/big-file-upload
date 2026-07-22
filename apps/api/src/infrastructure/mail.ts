import { lookup } from 'node:dns';
import { connect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { SmtpAddressFamily } from '../config.js';

export interface Mailer { sendOtp(email: string, code: string, expiresInSeconds: number): Promise<void> }

type SmtpOptions = {
  host: string; port: number; secure: boolean; user?: string; pass?: string; from: string; logger?: FastifyBaseLogger;
  addressFamily: SmtpAddressFamily; dnsTimeoutMs: number; connectionTimeoutMs: number; greetingTimeoutMs: number; socketTimeoutMs: number;
};

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[invalid-email]';
  return `${local.slice(0, 2)}***@${domain}`;
}

function timeoutError(stage: string): Error {
  const error = new Error(`SMTP ${stage} timed out`) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  return error;
}

function ipv4Socket(options: SmtpOptions, callback: (error: Error | null, socketOptions: { connection?: Socket; secured?: boolean }) => void): void {
  let finished = false;
  let socket: Socket | TLSSocket | undefined;
  const readyEvent = options.secure ? 'secureConnect' : 'connect';
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let lastError: Error | null = null;
  let onConnect = () => undefined;
  let onError: (error: Error) => void = () => undefined;

  const cleanupSocket = () => {
    if (connectionTimer) clearTimeout(connectionTimer);
    socket?.removeListener(readyEvent, onConnect);
    socket?.removeListener('error', onError);
  };
  const finish = (error: Error | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(dnsTimer);
    cleanupSocket();
    if (error && socket && !socket.destroyed) socket.destroy();
    callback(error, socket ? { connection: socket, secured: options.secure || undefined } : {});
  };
  const connectNext = (addresses: string[], index: number) => {
    if (finished) return;
    if (index >= addresses.length) return finish(lastError ?? new Error(`SMTP host ${options.host} did not resolve to an IPv4 address`));
    try {
      socket = options.secure
        ? tlsConnect({ host: addresses[index]!, port: options.port, servername: options.host })
        : connect({ host: addresses[index]!, port: options.port, family: 4 });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      return connectNext(addresses, index + 1);
    }
    connectionTimer = setTimeout(() => {
      lastError = timeoutError('connection');
      cleanupSocket();
      if (socket && !socket.destroyed) socket.destroy();
      connectNext(addresses, index + 1);
    }, options.connectionTimeoutMs);
    onConnect = () => {
      socket?.setKeepAlive(true);
      finish(null);
    };
    onError = (error: Error) => {
      lastError = error;
      cleanupSocket();
      connectNext(addresses, index + 1);
    };
    socket.once(readyEvent, onConnect);
    socket.once('error', onError);
  };
  const dnsTimer = setTimeout(() => finish(timeoutError('DNS lookup')), options.dnsTimeoutMs);
  lookup(options.host, { all: true, family: 4, verbatim: true }, (error, addresses) => {
    if (finished) return;
    clearTimeout(dnsTimer);
    if (error) return finish(error);
    connectNext(addresses.map(address => address.address), 0);
  });
}

export class ConsoleMailer implements Mailer {
  async sendOtp(email:string,code:string,expiresInSeconds:number):Promise<void>{ console.info(`[mail] OTP for ${email}: ${code} (expires in ${expiresInSeconds}s)`); }
}

export class NodemailerMailer implements Mailer {
  private readonly transport;
  private readonly from:string;

  constructor(private readonly options: SmtpOptions) {
    this.from=options.from;
    this.logger=options.logger;
    const transport: SMTPTransport.Options = {
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
      dnsTimeout: options.dnsTimeoutMs,
      connectionTimeout: options.connectionTimeoutMs,
      greetingTimeout: options.greetingTimeoutMs,
      socketTimeout: options.socketTimeoutMs,
    };
    if (options.addressFamily === 'ipv4') transport.getSocket = (_transportOptions, callback) => ipv4Socket(options, callback);
    this.transport=nodemailer.createTransport(transport);
    this.logger?.info({event:'mail.smtp_configured',host:options.host,port:options.port,secure:options.secure,hasAuth:Boolean(options.user),from:maskEmail(options.from.match(/<([^>]+)>/)?.[1] ?? options.from),addressFamily:options.addressFamily,dnsTimeoutMs:options.dnsTimeoutMs,connectionTimeoutMs:options.connectionTimeoutMs,greetingTimeoutMs:options.greetingTimeoutMs,socketTimeoutMs:options.socketTimeoutMs},'SMTP mailer configured');
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
      const err=error instanceof Error ? error as NodeJS.ErrnoException : undefined;
      this.logger?.error({err:error,event:'mail.otp_failed',recipient,durationMs:Date.now()-started,errorCode:err?.code},'SMTP failed to send OTP email');
      throw error;
    }
  }
}
