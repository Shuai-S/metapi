import { beforeEach, describe, expect, it, vi } from 'vitest';

const autoReloginMock = vi.fn();
const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();
const setRuntimeHealthMock = vi.fn();
const sendNotificationMock = vi.fn();

vi.mock('../db/index.js', () => {
  const insertChain = {
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
    run: () => ({}),
  };
  const updateChain = {
    set: (value: unknown) => {
      updateSetMock(value);
      return updateChain;
    },
    where: () => updateChain,
    run: () => ({}),
  };
  return {
    db: {
      insert: () => insertChain,
      update: () => updateChain,
    },
    schema: {
      accounts: { id: 'id' },
      events: {},
    },
  };
});

vi.mock('./accountSessionReloginService.js', () => ({
  autoReloginAccountWithStoredPasswordSingleflight: (...args: unknown[]) => autoReloginMock(...args),
}));

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setRuntimeHealthMock(...args),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

vi.mock('./localTimeService.js', () => ({
  formatUtcSqlDateTime: () => '2026-07-18 22:00:00',
}));

describe('reportTokenExpired password recovery', () => {
  beforeEach(() => {
    autoReloginMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
    setRuntimeHealthMock.mockReset();
    sendNotificationMock.mockReset();
  });

  it('does not expire or notify an account when password relogin succeeds', async () => {
    autoReloginMock.mockResolvedValue({
      success: true,
      accountId: 12,
      username: 'password-user',
      accessToken: 'fresh-token',
      preferredApiToken: null,
      apiTokens: [],
      extraConfig: null,
      account: { id: 12, status: 'active' },
    });

    const { reportTokenExpired } = await import('./alertService.js');
    const result = await reportTokenExpired({
      accountId: 12,
      username: 'password-user',
      siteName: 'Password Site',
      detail: 'HTTP 401',
    });

    expect(result).toMatchObject({ recovered: true });
    expect(autoReloginMock).toHaveBeenCalledWith(12);
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('marks the account expired when no stored password is available', async () => {
    autoReloginMock.mockResolvedValue({
      success: false,
      accountId: 13,
      reason: 'credentials_unavailable',
      message: 'no stored password',
    });

    const { reportTokenExpired } = await import('./alertService.js');
    const result = await reportTokenExpired({
      accountId: 13,
      username: 'session-user',
      siteName: 'Session Site',
      detail: 'HTTP 401',
    });

    expect(result).toEqual({ recovered: false });
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
