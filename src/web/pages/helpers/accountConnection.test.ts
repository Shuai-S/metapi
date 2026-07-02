import { describe, expect, it } from 'vitest';
import {
  isTruthyFlag,
  parsePositiveInt,
  resolveAccountConnectionDisplay,
  resolveAccountCredentialMode,
} from './accountConnection.js';

describe('accountConnection helpers', () => {
  it('resolves account credential mode from explicit mode, capabilities, and token presence', () => {
    expect(resolveAccountCredentialMode({ credentialMode: 'apikey' })).toBe('apikey');
    expect(resolveAccountCredentialMode({ capabilities: { proxyOnly: true } })).toBe('apikey');
    expect(resolveAccountCredentialMode({ accessToken: ' session-token ' })).toBe('session');
    expect(resolveAccountCredentialMode({
      credentialMode: 'session',
      capabilities: { proxyOnly: true },
      accessToken: 'api-token-ignored-by-explicit-mode',
    })).toBe('session');
    expect(resolveAccountCredentialMode({})).toBe('apikey');
  });

  it('resolves connection display type separately from routing mode', () => {
    expect(resolveAccountConnectionDisplay({ credentialMode: 'apikey' })).toMatchObject({
      type: 'apikey',
      label: 'API Token',
      badgeClass: 'badge-warning',
    });
    expect(resolveAccountConnectionDisplay({ credentialMode: 'session' })).toMatchObject({
      type: 'session',
      label: 'Session Token',
      badgeClass: 'badge-info',
    });
    expect(resolveAccountConnectionDisplay({
      credentialMode: 'session',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: { username: 'demo', passwordCipher: 'cipher' },
      }),
    })).toMatchObject({
      type: 'password',
      label: 'Password',
      badgeClass: 'badge-success',
    });
  });

  it('parses positive integers from query values', () => {
    expect(parsePositiveInt('42')).toBe(42);
    expect(parsePositiveInt(' 0 ')).toBe(0);
    expect(parsePositiveInt('abc')).toBe(0);
    expect(parsePositiveInt('42abc')).toBe(0);
    expect(parsePositiveInt('1e3')).toBe(0);
    expect(parsePositiveInt('1.5')).toBe(0);
    expect(parsePositiveInt(null)).toBe(0);
  });

  it('treats common truthy query flags as enabled', () => {
    expect(isTruthyFlag('1')).toBe(true);
    expect(isTruthyFlag(' TRUE ')).toBe(true);
    expect(isTruthyFlag('yes')).toBe(true);
    expect(isTruthyFlag('no')).toBe(false);
    expect(isTruthyFlag(null)).toBe(false);
  });
});
