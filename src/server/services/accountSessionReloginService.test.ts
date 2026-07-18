import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  login: vi.fn(),
  getApiToken: vi.fn(),
  getApiTokens: vi.fn(),
};
const selectGetMock = vi.fn();
const updateSetMock = vi.fn();
const decryptPasswordMock = vi.fn();
const encryptPasswordMock = vi.fn();
const syncTokensMock = vi.fn();
const ensureDefaultTokenMock = vi.fn();
const setRuntimeHealthMock = vi.fn();
const invalidateTokenRouterCacheMock = vi.fn();

vi.mock('../db/index.js', () => {
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    get: () => selectGetMock(),
  };
  const updateChain = {
    set: (updates: Record<string, unknown>) => {
      updateSetMock(updates);
      return updateChain;
    },
    where: () => updateChain,
    run: () => ({}),
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId' },
      sites: { id: 'id' },
    },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
  encryptAccountPassword: (...args: unknown[]) => encryptPasswordMock(...args),
}));

vi.mock('./accountTokenService.js', () => ({
  syncTokensFromUpstream: (...args: unknown[]) => syncTokensMock(...args),
  ensureDefaultTokenForAccount: (...args: unknown[]) => ensureDefaultTokenMock(...args),
}));

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setRuntimeHealthMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  withAccountProxyOverride: (_proxyUrl: unknown, fn: () => unknown) => fn(),
}));

vi.mock('./tokenRouter.js', () => ({
  invalidateTokenRouterCache: () => invalidateTokenRouterCacheMock(),
}));

describe('account session password relogin service', () => {
  beforeEach(async () => {
    adapterMock.login.mockReset();
    adapterMock.getApiToken.mockReset();
    adapterMock.getApiTokens.mockReset();
    selectGetMock.mockReset();
    updateSetMock.mockReset();
    decryptPasswordMock.mockReset();
    encryptPasswordMock.mockReset();
    syncTokensMock.mockReset();
    ensureDefaultTokenMock.mockReset();
    setRuntimeHealthMock.mockReset();
    invalidateTokenRouterCacheMock.mockReset();
    const service = await import('./accountSessionReloginService.js');
    service.__resetAccountPasswordReloginSingleflightForTests();
  });

  it('replaces an expired session and managed refresh token from the stored password', async () => {
    const account = {
      id: 7,
      siteId: 3,
      username: 'user@example.com',
      accessToken: 'expired-access-token',
      apiToken: 'sk-old-token',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: {
          username: 'user@example.com',
          passwordCipher: 'stored-cipher',
        },
        sub2apiAuth: { refreshToken: 'invalid-refresh-token' },
      }),
    };
    const site = {
      id: 3,
      name: 'Sub2 Password Site',
      url: 'https://sub2-password.example.com',
      platform: 'sub2api',
      status: 'active',
    };
    selectGetMock
      .mockReturnValueOnce({ accounts: account, sites: site })
      .mockImplementation(() => account);
    updateSetMock.mockImplementation((updates) => Object.assign(account, updates));
    decryptPasswordMock.mockReturnValue('current-password');
    adapterMock.login.mockResolvedValue({
      success: true,
      accessToken: 'fresh-access-token',
      username: 'user@example.com',
      refreshToken: 'fresh-refresh-token',
      tokenExpiresAt: 2_000_000_000,
    });
    adapterMock.getApiToken.mockResolvedValue('sk-fresh-token');
    adapterMock.getApiTokens.mockResolvedValue([
      { name: 'default', key: 'sk-fresh-token', enabled: true },
    ]);

    const service = await import('./accountSessionReloginService.js');
    const [first, second] = await Promise.all([
      service.autoReloginAccountWithStoredPasswordSingleflight(7),
      service.autoReloginAccountWithStoredPasswordSingleflight(7),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);
    expect(adapterMock.login).toHaveBeenCalledWith(
      site.url,
      'user@example.com',
      'current-password',
    );
    const persisted = updateSetMock.mock.calls.find((call) => call[0]?.accessToken)?.[0];
    const extra = JSON.parse(String(persisted?.extraConfig || '{}'));
    expect(persisted).toMatchObject({
      accessToken: 'fresh-access-token',
      apiToken: 'sk-fresh-token',
      status: 'active',
    });
    expect(extra.sub2apiAuth).toEqual({
      refreshToken: 'fresh-refresh-token',
      tokenExpiresAt: 2_000_000_000,
    });
    expect(syncTokensMock).toHaveBeenCalledWith(7, [
      { name: 'default', key: 'sk-fresh-token', enabled: true },
    ]);
    expect(setRuntimeHealthMock).toHaveBeenCalledWith(7, expect.objectContaining({
      state: 'healthy',
      source: 'password-relogin',
    }));
    expect(invalidateTokenRouterCacheMock).toHaveBeenCalledTimes(1);
  });

  it('stores an explicitly entered password for future automatic relogin', async () => {
    const account = {
      id: 8,
      siteId: 4,
      username: 'old-user',
      accessToken: 'expired-token',
      apiToken: null,
      status: 'expired',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    };
    const site = {
      id: 4,
      name: 'Password Site',
      url: 'https://password.example.com',
      platform: 'new-api',
      status: 'active',
    };
    selectGetMock
      .mockReturnValueOnce({ accounts: account, sites: site })
      .mockImplementation(() => account);
    updateSetMock.mockImplementation((updates) => Object.assign(account, updates));
    encryptPasswordMock.mockReturnValue('new-password-cipher');
    adapterMock.login.mockResolvedValue({
      success: true,
      accessToken: 'fresh-session-token',
      username: 'new-user',
    });
    adapterMock.getApiToken.mockResolvedValue(null);
    adapterMock.getApiTokens.mockResolvedValue([]);

    const service = await import('./accountSessionReloginService.js');
    const result = await service.reauthorizeAccountWithPassword({
      accountId: 8,
      username: 'new-user',
      password: ' new-password ',
    });

    expect(result.success).toBe(true);
    expect(adapterMock.login).toHaveBeenCalledWith(
      site.url,
      'new-user',
      ' new-password ',
    );
    expect(encryptPasswordMock).toHaveBeenCalledWith(' new-password ');
    const persisted = updateSetMock.mock.calls.find((call) => call[0]?.accessToken)?.[0];
    const extra = JSON.parse(String(persisted?.extraConfig || '{}'));
    expect(extra.autoRelogin).toMatchObject({
      username: 'new-user',
      passwordCipher: 'new-password-cipher',
    });
  });

  it('reports that a password is required when no stored credential exists', async () => {
    selectGetMock.mockReturnValueOnce({
      accounts: {
        id: 9,
        siteId: 5,
        username: 'no-password-user',
        accessToken: 'expired-token',
        status: 'expired',
        extraConfig: null,
      },
      sites: {
        id: 5,
        name: 'No Password Site',
        url: 'https://no-password.example.com',
        platform: 'new-api',
      },
    });

    const service = await import('./accountSessionReloginService.js');
    const result = await service.autoReloginAccountWithStoredPasswordSingleflight(9);

    expect(result).toMatchObject({
      success: false,
      reason: 'credentials_unavailable',
    });
    expect(adapterMock.login).not.toHaveBeenCalled();
  });

  it('returns a recoverable failure when an unexpected relogin error occurs', async () => {
    selectGetMock.mockRejectedValue(new Error('database temporarily unavailable'));

    const service = await import('./accountSessionReloginService.js');
    const first = await service.autoReloginAccountWithStoredPasswordSingleflight(10);
    const second = await service.autoReloginAccountWithStoredPasswordSingleflight(10);

    expect(first).toMatchObject({
      success: false,
      accountId: 10,
      reason: 'login_failed',
      message: expect.stringContaining('database temporarily unavailable'),
    });
    expect(second).toMatchObject({ success: false, accountId: 10 });
    expect(selectGetMock).toHaveBeenCalledTimes(2);
  });
});
