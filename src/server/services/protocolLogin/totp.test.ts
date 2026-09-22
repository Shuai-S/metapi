import { describe, expect, it } from 'vitest';
import {
  generateTotp,
  getTotpRemainingSeconds,
  parseProtocolLoginCredential,
  parseTotpSecret,
  redactProtocolLoginCredential,
} from './totp.js';

describe('protocol login TOTP', () => {
  it('generates the RFC 6238 SHA-1 vector', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotp({ secret, digits: 8 }, 59_000)).toBe('94287082');
  });

  it('parses otpauth URIs and exposes the remaining window', () => {
    const parsed = parseTotpSecret('otpauth://totp/OpenAI%3Auser%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=OpenAI&period=30');
    expect(parsed).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'OpenAI', account: 'OpenAI:user@example.com' });
    expect(getTotpRemainingSeconds(parsed, 31_000)).toBe(29);
  });

  it('rejects a six digit code where a long term secret is required', () => {
    expect(() => parseProtocolLoginCredential('user@example.com---password---123456')).toThrow('长期 TOTP 密钥');
  });

  it('redacts credentials before a log entry is created', () => {
    const credential = parseProtocolLoginCredential('user@example.com---password---JBSWY3DPEHPK3PXP');
    expect(redactProtocolLoginCredential(credential)).toBe('user@example.com---[已隐藏]---[TOTP 已隐藏]');
  });
});
