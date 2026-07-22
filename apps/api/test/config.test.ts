import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const names=['SMTP_ADDRESS_FAMILY','SMTP_DNS_TIMEOUT_MS','SMTP_CONNECTION_TIMEOUT_MS','SMTP_GREETING_TIMEOUT_MS','SMTP_SOCKET_TIMEOUT_MS','SMTP_PORT'] as const;
const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
afterEach(()=>{for(const name of names){const value=original[name];if(value===undefined)delete process.env[name];else process.env[name]=value}});

describe('SMTP configuration',()=>{
  it('uses bounded dual-stack defaults',()=>{
    for(const name of names)delete process.env[name];
    const config=loadConfig();
    expect(config.smtpAddressFamily).toBe('auto');
    expect(config.smtpDnsTimeoutMs).toBe(3000);
    expect(config.smtpConnectionTimeoutMs).toBe(8000);
    expect(config.smtpGreetingTimeoutMs).toBe(8000);
    expect(config.smtpSocketTimeoutMs).toBe(15000);
  });

  it('accepts an IPv4-only SMTP deployment policy',()=>{
    process.env.SMTP_ADDRESS_FAMILY='ipv4';
    process.env.SMTP_CONNECTION_TIMEOUT_MS='1234';
    const config=loadConfig();
    expect(config.smtpAddressFamily).toBe('ipv4');
    expect(config.smtpConnectionTimeoutMs).toBe(1234);
  });

  it('rejects unsupported address families and non-positive timeouts',()=>{
    process.env.SMTP_ADDRESS_FAMILY='ipv6';
    expect(()=>loadConfig()).toThrow('SMTP_ADDRESS_FAMILY must be one of auto, ipv4');
    process.env.SMTP_ADDRESS_FAMILY='auto';
    process.env.SMTP_DNS_TIMEOUT_MS='0';
    expect(()=>loadConfig()).toThrow('SMTP_DNS_TIMEOUT_MS must be a positive integer no greater than 2147483647');
    process.env.SMTP_DNS_TIMEOUT_MS='3000';
    process.env.SMTP_PORT='65536';
    expect(()=>loadConfig()).toThrow('SMTP_PORT must be between 1 and 65535');
    process.env.SMTP_PORT='587';
    process.env.SMTP_SOCKET_TIMEOUT_MS='2147483648';
    expect(()=>loadConfig()).toThrow('SMTP_SOCKET_TIMEOUT_MS must be a positive integer no greater than 2147483647');
  });
});
