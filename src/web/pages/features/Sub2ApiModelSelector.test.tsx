import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Sub2ApiModelSelector, { SUB2API_OPENAI_MODEL_OPTIONS } from './Sub2ApiModelSelector.js';

vi.mock('../../i18n.js', () => ({
  tr: (value: string) => value,
}));

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

function Harness({ initial = [] }: { initial?: string[] }) {
  const [models, setModels] = useState(initial);
  return <Sub2ApiModelSelector value={models} onChange={setModels} />;
}

async function renderSelector(initial: string[] = []): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness initial={initial} />);
  });
  return root;
}

function findTrigger(root: ReactTestRenderer) {
  return root.root.find((node) => (
    node.type === 'button' && node.props['aria-label'] === '选择模型'
  ));
}

describe('Sub2ApiModelSelector', () => {
  it('tracks the current Sub2API OpenAI model catalog', () => {
    expect(SUB2API_OPENAI_MODEL_OPTIONS).toEqual([
      'gpt-5.2',
      'gpt-5.2-2025-12-11',
      'gpt-5.2-chat-latest',
      'gpt-5.2-pro',
      'gpt-5.2-pro-2025-12-11',
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-6',
      'gpt-6-astra',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-2026-03-05',
      'gpt-5.3-codex-spark',
      'codex-auto-review',
      'gpt-4o-audio-preview',
      'gpt-4o-realtime-preview',
      'gpt-image-1',
      'gpt-image-1.5',
      'gpt-image-2',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ]);
  });

  it('filters the curated options and toggles a model without closing', async () => {
    const root = await renderSelector();
    try {
      expect(collectText(findTrigger(root))).toContain('0 个模型');

      await act(async () => {
        findTrigger(root).props.onClick();
      });

      const searchInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '搜索模型'
      ));
      await act(async () => {
        searchInput.props.onChange({ target: { value: 'gpt-6' } });
      });

      const visibleOptions = root.root.findAll((node) => (
        node.type === 'input'
        && node.props.type === 'checkbox'
        && typeof node.props['aria-label'] === 'string'
        && node.props['aria-label'].startsWith('选择模型 ')
      ));
      expect(visibleOptions.map((option) => option.props['aria-label'])).toEqual([
        '选择模型 gpt-6',
        '选择模型 gpt-6-astra',
      ]);

      await act(async () => {
        visibleOptions[1].props.onChange();
      });

      expect(collectText(findTrigger(root))).toContain('1 个模型');
      expect(findTrigger(root).props['aria-expanded']).toBe(true);
      expect(root.root.findAll((node) => (
        node.type === 'button' && node.props['aria-label'] === '移除模型 gpt-6-astra'
      ))).toHaveLength(1);

      const selectedOption = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '选择模型 gpt-6-astra'
      ));
      expect(selectedOption.props.checked).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it('adds trimmed custom models once', async () => {
    const root = await renderSelector();
    try {
      await act(async () => {
        findTrigger(root).props.onClick();
      });

      const customInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '添加模型'
      ));
      await act(async () => {
        customInput.props.onChange({ target: { value: ' custom-model, custom-model ' } });
      });
      const updatedCustomInput = root.root.find((node) => (
        node.type === 'input' && node.props['aria-label'] === '添加模型'
      ));
      await act(async () => {
        updatedCustomInput.props.onKeyDown({
          key: 'Enter',
          nativeEvent: { isComposing: false },
          preventDefault: vi.fn(),
        });
      });

      expect(collectText(findTrigger(root))).toContain('1 个模型');
      expect(root.root.findAll((node) => (
        node.type === 'button' && node.props['aria-label'] === '移除模型 custom-model'
      ))).toHaveLength(1);
    } finally {
      root.unmount();
    }
  });
});
