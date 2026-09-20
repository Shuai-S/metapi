import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { BrandGlyph } from '../../components/BrandIcon.js';
import { tr } from '../../i18n.js';

// Source: Wei-Shaw/sub2api frontend/src/composables/useModelWhitelist.ts (openaiModels),
// synchronized 2026-09-20. This catalog is separate from the empty default selection.
export const SUB2API_OPENAI_MODEL_OPTIONS = [
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
] as const;

type Props = {
  value: string[];
  onChange: (models: string[]) => void;
};

export default function Sub2ApiModelSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const copyResetRef = useRef<number | null>(null);
  const panelId = useId();

  const filteredModels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return SUB2API_OPENAI_MODEL_OPTIONS;
    return SUB2API_OPENAI_MODEL_OPTIONS.filter((model) => model.toLowerCase().includes(query));
  }, [searchQuery]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open && searchQuery) setSearchQuery('');
  }, [open, searchQuery]);

  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
  }, []);

  const toggleModel = (model: string) => {
    onChange(value.includes(model)
      ? value.filter((item) => item !== model)
      : [...value, model]);
  };

  const commitCustomModel = () => {
    const additions = customModel
      .split(/[,\n，]/u)
      .map((model) => model.trim())
      .filter(Boolean);
    if (additions.length > 0) {
      onChange(Array.from(new Set([...value, ...additions])));
    }
    setCustomModel('');
  };

  const handleCustomModelKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault();
    commitCustomModel();
  };

  const copyModel = async (model: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(model);
      setCopiedModel(model);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopiedModel(null), 1400);
    } catch {
      // Selecting models remains available when clipboard access is blocked.
    }
  };

  return (
    <div ref={rootRef} className={`session-model-selector${open ? ' is-open' : ''}`}>
      <div className="session-model-selector-control">
        {value.length > 0 && (
          <div className="session-model-selector-selected" aria-label={tr('已选模型')}>
            {value.map((model) => (
              <span key={model} className="session-model-chip">
                <BrandGlyph model={model} size={13} />
                <span className="session-model-chip-label" title={model}>{model}</span>
                <button
                  type="button"
                  aria-label={`${tr('移除模型')} ${model}`}
                  title={`${tr('移除模型')} ${model}`}
                  onClick={() => toggleModel(model)}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          className="session-model-selector-trigger"
          aria-label={tr('选择模型')}
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          onClick={() => setOpen((current) => !current)}
        >
          <span>{value.length} {tr('个模型')}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {open && (
        <div id={panelId} className="session-model-selector-panel">
          <div className="session-model-selector-search">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              autoFocus
              type="text"
              value={searchQuery}
              aria-label={tr('搜索模型')}
              placeholder={tr('搜索模型...')}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>

          <div className="session-model-selector-options" aria-label={tr('可选模型')}>
            {filteredModels.length === 0 ? (
              <div className="session-model-selector-empty">{tr('没有匹配的模型')}</div>
            ) : filteredModels.map((model) => {
              const selected = value.includes(model);
              return (
                <div key={model} className={`session-model-selector-option${selected ? ' is-selected' : ''}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`${tr('选择模型')} ${model}`}
                      onChange={() => toggleModel(model)}
                    />
                    <BrandGlyph model={model} size={17} />
                    <span className="session-model-selector-option-name" title={model}>{model}</span>
                  </label>
                  <button
                    type="button"
                    className="session-model-selector-copy"
                    aria-label={`${tr(copiedModel === model ? '已复制' : '复制模型')} ${model}`}
                    title={tr(copiedModel === model ? '已复制' : '复制模型')}
                    onClick={() => void copyModel(model)}
                  >
                    {copiedModel === model ? (
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 8h10v11H8zM6 16H4V5h10v2" />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="session-model-selector-custom">
            <input
              type="text"
              value={customModel}
              aria-label={tr('添加模型')}
              placeholder={tr('输入模型后按回车')}
              onChange={(event) => setCustomModel(event.target.value)}
              onBlur={commitCustomModel}
              onKeyDown={handleCustomModelKeyDown}
            />
            <button
              type="button"
              aria-label={tr('添加模型')}
              title={tr('添加模型')}
              disabled={!customModel.trim()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={commitCustomModel}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
