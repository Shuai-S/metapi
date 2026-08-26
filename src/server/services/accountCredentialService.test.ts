import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  decryptAccountPassword,
  encryptSecret,
  encryptAccountPassword,
} from './accountCredentialService.js';

describe('accountCredentialService', () => {
  it('encrypts and decrypts password values', () => {
    const cipher = encryptAccountPassword('P@ssw0rd-123');
    expect(cipher).toBeTruthy();
    expect(cipher).not.toContain('P@ssw0rd-123');
    expect(decryptAccountPassword(cipher)).toBe('P@ssw0rd-123');
  });

  it('returns null for malformed cipher text', () => {
    expect(decryptAccountPassword('invalid-cipher')).toBeNull();
  });

  it('supports other server-side secrets without changing the password contract', () => {
    const cipher = encryptSecret('admin-api-key');
    expect(cipher).not.toContain('admin-api-key');
    expect(decryptSecret(cipher)).toBe('admin-api-key');
  });
});
