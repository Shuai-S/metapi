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
