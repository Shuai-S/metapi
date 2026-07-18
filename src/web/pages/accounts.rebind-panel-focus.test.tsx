import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    rebindAccountPassword: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Accounts rebind modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens centered rebind modal when clicking rebind action', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'tester',
        balance: 100,
        balanceUsed: 0,
        todayReward: 0,
        todaySpend: 0,
        accessToken: 'session-token',
        status: 'expired',
        checkinEnabled: true,
        siteId: 10,
        site: { id: 10, name: 'Demo Site', status: 'active', url: 'https://example.com' },
        runtimeHealth: { state: 'unhealthy', reason: '访问令牌失效' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([{ id: 10, name: 'Demo Site', platform: 'new-api', status: 'active' }]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rebindButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '重新绑定'
      ));

      await act(async () => {
        rebindButton.props.onClick();
      });
      await flushMicrotasks();

      const modal = root.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('modal-content')
      ));
      expect(String(modal.props.className)).toContain('modal-content');
      expect(JSON.stringify(root.toJSON())).toContain('重新绑定 Session Token');
      expect(JSON.stringify(root.toJSON())).toContain('粘贴新的 Session Token');
    } finally {
      root?.unmount();
    }
  });

  it('defaults password connections to password reauthorization', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 2,
        username: 'password-user',
        balance: 93.25,
        balanceUsed: 0,
        todayReward: 0,
        todaySpend: 0,
        accessToken: 'expired-session-token',
        status: 'expired',
        checkinEnabled: true,
        siteId: 20,
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          autoRelogin: {
            username: 'password-user',
            passwordCipher: 'encrypted-password',
          },
        }),
        site: { id: 20, name: 'Password Site', platform: 'new-api', status: 'active', url: 'https://password.example.com' },
        runtimeHealth: { state: 'unhealthy', reason: '访问令牌已过期' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 20, name: 'Password Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.rebindAccountPassword.mockResolvedValue({ success: true });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rebindButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '重新绑定'
      ));
      await act(async () => {
        rebindButton.props.onClick();
      });

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('使用账号密码重新授权');
      expect(rendered).toContain('账号密码（留空则使用已保存密码）');

      const passwordInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '账号密码（留空则使用已保存密码）'
      ));
      await act(async () => {
        passwordInput.props.onChange({ target: { value: 'current-password' } });
      });

      const submitButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '使用账号密码重新授权'
      ));
      await act(async () => {
        await submitButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.rebindAccountPassword).toHaveBeenCalledWith(2, {
        username: 'password-user',
        password: 'current-password',
      });
    } finally {
      root?.unmount();
    }
  });
});
