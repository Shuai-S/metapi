import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export type TotpConfig = {
  secret: string;
  algorithm?: TotpAlgorithm;
  digits?: 6 | 8;
  period?: number;
};

export type ParsedTotpSecret = {
  secret: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: number;
  issuer?: string;
  account?: string;
};

export type ProtocolLoginCredential = {
  username: string;
  password: string;
  totp: ParsedTotpSecret;
};

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const MAX_PERIOD_SECONDS = 300;

function normalizeBase32(value: string): string {
  return value.trim().replace(/^\s+|\s+$/g, '').replace(/[\s-]/g, '').toUpperCase().replace(/=+$/g, '');
}

function decodeBase32(value: string): Buffer {
  const normalized = normalizeBase32(value);
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error('TOTP 密钥必须是 Base32 字符串');
  }
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if (bytes.length < 10) throw new Error('TOTP 密钥长度不足');
  return Buffer.from(bytes);
}

function normalizeAlgorithm(value: unknown): TotpAlgorithm {
  const algorithm = String(value || 'SHA1').trim().toUpperCase();
  if (algorithm === 'SHA1' || algorithm === 'SHA256' || algorithm === 'SHA512') return algorithm;
  throw new Error('TOTP algorithm 只支持 SHA1、SHA256 或 SHA512');
}

function normalizeDigits(value: unknown): 6 | 8 {
  const digits = Number(value ?? DEFAULT_DIGITS);
  if (digits === 6 || digits === 8) return digits;
  throw new Error('TOTP digits 只支持 6 或 8');
}

function normalizePeriod(value: unknown): number {
  const period = Number(value ?? DEFAULT_PERIOD_SECONDS);
  if (!Number.isInteger(period) || period < 1 || period > MAX_PERIOD_SECONDS) {
    throw new Error(`TOTP period 必须是 1-${MAX_PERIOD_SECONDS} 秒的整数`);
  }
  return period;
}

export function parseTotpSecret(input: string | TotpConfig): ParsedTotpSecret {
  const source = typeof input === 'string' ? { secret: input } : input;
  if (!source || typeof source.secret !== 'string') throw new Error('缺少 TOTP 密钥');

  let secret = source.secret.trim();
  let issuer: string | undefined;
  let account: string | undefined;
  let algorithm: unknown = source.algorithm;
  let digits: unknown = source.digits;
  let period: unknown = source.period;

  if (secret.toLowerCase().startsWith('otpauth://')) {
    let url: URL;
    try {
      url = new URL(secret);
    } catch {
      throw new Error('otpauth URI 格式无效');
    }
    if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') {
      throw new Error('仅支持 otpauth://totp/... URI');
    }
    secret = url.searchParams.get('secret') || '';
    issuer = url.searchParams.get('issuer') || undefined;
    account = decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined;
    algorithm = url.searchParams.get('algorithm') || algorithm;
    digits = url.searchParams.get('digits') || digits;
    period = url.searchParams.get('period') || period;
  }

  const normalizedSecret = normalizeBase32(secret);
  decodeBase32(normalizedSecret);
  return {
    secret: normalizedSecret,
    algorithm: normalizeAlgorithm(algorithm),
    digits: normalizeDigits(digits),
    period: normalizePeriod(period),
    issuer,
    account,
  };
}

export function generateTotp(config: string | TotpConfig | ParsedTotpSecret, nowMs = Date.now()): string {
  const parsed = parseTotpSecret(config);
  if (!Number.isFinite(nowMs)) throw new Error('TOTP 时间戳无效');
  const counter = Math.floor(nowMs / 1000 / parsed.period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(parsed.algorithm.toLowerCase(), decodeBase32(parsed.secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** parsed.digits)).padStart(parsed.digits, '0');
}

export function getTotpRemainingSeconds(config: string | TotpConfig | ParsedTotpSecret, nowMs = Date.now()): number {
  const parsed = parseTotpSecret(config);
  const elapsed = Math.floor(nowMs / 1000);
  return parsed.period - (elapsed % parsed.period);
}

export function parseProtocolLoginCredential(line: string): ProtocolLoginCredential {
  const parts = String(line || '').split('---').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error('账号输入必须是：账号---密码---2FA 长期密钥');
  }
  if (/^\d{6,8}$/.test(parts[2])) {
    throw new Error('第三段必须是长期 TOTP 密钥，不能是已过期的六位验证码');
  }
  return { username: parts[0], password: parts[1], totp: parseTotpSecret(parts[2]) };
}

export function redactProtocolLoginCredential(credential: ProtocolLoginCredential): string {
  return `${credential.username}---[已隐藏]---[TOTP 已隐藏]`;
}
