import React, { useRef, useState } from 'react';
import { tr } from '../i18n.js';
import { convertCardKeyExport, type CardKeyConversionResult } from './helpers/cardKeyToSub2api.js';

function downloadResult(result: CardKeyConversionResult) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const blob = new Blob([JSON.stringify(result.output, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sub2api_converted_${date}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function Features() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<CardKeyConversionResult | null>(null);
  const [error, setError] = useState('');
  const [strict, setStrict] = useState(false);

  const readFile = async (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    setError('');
    try {
      const next = convertCardKeyExport(await file.text(), strict);
      if (next.inputAccounts === 0) throw new Error(tr('未找到可转换的账号'));
      setResult(next);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : tr('文件转换失败'));
    }
  };

  return (
    <div className="feature-page">
      <div className="page-header feature-page-header">
        <div>
          <h2 className="page-title">{tr('功能')}</h2>
          <p className="feature-page-subtitle">{tr('本地数据处理工具')}</p>
        </div>
      </div>

      <section className="feature-tool">
        <div className="feature-tool-heading">
          <div className="feature-tool-icon" aria-hidden="true">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 7h10M7 12h7m-7 5h10M5 3h10l4 4v12a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM15 3v5h5" /></svg>
          </div>
          <div>
            <h3>{tr('卡密转 sub2api')}</h3>
            <p>{tr('将卡密批量导出文本转换为 sub2api 可导入的 JSON 文件')}</p>
          </div>
        </div>

        <button type="button" className="feature-dropzone" onClick={() => inputRef.current?.click()}>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 16V4m0 0L7 9m5-5l5 5M5 20h14" /></svg>
          <strong>{fileName || tr('选择卡密导出文件')}</strong>
          <span>{tr('支持 UTF-8 / UTF-8 BOM 的 .txt 文件')}</span>
        </button>
        <input ref={inputRef} hidden type="file" accept=".txt,text/plain" onChange={(event) => void readFile(event.target.files?.[0])} />

        <label className="feature-mode-toggle">
          <input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />
          <span>{tr('严格模式')}</span>
          <small>{tr('遇到无效行时立即停止')}</small>
        </label>

        {error && <div className="alert alert-error">{error}</div>}
        {result && (
          <div className="feature-result">
            <div className="feature-result-stats">
              <span><strong>{result.inputAccounts}</strong>{tr(' 个输入账号')}</span>
              <span><strong>{result.outputAccounts}</strong>{tr(' 个输出账号')}</span>
              <span><strong>{result.issues.length}</strong>{tr(' 条提示')}</span>
            </div>
            {result.issues.length > 0 && (
              <div className="feature-issues">
                {result.issues.slice(0, 5).map((issue, index) => <div key={`${issue.line}-${index}`}>{tr('第')} {issue.line} {tr('行')}：{tr(issue.message)}</div>)}
                {result.issues.length > 5 && <div>+{result.issues.length - 5} {tr('条')}</div>}
              </div>
            )}
            <button type="button" className="btn btn-primary" onClick={() => downloadResult(result)}>{tr('下载 sub2api JSON')}</button>
          </div>
        )}
      </section>
    </div>
  );
}
