import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  testConnection: vi.fn(),
  getGroups: vi.fn(),
  pushAccounts: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: {
    getSub2ApiPoolConfig: (...args: unknown[]) => apiMocks.getConfig(...args),
    updateSub2ApiPoolConfig: (...args: unknown[]) => apiMocks.updateConfig(...args),
    testSub2ApiPoolConnection: (...args: unknown[]) => apiMocks.testConnection(...args),
    getSub2ApiPoolGroups: (...args: unknown[]) => apiMocks.getGroups(...args),
    pushSub2ApiPoolAccounts: (...args: unknown[]) => apiMocks.pushAccounts(...args),
  },
}));

vi.mock('../i18n.js', () => ({
  tr: (value: string) => value,
}));

import Sub2ApiPoolPanel from './features/Sub2ApiPoolPanel.js';

const configured = {
  baseUrl: 'https://pool.example.com',
  adminApiKeyConfigured: true,
  adminApiKeyMasked: 'admi****3456',
  groupIds: [7],
  maxParallel: 3,
};

describe('Sub2ApiPoolPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads remote groups and manually pushes converted accounts', async () => {
    apiMocks.getConfig.mockResolvedValue(configured);
    apiMocks.updateConfig.mockResolvedValue(configured);
    apiMocks.getGroups.mockResolvedValue({
      groups: [{ id: 7, name: 'Codex 主池', platform: 'openai' }],
    });
    apiMocks.pushAccounts.mockResolvedValue({
      total: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      items: [{
        index: 0,
        name: 'user@example.com',
        status: 'created',
        accountId: 19,
        message: '已推送到远端号池',
      }],
    });
    const accounts = [{
      name: 'user@example.com',
      credentials: { access_token: 'access-token' },
    }];

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<Sub2ApiPoolPanel accounts={accounts} />);
      });

      const groupCheckbox = root.root.find((node) => (
        node.type === 'input' && node.props.type === 'checkbox'
      ));
      expect(groupCheckbox.props.checked).toBe(true);

      const keyInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === 'Sub2API 管理员 API Key'
      ));
      expect(keyInput.props.value).toBe('');
      expect(keyInput.props.placeholder).toBe('admi****3456');

      const pushButton = root.root.find((node) => (
        node.type === 'button' && node.props.children === '推送账号 (1)'
      ));
      await act(async () => {
        await pushButton.props.onClick();
      });

      expect(apiMocks.updateConfig).toHaveBeenCalledWith({
        baseUrl: 'https://pool.example.com',
        groupIds: [7],
        maxParallel: 3,
      });
      expect(apiMocks.pushAccounts).toHaveBeenCalledWith(accounts);
      expect(root.root.findAll((node) => (
        node.props.className === 'sub2api-push-result is-created'
      ))).toHaveLength(1);
    } finally {
      root?.unmount();
    }
  });

  it('saves a newly entered key without rendering it after save', async () => {
    apiMocks.getConfig.mockResolvedValue({
      ...configured,
      adminApiKeyConfigured: false,
      adminApiKeyMasked: '',
      groupIds: [],
    });
    apiMocks.updateConfig.mockResolvedValue(configured);

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<Sub2ApiPoolPanel accounts={[]} />);
      });
      const keyInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === 'Sub2API 管理员 API Key'
      ));
      await act(async () => {
        keyInput.props.onChange({ target: { value: 'new-admin-secret' } });
      });
      const saveButton = root.root.find((node) => (
        node.type === 'button' && node.props.children === '保存配置'
      ));
      await act(async () => {
        await saveButton.props.onClick();
      });

      expect(apiMocks.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        adminApiKey: 'new-admin-secret',
      }));
      const savedKeyInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === 'Sub2API 管理员 API Key'
      ));
      expect(savedKeyInput.props.value).toBe('');
      expect(savedKeyInput.props.placeholder).toBe('admi****3456');
    } finally {
      root?.unmount();
    }
  });
});
