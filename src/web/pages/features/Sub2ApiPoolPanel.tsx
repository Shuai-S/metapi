import React, { useEffect, useState } from 'react';
import {
  api,
  type Sub2ApiPoolConfig,
  type Sub2ApiPoolGroup,
  type Sub2ApiPoolPushResult,
} from '../../api.js';
import { tr } from '../../i18n.js';

type Props = {
  accounts: Record<string, unknown>[];
};

type Feedback = {
  tone: 'success' | 'error' | 'neutral';
  message: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : tr('操作失败');
}

export default function Sub2ApiPoolPanel({ accounts }: Props) {
  const [baseUrl, setBaseUrl] = useState('');
  const [adminApiKey, setAdminApiKey] = useState('');
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyMasked, setKeyMasked] = useState('');
  const [maxParallel, setMaxParallel] = useState(3);
  const [groups, setGroups] = useState<Sub2ApiPoolGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'groups' | 'push' | 'clear' | null>('load');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pushResult, setPushResult] = useState<Sub2ApiPoolPushResult | null>(null);

  const applyConfig = (config: Sub2ApiPoolConfig) => {
    setBaseUrl(config.baseUrl);
    setKeyConfigured(config.adminApiKeyConfigured);
    setKeyMasked(config.adminApiKeyMasked);
    setSelectedGroupIds(config.groupIds);
    setMaxParallel(config.maxParallel);
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const config = await api.getSub2ApiPoolConfig();
        if (!active) return;
        applyConfig(config);
        if (config.baseUrl && config.adminApiKeyConfigured) {
          try {
            const response = await api.getSub2ApiPoolGroups();
            if (active) setGroups(response.groups);
          } catch (error) {
            if (active) setFeedback({ tone: 'error', message: errorMessage(error) });
          }
        }
      } catch (error) {
        if (active && errorMessage(error) !== 'Session expired') {
          setFeedback({ tone: 'error', message: errorMessage(error) });
        }
      } finally {
        if (active) setBusy(null);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setPushResult(null);
  }, [accounts]);

  const saveConfig = async (): Promise<Sub2ApiPoolConfig> => {
    const config = await api.updateSub2ApiPoolConfig({
      baseUrl,
      ...(adminApiKey.trim() ? { adminApiKey: adminApiKey.trim() } : {}),
      groupIds: selectedGroupIds,
      maxParallel,
    });
    applyConfig(config);
    setAdminApiKey('');
    return config;
  };

  const handleSave = async () => {
    setBusy('save');
    setFeedback(null);
    try {
      await saveConfig();
      setFeedback({ tone: 'success', message: tr('号池配置已保存') });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setBusy('test');
    setFeedback(null);
    try {
      await saveConfig();
      const response = await api.testSub2ApiPoolConnection();
      const groupResponse = await api.getSub2ApiPoolGroups();
      setGroups(groupResponse.groups);
      setFeedback({ tone: 'success', message: response.message });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleLoadGroups = async () => {
    setBusy('groups');
    setFeedback(null);
    try {
      await saveConfig();
      const response = await api.getSub2ApiPoolGroups();
      setGroups(response.groups);
      setFeedback({ tone: 'success', message: `${tr('已读取')} ${response.groups.length} ${tr('个分组')}` });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleClearKey = async () => {
    setBusy('clear');
    setFeedback(null);
    try {
      const config = await api.updateSub2ApiPoolConfig({ clearAdminApiKey: true });
      applyConfig(config);
      setAdminApiKey('');
      setGroups([]);
      setFeedback({ tone: 'success', message: tr('管理员 API Key 已清除') });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async () => {
    setBusy('push');
    setFeedback(null);
    setPushResult(null);
    try {
      await saveConfig();
      const result = await api.pushSub2ApiPoolAccounts(accounts);
      setPushResult(result);
      setFeedback({
        tone: result.failed > 0 ? 'error' : 'success',
        message: `${tr('推送完成')}：${tr('新增')} ${result.created}，${tr('跳过')} ${result.skipped}，${tr('失败')} ${result.failed}`,
      });
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const toggleGroup = (id: number) => {
    setSelectedGroupIds((current) => (
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
    ));
  };

  const canConnect = Boolean(baseUrl.trim() && (keyConfigured || adminApiKey.trim()));
  const canPush = canConnect && selectedGroupIds.length > 0 && accounts.length > 0;

  return (
    <section className="sub2api-pool-panel" aria-labelledby="sub2api-pool-title">
      <div className="sub2api-pool-header">
        <div>
          <div className="sub2api-pool-title-line">
            <h4 id="sub2api-pool-title">{tr('Sub2API 号池推送')}</h4>
            <span className={`sub2api-pool-status ${keyConfigured ? 'is-ready' : ''}`}>
              {keyConfigured ? tr('密钥已配置') : tr('待配置')}
            </span>
          </div>
          <span>{tr('一期手动推送')}</span>
        </div>
        <div className="sub2api-pool-actions">
          <button type="button" className="btn btn-ghost session-action-btn" onClick={() => void handleSave()} disabled={busy !== null}>
            {busy === 'save' ? tr('保存中') : tr('保存配置')}
          </button>
          <button type="button" className="btn btn-ghost session-action-btn" onClick={() => void handleTest()} disabled={busy !== null || !canConnect}>
            {busy === 'test' ? tr('测试中') : tr('测试连接')}
          </button>
          <button type="button" className="btn btn-primary session-action-btn" onClick={() => void handlePush()} disabled={busy !== null || !canPush}>
            {busy === 'push' ? tr('推送中') : `${tr('推送账号')} (${accounts.length})`}
          </button>
        </div>
      </div>

      <div className="sub2api-pool-config-grid">
        <label className="sub2api-pool-field sub2api-pool-url-field">
          <span>{tr('服务地址')}</span>
          <input
            type="url"
            value={baseUrl}
            aria-label={tr('Sub2API 服务地址')}
            placeholder="https://sub2api.example.com"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="sub2api-pool-field sub2api-pool-key-field">
          <span>{tr('管理员 API Key')}</span>
          <input
            type="password"
            value={adminApiKey}
            aria-label={tr('Sub2API 管理员 API Key')}
            autoComplete="off"
            placeholder={keyConfigured ? keyMasked || '********' : ''}
            onChange={(event) => setAdminApiKey(event.target.value)}
          />
        </label>
        <label className="sub2api-pool-field sub2api-pool-parallel-field">
          <span>{tr('推送并行')}</span>
          <input
            type="number"
            min="1"
            max="10"
            step="1"
            value={maxParallel}
            aria-label={tr('推送并行数')}
            onChange={(event) => setMaxParallel(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
          />
        </label>
        {keyConfigured && (
          <button type="button" className="btn btn-ghost session-action-btn sub2api-pool-clear-key" onClick={() => void handleClearKey()} disabled={busy !== null}>
            {busy === 'clear' ? tr('清除中') : tr('清除密钥')}
          </button>
        )}
      </div>

      <div className="sub2api-pool-groups-row">
        <div className="sub2api-pool-groups-heading">
          <strong>{tr('目标分组')}</strong>
          <button type="button" className="btn btn-ghost session-action-btn" onClick={() => void handleLoadGroups()} disabled={busy !== null || !canConnect}>
            {busy === 'groups' ? tr('读取中') : tr('刷新分组')}
          </button>
        </div>
        <div className="sub2api-pool-groups" aria-label={tr('Sub2API 目标分组')}>
          {groups.length === 0 && <span className="sub2api-pool-empty">{tr('尚未读取分组')}</span>}
          {groups.map((group) => (
            <label key={group.id} className="sub2api-pool-group-option">
              <input
                type="checkbox"
                checked={selectedGroupIds.includes(group.id)}
                onChange={() => toggleGroup(group.id)}
              />
              <span>{group.name}</span>
              <small>#{group.id}{group.platform ? ` · ${group.platform}` : ''}</small>
            </label>
          ))}
        </div>
      </div>

      {feedback && (
        <div className={`sub2api-pool-feedback is-${feedback.tone}`} role="status">
          {feedback.message}
        </div>
      )}

      {pushResult && pushResult.items.length > 0 && (
        <div className="sub2api-push-results" aria-label={tr('推送明细')}>
          {pushResult.items.map((item) => (
            <div key={`${item.index}-${item.name}`} className={`sub2api-push-result is-${item.status}`}>
              <span className="sub2api-push-result-status">
                {item.status === 'created' ? tr('新增') : item.status === 'skipped' ? tr('跳过') : tr('失败')}
              </span>
              <strong title={item.name}>{item.name}</strong>
              <span title={item.message}>{item.message}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
