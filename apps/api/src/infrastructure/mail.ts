import type { Logger } from './telemetry.js';

export interface Mailer {
  sendOtp(email: string, code: string, expiresInSeconds: number): Promise<void>;
}

export type ResendOptions = {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
  from: string;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
};

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[invalid-email]';
  return `${local.slice(0, 2)}***@${domain}`;
}

export class ConsoleMailer implements Mailer {
  async sendOtp(email: string, code: string, expiresInSeconds: number): Promise<void> {
    console.info(
      JSON.stringify({
        event: 'mail.console_otp',
        recipient: maskEmail(email),
        code,
        expiresInSeconds,
      }),
    );
  }
}

export class ResendMailer implements Mailer {
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly options: ResendOptions) {
    // Workers runtime host functions must be called with their original receiver.
    // Keeping a bare `globalThis.fetch` reference and later invoking it as
    // `this.fetch(...)` changes `this` to the mailer instance and throws
    // "Illegal invocation".
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }
  async sendOtp(email: string, code: string, expiresInSeconds: number): Promise<void> {
    const recipient = maskEmail(email);
    const started = Date.now();
    this.options.logger?.info({
      event: 'mail.otp_sending',
      provider: 'resend',
      recipient,
      expiresInSeconds,
    });
    try {
      const response = await this.fetch(`${this.options.apiUrl.replace(/\/$/, '')}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [email],
          subject: 'Your Big Upload sign-in code',
          text: `Your sign-in code is ${code}. It expires in ${Math.ceil(expiresInSeconds / 60)} minutes.`,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const body = (await response.json().catch(() => null)) as {
        id?: string;
        message?: string;
      } | null;
      if (!response.ok) {
        const error = Object.assign(
          new Error(body?.message || `Resend API returned HTTP ${response.status}`),
          { code: `RESEND_${response.status}` },
        );
        throw error;
      }
      if (!body?.id) throw new Error('Resend API response did not include a message id');
      this.options.logger?.info({
        event: 'mail.otp_sent',
        provider: 'resend',
        recipient,
        messageId: body.id,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const errorCode = error instanceof Error && 'code' in error ? String(error.code) : undefined;
      this.options.logger?.error({
        event: 'mail.otp_failed',
        provider: 'resend',
        recipient,
        durationMs: Date.now() - started,
        errorCode,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
