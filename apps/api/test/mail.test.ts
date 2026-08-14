import { describe, expect, it } from 'vitest';
import { ResendMailer } from '../src/infrastructure/mail.js';

describe('ResendMailer', () => {
  it('preserves the Workers global fetch receiver', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (this: typeof globalThis) {
      if (this !== globalThis) throw new Error('Illegal invocation');
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'email_receiver' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    } as typeof globalThis.fetch;
    try {
      const value = new ResendMailer({
        apiKey: 're_test',
        apiUrl: 'https://api.resend.com',
        timeoutMs: 500,
        from: 'Big Upload <login@example.com>',
      });
      await expect(value.sendOtp('person@example.com', '123456', 600)).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends the OTP through the Resend HTTPS API', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'email_123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const value = new ResendMailer({
      apiKey: 're_test',
      apiUrl: 'https://api.resend.com/',
      timeoutMs: 500,
      from: 'Big Upload <login@example.com>',
      fetch: fetchMock,
    });
    await value.sendOtp('person@example.com', '123456', 600);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.resend.com/emails');
    expect(requests[0]?.init?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer re_test' }),
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(
      expect.objectContaining({
        from: 'Big Upload <login@example.com>',
        to: ['person@example.com'],
      }),
    );
  });

  it('surfaces a Resend API rejection without exposing the token', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ message: 'The from address is not verified' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    const value = new ResendMailer({
      apiKey: 're_secret',
      apiUrl: 'https://api.resend.com',
      timeoutMs: 500,
      from: 'Big Upload <login@example.com>',
      fetch: fetchMock,
    });
    await expect(value.sendOtp('person@example.com', '123456', 600)).rejects.toMatchObject({
      message: 'The from address is not verified',
      code: 'RESEND_403',
    });
  });
});
