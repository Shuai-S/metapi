import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY } from '../appLocalState.js';
import Features from './Features.js';

vi.mock('../i18n.js', () => ({
  tr: (value: string) => value,
}));

function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    dump: () => Object.fromEntries(store.entries()),
  };
}

describe('Features Sub2API account settings', () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      vi.stubGlobal('localStorage', originalLocalStorage);
    } else {
      vi.unstubAllGlobals();
    }
    vi.clearAllMocks();
  });

  it('restores, updates, and clears the last import group', async () => {
    const storage = createStorage({
      [SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY]: '  saved-pool  ',
    });
    vi.stubGlobal('localStorage', storage);

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<Features />);
      });

      const groupInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '导入分组'
      ));
      expect(groupInput.props.value).toBe('saved-pool');

      await act(async () => {
        groupInput.props.onChange({ target: { value: '  next-pool  ' } });
      });
      expect(storage.dump()).toMatchObject({
        [SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY]: 'next-pool',
      });

      await act(async () => {
        root.unmount();
        root = create(<Features />);
      });
      const restoredGroupInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '导入分组'
      ));
      expect(restoredGroupInput.props.value).toBe('next-pool');

      await act(async () => {
        restoredGroupInput.props.onChange({ target: { value: '   ' } });
      });
      expect(storage.dump()).not.toHaveProperty(
        SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY,
      );
    } finally {
      root?.unmount();
    }
  });

  it('applies the selected Codex fingerprint mode without persisting it', async () => {
    const storage = createStorage();
    vi.stubGlobal('localStorage', storage);

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<Features />);
      });

      const fingerprintSelect = root.root.find((node) => (
        node.type === 'select' && node.props['aria-label'] === 'Codex 指纹收敛'
      ));
      expect(fingerprintSelect.props.value).toBe('session');
      expect(fingerprintSelect.findAllByType('option').map((option) => ({
        value: option.props.value,
        label: option.children.join(''),
      }))).toEqual([
        { value: 'off', label: '关闭（透传，默认）' },
        { value: 'device', label: '仅设备' },
        { value: 'session', label: '设备+会话' },
        { value: 'full', label: '完全收敛' },
      ]);

      const fillExampleButton = root.root.find((node) => (
        node.type === 'button' && node.props.children === '填入示例'
      ));
      await act(async () => {
        fillExampleButton.props.onClick();
      });

      const outputAccount = () => {
        const output = root.root.find((node) => (
          node.type === 'textarea' && node.props['aria-label'] === '转换输出'
        ));
        return JSON.parse(output.props.value).accounts[0];
      };
      expect(outputAccount().extra.codex_fingerprint_mode).toBe('session');

      storage.setItem.mockClear();
      storage.removeItem.mockClear();
      await act(async () => {
        fingerprintSelect.props.onChange({ target: { value: 'off' } });
      });
      expect(outputAccount().extra).not.toHaveProperty('codex_fingerprint_mode');

      await act(async () => {
        fingerprintSelect.props.onChange({ target: { value: 'full' } });
      });
      expect(outputAccount().extra.codex_fingerprint_mode).toBe('full');
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
        root = create(<Features />);
      });
      const remountedSelect = root.root.find((node) => (
        node.type === 'select' && node.props['aria-label'] === 'Codex 指纹收敛'
      ));
      expect(remountedSelect.props.value).toBe('session');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the converter usable when browser storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('storage blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('storage blocked');
      }),
      removeItem: vi.fn(() => {
        throw new Error('storage blocked');
      }),
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<Features />);
      });
      const groupInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '导入分组'
      ));
      expect(groupInput.props.value).toBe('');
    } finally {
      root?.unmount();
    }
  });
});
