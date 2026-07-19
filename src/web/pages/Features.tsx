import React, { useEffect, useMemo, useRef, useState } from 'react';
import { tr } from '../i18n.js';
import { SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY } from '../appLocalState.js';
import {
  convertChatGptSessionSources,
  SESSION_OUTPUT_FORMATS,
  SESSION_OUTPUT_LABELS,
  type SessionOutputFormat,
  type SessionSourceDocument,
} from './helpers/chatGptSessionConverter.js';
import { buildSessionDownload } from './helpers/sessionDownload.js';

const EXAMPLE_SESSION = JSON.stringify({
  user: { id: 'user-example', email: 'mark@example.com' },
  expires: '2026-08-06T14:29:36.155Z',
  account: { id: '00000000-0000-4000-9000-000000000000', planType: 'plus' },
  accessToken: 'paste-real-access-token-here',
  refreshToken: 'paste-real-refresh-token-here',
  idToken: 'paste-real-id-token-here',
}, null, 2);

const DEFAULT_SUB2API_MODELS = [
  'codex-auto-review',
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
];

function parseNonNegativeSetting(value: string, fallback: number, integer = false): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return integer ? Math.trunc(numeric) : numeric;
}

function readStoredImportGroup(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

function persistImportGroup(value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const normalized = value.trim();
    if (normalized) {
      localStorage.setItem(SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(SESSION_CONVERTER_SUB2API_IMPORT_GROUP_STORAGE_KEY);
    }
  } catch {
    // Local parsing and conversion remain available when browser storage is blocked.
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatDisplayDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default function Features() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const [format, setFormat] = useState<SessionOutputFormat>('sub2api');
  const [inputText, setInputText] = useState('');
  const [sources, setSources] = useState<SessionSourceDocument[]>([]);
  const [forceRefreshAfterImport, setForceRefreshAfterImport] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [readError, setReadError] = useState('');
  const [accountModels, setAccountModels] = useState([...DEFAULT_SUB2API_MODELS]);
  const [modelDraft, setModelDraft] = useState('');
  const [accountConcurrency, setAccountConcurrency] = useState('10');
  const [accountRateMultiplier, setAccountRateMultiplier] = useState('0');
  const [accountPriority, setAccountPriority] = useState('1');
  const [accountImportGroup, setAccountImportGroup] = useState(readStoredImportGroup);

  useEffect(() => {
    persistImportGroup(accountImportGroup);
  }, [accountImportGroup]);

  const hasInput = sources.some((source) => source.text.trim() !== '');
  const result = useMemo(() => {
    if (!hasInput) return null;
    return convertChatGptSessionSources(sources, {
      format,
      forceRefreshAfterImport,
      sub2apiAccountSettings: {
        models: accountModels,
        concurrency: parseNonNegativeSetting(accountConcurrency, 10, true),
        rateMultiplier: parseNonNegativeSetting(accountRateMultiplier, 0),
        priority: parseNonNegativeSetting(accountPriority, 1, true),
        importGroup: accountImportGroup,
      },
    });
  }, [
    accountConcurrency,
    accountImportGroup,
    accountModels,
    accountPriority,
    accountRateMultiplier,
    forceRefreshAfterImport,
    format,
    hasInput,
    sources,
  ]);

  const commitModelDraft = () => {
    const additions = modelDraft
      .split(/[,\n，]/u)
      .map((model) => model.trim())
      .filter(Boolean);
    if (additions.length) {
      setAccountModels((current) => Array.from(new Set([...current, ...additions])));
    }
    setModelDraft('');
  };

  const setPastedInput = (value: string) => {
    setInputText(value);
    setSources(value ? [{ text: value, sourceName: 'pasted-json' }] : []);
    setCopyState('idle');
    setReadError('');
  };

  const readFiles = async (files: File[]) => {
    if (!files.length) return;
    const acceptedFiles = files.filter((file) => /\.(json|txt)$/i.test(file.name));
    if (!acceptedFiles.length) {
      setReadError(tr('请选择 JSON 或 TXT 文件'));
      return;
    }
    try {
      const documents = await Promise.all(acceptedFiles.map(async (file) => ({
        text: await file.text(),
        sourceName: file.webkitRelativePath || file.name,
      })));
      setSources(documents);
      setInputText(documents.map((document) => document.text).join('\n\n'));
      setCopyState('idle');
      setReadError(files.length === acceptedFiles.length ? '' : tr('已忽略非 JSON/TXT 文件'));
    } catch (error) {
      setReadError(error instanceof Error ? error.message : tr('文件读取失败'));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearInput = () => {
    setInputText('');
    setSources([]);
    setCopyState('idle');
    setReadError('');
  };

  const copyOutput = async () => {
    if (!result?.outputText) return;
    try {
      await navigator.clipboard.writeText(result.outputText);
    } catch {
      outputRef.current?.select();
      document.execCommand('copy');
    }
    setCopyState('copied');
    window.setTimeout(() => setCopyState('idle'), 1600);
  };

  const downloadOutput = () => {
    if (!result?.outputText) return;
    const download = buildSessionDownload(result);
    triggerDownload(download.blob, download.fileName);
  };

  return (
    <div className="feature-page session-converter-page">
      <div className="page-header feature-page-header">
        <div>
          <h2 className="page-title">{tr('Session 转换器')}</h2>
          <p className="feature-page-subtitle">{tr('浏览器本地解析，Token 不上传、不写入存储；仅保存导入分组设置')}</p>
        </div>
      </div>

      <section className="feature-tool">
        <div className="feature-tool-heading">
          <div className="feature-tool-heading-copy">
            <div className="feature-tool-icon" aria-hidden="true">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 7h10M7 12h7m-7 5h10M5 3h10l4 4v12a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM15 3v5h5" /></svg>
            </div>
            <div>
              <h3>{tr('ChatGPT Session 格式转换')}</h3>
              <p>{tr('支持嵌套 JSON、逐行 JSON、卡密导出文本及多文件')}</p>
            </div>
          </div>

          <div className="session-account-settings" aria-label={tr('Sub2API 输出账号设置')}>
            <div className="session-account-settings-top">
              <strong>{tr('Sub2API 输出账号设置')}</strong>
              <label className="session-account-group-field">
                <span>{tr('导入分组')}</span>
                <input
                  type="text"
                  value={accountImportGroup}
                  aria-label={tr('导入分组')}
                  placeholder={tr('输入分组配置')}
                  onChange={(event) => setAccountImportGroup(event.target.value)}
                />
              </label>
              <label className="session-account-number-field">
                <span>{tr('并发')}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={accountConcurrency}
                  onChange={(event) => setAccountConcurrency(event.target.value)}
                />
              </label>
              <label className="session-account-number-field">
                <span>{tr('账号倍率')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={accountRateMultiplier}
                  onChange={(event) => setAccountRateMultiplier(event.target.value)}
                />
              </label>
              <label className="session-account-number-field">
                <span>{tr('优先级')}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={accountPriority}
                  onChange={(event) => setAccountPriority(event.target.value)}
                />
              </label>
            </div>

            <div className="session-model-setting-row">
              <span className="session-model-setting-label">{tr('模型')}</span>
              <div className="session-model-tags">
                {accountModels.map((model) => (
                  <span key={model} className="session-model-chip">
                    <span>{model}</span>
                    <button
                      type="button"
                      aria-label={`${tr('移除模型')} ${model}`}
                      title={`${tr('移除模型')} ${model}`}
                      onClick={() => setAccountModels((current) => current.filter((item) => item !== model))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={modelDraft}
                  aria-label={tr('添加模型')}
                  placeholder={tr('输入模型后按回车')}
                  onChange={(event) => setModelDraft(event.target.value)}
                  onBlur={commitModelDraft}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ',') return;
                    event.preventDefault();
                    commitModelDraft();
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="session-format-bar" aria-label={tr('输出格式')}>
          <span className="session-format-label">{tr('输出格式')}</span>
          <div className="session-format-tabs" role="tablist">
            {SESSION_OUTPUT_FORMATS.map((value) => (
              <button
                key={value}
                type="button"
                className={format === value ? 'active' : ''}
                role="tab"
                aria-selected={format === value}
                onClick={() => {
                  setFormat(value);
                  setCopyState('idle');
                }}
              >
                {SESSION_OUTPUT_LABELS[value]}
              </button>
            ))}
          </div>
          <label className="session-refresh-toggle">
            <input
              type="checkbox"
              checked={forceRefreshAfterImport}
              onChange={(event) => setForceRefreshAfterImport(event.target.checked)}
            />
            <span>{tr('导入后立即触发刷新 Token')}</span>
          </label>
        </div>

        <div className="session-converter-grid">
          <section className="session-pane" aria-labelledby="session-input-title">
            <div className="session-pane-header">
              <div>
                <h4 id="session-input-title">{tr('Session JSON')}</h4>
                <span>{sources.length > 1 ? `${sources.length} ${tr('个文件')}` : tr('输入数据')}</span>
              </div>
              <div className="session-pane-actions">
                <button type="button" className="btn btn-ghost session-action-btn" onClick={() => fileInputRef.current?.click()}>
                  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 16V4m0 0L7 9m5-5l5 5M5 20h14" /></svg>
                  {tr('选择文件')}
                </button>
                <button type="button" className="btn btn-ghost session-action-btn" onClick={() => setPastedInput(EXAMPLE_SESSION)}>
                  {tr('填入示例')}
                </button>
                <button type="button" className="btn btn-ghost session-icon-btn" aria-label={tr('清空')} title={tr('清空')} onClick={clearInput} disabled={!inputText}>
                  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 7h12m-9 0V5h6v2m-7 0l1 13h6l1-13M10 11v5m4-5v5" /></svg>
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              hidden
              multiple
              type="file"
              accept=".json,.txt,application/json,text/plain"
              onChange={(event) => void readFiles(Array.from(event.target.files || []))}
            />
            <div
              className={`session-input-shell${isDragging ? ' is-dragging' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                void readFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <textarea
                value={inputText}
                onChange={(event) => setPastedInput(event.target.value)}
                spellCheck={false}
                aria-label={tr('Session JSON 输入')}
                placeholder={'{\n  "user": { "email": "name@example.com" },\n  "accessToken": "..."\n}'}
              />
              {isDragging && <div className="session-drop-overlay">{tr('释放以读取文件')}</div>}
            </div>
            {readError && <div className="alert alert-error session-read-error">{readError}</div>}
            <div className={`session-status-line ${result?.outputAccounts ? 'is-ok' : ''}`}>
              <span aria-hidden="true" />
              {result
                ? `${tr('识别')} ${result.inputAccounts}, ${tr('转换')} ${result.outputAccounts}`
                : tr('等待输入')}
            </div>
          </section>

          <section className="session-pane" aria-labelledby="session-output-title">
            <div className="session-pane-header">
              <div>
                <h4 id="session-output-title">{tr('转换结果')}</h4>
                <span>{SESSION_OUTPUT_LABELS[format]}</span>
              </div>
              <div className="session-pane-actions">
                <button type="button" className="btn btn-ghost session-action-btn" onClick={() => void copyOutput()} disabled={!result?.outputText}>
                  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 8h10v11H8zM6 16H4V5h10v2" /></svg>
                  {copyState === 'copied' ? tr('已复制') : tr('复制')}
                </button>
                <button type="button" className="btn btn-primary session-action-btn" onClick={downloadOutput} disabled={!result?.outputText}>
                  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" /></svg>
                  {format === 'cpa' && (result?.outputAccounts || 0) > 1 ? tr('下载 ZIP') : tr('下载 JSON')}
                </button>
              </div>
            </div>

            <textarea
              ref={outputRef}
              className="session-output"
              value={result?.outputText || ''}
              readOnly
              spellCheck={false}
              aria-label={tr('转换输出')}
              placeholder={tr('转换后将在此显示 JSON')}
            />
            <div className="session-status-line">
              <span aria-hidden="true" />
              {result?.outputText ? tr('输出已就绪') : tr('暂无输出')}
            </div>
          </section>
        </div>

        {result && (
          <div className="feature-result">
            <div className="feature-result-stats" aria-label={tr('转换统计')}>
              <span><strong>{result.outputAccounts}</strong>{tr(' 个账号')}</span>
              <span><strong>{SESSION_OUTPUT_LABELS[format]}</strong>{tr(' 输出格式')}</span>
              <span><strong>{result.issues.length}</strong>{tr(' 个跳过项')}</span>
            </div>

            {result.converted.length > 0 && (
              <div className="session-preview-wrap">
                <table className="session-preview-table">
                  <thead>
                    <tr>
                      <th>{tr('名称')}</th>
                      <th>{tr('邮箱')}</th>
                      <th>{tr('过期时间')}</th>
                      <th>{tr('优先级')}</th>
                      <th>{tr('来源')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.converted.slice(0, 50).map((account, index) => (
                      <tr key={`${account.sourceName}-${account.sourcePath}-${index}`}>
                        <td>{account.name}</td>
                        <td>{account.email || '-'}</td>
                        <td>{formatDisplayDate(account.effectiveExpiresAt || account.expiresAt)}</td>
                        <td>{format === 'sub2api'
                          ? account.accountOutputPriority
                          : (format === 'cpa' || format === 'cockpit' ? account.priority : account.sub2apiPriority)}</td>
                        <td>{account.sourceName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.issues.length > 0 && (
              <div className="feature-issues" role="status">
                {result.issues.slice(0, 8).map((issue, index) => (
                  <div key={`${issue.sourceName}-${issue.path}-${index}`}>
                    <strong>{issue.sourceName}</strong> {issue.path}: {tr(issue.reason)}
                  </div>
                ))}
                {result.issues.length > 8 && <div>+{result.issues.length - 8} {tr('条')}</div>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
