import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';

type SiteOption = {
  id: number;
  name: string;
  url: string;
  platform: string;
  status?: string | null;
  configured?: boolean;
};

type SnapshotSummary = {
  id: number;
  siteAccountId: number;
  siteId: number;
  platform: string;
  totalUsers: number;
  activeUsers: number;
  totalBalance: number;
  lowBalanceUsers: number;
  negativeBalanceUsers: number;
  zeroBalanceUsers: number;
  createdAt?: string | null;
};

type SiteAccount = {
  id: number;
  siteId: number;
  siteName: string;
  siteUrl: string;
  platform: string;
  username: string;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  latestSnapshot?: SnapshotSummary | null;
};

type CustomerUser = {
  id: number;
  upstreamUserId: string;
  username?: string | null;
  email?: string | null;
  displayName?: string | null;
  role?: string | null;
  status?: string | null;
  balance: number;
  used: number;
  quota: number;
  groupName?: string | null;
  createdAt?: string | null;
  lastActiveAt?: string | null;
};

const FILTER_ALL = '';

function formatMoney(value: unknown): string {
  const numeric = Number(value || 0);
  return `$${numeric.toFixed(2)}`;
}

function formatTime(value?: string | null): string {
  if (!value) return '-';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function userLabel(user: CustomerUser): string {
  return user.displayName || user.username || user.email || `#${user.upstreamUserId}`;
}

export default function CustomerBalances() {
  const toast = useToast();
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [accounts, setAccounts] = useState<SiteAccount[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [users, setUsers] = useState<CustomerUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [form, setForm] = useState({ siteId: '', username: '', password: '' });
  const [filters, setFilters] = useState({
    search: '',
    status: FILTER_ALL,
    balance: FILTER_ALL,
  });

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || null,
    [accounts, selectedAccountId],
  );
  const selectedSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === selectedSnapshotId)
      || selectedAccount?.latestSnapshot
      || snapshots[0]
      || null,
    [selectedAccount, selectedSnapshotId, snapshots],
  );

  const aggregate = useMemo(() => {
    const latest = accounts
      .map((account) => account.latestSnapshot)
      .filter((snapshot): snapshot is SnapshotSummary => !!snapshot);
    return latest.reduce(
      (acc, snapshot) => ({
        sites: acc.sites + 1,
        totalUsers: acc.totalUsers + snapshot.totalUsers,
        totalBalance: acc.totalBalance + snapshot.totalBalance,
        lowBalanceUsers: acc.lowBalanceUsers + snapshot.lowBalanceUsers,
      }),
      { sites: 0, totalUsers: 0, totalBalance: 0, lowBalanceUsers: 0 },
    );
  }, [accounts]);

  const load = async () => {
    setLoading(true);
    try {
      const [sitePayload, accountPayload] = await Promise.all([
        api.getCustomerBalanceSites(),
        api.getCustomerBalanceAccounts(),
      ]);
      const nextSites = Array.isArray(sitePayload?.sites) ? sitePayload.sites : [];
      const nextAccounts = Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [];
      setSites(nextSites);
      setAccounts(nextAccounts);
      const nextSelected = selectedAccountId && nextAccounts.some((account: SiteAccount) => account.id === selectedAccountId)
        ? selectedAccountId
        : (nextAccounts[0]?.id || null);
      setSelectedAccountId(nextSelected);
    } catch (error: any) {
      toast.error(error?.message || '加载客户余额失败');
    } finally {
      setLoading(false);
    }
  };

  const loadSnapshots = async (accountId: number | null) => {
    if (!accountId) {
      setSnapshots([]);
      setSelectedSnapshotId(null);
      setUsers([]);
      return;
    }
    try {
      const payload = await api.getCustomerBalanceSnapshots(accountId);
      const nextSnapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
      setSnapshots(nextSnapshots);
      setSelectedSnapshotId((current) => (
        current && nextSnapshots.some((snapshot: SnapshotSummary) => snapshot.id === current)
          ? current
          : (nextSnapshots[0]?.id || null)
      ));
    } catch (error: any) {
      toast.error(error?.message || '加载快照失败');
    }
  };

  const loadSnapshotDetail = async (snapshotId: number | null) => {
    if (!snapshotId) {
      setUsers([]);
      return;
    }
    try {
      const payload = await api.getCustomerBalanceSnapshot(snapshotId, filters);
      setUsers(Array.isArray(payload?.users) ? payload.users : []);
    } catch (error: any) {
      toast.error(error?.message || '加载客户列表失败');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    void loadSnapshots(selectedAccountId);
  }, [selectedAccountId]);

  useEffect(() => {
    void loadSnapshotDetail(selectedSnapshot?.id || null);
  }, [selectedSnapshot?.id, filters.search, filters.status, filters.balance]);

  const saveAccount = async () => {
    const siteId = Number(form.siteId);
    if (!siteId || !form.username.trim() || !form.password.trim()) {
      toast.error('请选择站点并填写管理员账号和密码');
      return;
    }
    setSaving(true);
    try {
      const payload = await api.saveCustomerBalanceAccount({
        siteId,
        username: form.username.trim(),
        password: form.password.trim(),
      });
      setForm({ siteId: '', username: '', password: '' });
      toast.success('站点账号已保存');
      await load();
      if (payload?.account?.id) setSelectedAccountId(payload.account.id);
    } catch (error: any) {
      toast.error(error?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const syncAccount = async (account: SiteAccount) => {
    setSyncingId(account.id);
    try {
      const payload = await api.syncCustomerBalanceAccount(account.id);
      toast.success(`已同步 ${payload?.snapshot?.totalUsers || 0} 个客户`);
      await load();
      await loadSnapshots(account.id);
      if (payload?.snapshot?.id) setSelectedSnapshotId(payload.snapshot.id);
    } catch (error: any) {
      toast.error(error?.message || '同步失败');
      await load();
    } finally {
      setSyncingId(null);
    }
  };

  const deleteAccount = async (account: SiteAccount) => {
    if (!window.confirm(`删除 ${account.siteName} 的客户余额配置？`)) return;
    try {
      await api.deleteCustomerBalanceAccount(account.id);
      toast.success('配置已删除');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '删除失败');
    }
  };

  const clearSnapshots = async (account: SiteAccount) => {
    if (!window.confirm(`清空 ${account.siteName} 的客户余额快照？`)) return;
    try {
      await api.clearCustomerBalanceSnapshots(account.id);
      toast.success('快照已清空');
      await loadSnapshots(account.id);
      await load();
    } catch (error: any) {
      toast.error(error?.message || '清空失败');
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">客户余额</h2>
          <p className="page-subtitle">通过站点管理员账号同步 New API 和 Sub2API 用户余额。</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={load} disabled={loading}>
            {loading ? <><span className="spinner spinner-sm" /> 刷新中...</> : '刷新'}
          </button>
        </div>
      </div>

      <div className="customer-balance-stats">
        <div className="card customer-balance-stat">
          <span>已配置站点</span>
          <strong>{aggregate.sites}</strong>
        </div>
        <div className="card customer-balance-stat">
          <span>客户总数</span>
          <strong>{aggregate.totalUsers}</strong>
        </div>
        <div className="card customer-balance-stat">
          <span>余额合计</span>
          <strong>{formatMoney(aggregate.totalBalance)}</strong>
        </div>
        <div className="card customer-balance-stat">
          <span>低余额客户</span>
          <strong>{aggregate.lowBalanceUsers}</strong>
        </div>
      </div>

      <div className="customer-balance-layout">
        <section className="card customer-balance-panel">
          <div className="customer-balance-panel-header">
            <div>
              <h3>站点账号</h3>
              <p>保存站点管理员登录账号后即可同步客户列表。</p>
            </div>
          </div>
          <div className="customer-balance-form">
            <select
              value={form.siteId}
              onChange={(event) => setForm((current) => ({ ...current, siteId: event.target.value }))}
            >
              <option value="">选择站点</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name} · {site.platform}{site.configured ? ' · 已配置' : ''}
                </option>
              ))}
            </select>
            <input
              value={form.username}
              onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
              placeholder="管理员账号"
              autoComplete="username"
            />
            <input
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="管理员密码"
              type="password"
              autoComplete="current-password"
            />
            <button className="btn btn-primary" onClick={saveAccount} disabled={saving}>
              {saving ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存账号'}
            </button>
          </div>

          <div className="customer-balance-account-list">
            {accounts.length === 0 && (
              <div className="empty-state">暂无站点账号</div>
            )}
            {accounts.map((account) => {
              const active = account.id === selectedAccountId;
              return (
                <button
                  key={account.id}
                  type="button"
                  className={`customer-balance-account ${active ? 'active' : ''}`}
                  onClick={() => setSelectedAccountId(account.id)}
                >
                  <div>
                    <strong>{account.siteName}</strong>
                    <span>{account.platform} · {account.username}</span>
                  </div>
                  <span className={account.lastError ? 'badge badge-error' : 'badge badge-muted'}>
                    {account.lastError ? '异常' : (account.lastSyncedAt ? '已同步' : '未同步')}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="card customer-balance-panel customer-balance-main">
          {selectedAccount ? (
            <>
              <div className="customer-balance-panel-header">
                <div>
                  <h3>{selectedAccount.siteName}</h3>
                  <p>{selectedAccount.siteUrl}</p>
                </div>
                <div className="page-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => syncAccount(selectedAccount)}
                    disabled={syncingId === selectedAccount.id}
                  >
                    {syncingId === selectedAccount.id ? <><span className="spinner spinner-sm" /> 同步中...</> : '同步余额'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => clearSnapshots(selectedAccount)}>清空快照</button>
                  <button className="btn btn-danger" onClick={() => deleteAccount(selectedAccount)}>删除配置</button>
                </div>
              </div>

              {selectedAccount.lastError && (
                <div className="alert alert-error">{selectedAccount.lastError}</div>
              )}

              <div className="customer-balance-snapshot-bar">
                <select
                  value={selectedSnapshot?.id || ''}
                  onChange={(event) => setSelectedSnapshotId(Number(event.target.value) || null)}
                >
                  {snapshots.length === 0 && <option value="">暂无快照</option>}
                  {snapshots.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {formatTime(snapshot.createdAt)} · {snapshot.totalUsers} 人 · {formatMoney(snapshot.totalBalance)}
                    </option>
                  ))}
                </select>
                {selectedSnapshot && (
                  <div className="customer-balance-summary">
                    <span>客户 {selectedSnapshot.totalUsers}</span>
                    <span>活跃 {selectedSnapshot.activeUsers}</span>
                    <span>低余额 {selectedSnapshot.lowBalanceUsers}</span>
                    <span>{formatMoney(selectedSnapshot.totalBalance)}</span>
                  </div>
                )}
              </div>

              <div className="customer-balance-filters">
                <input
                  value={filters.search}
                  onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                  placeholder="搜索客户 / 邮箱 / 分组"
                />
                <select
                  value={filters.status}
                  onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
                >
                  <option value="">全部状态</option>
                  <option value="active">active</option>
                  <option value="disabled">disabled</option>
                </select>
                <select
                  value={filters.balance}
                  onChange={(event) => setFilters((current) => ({ ...current, balance: event.target.value }))}
                >
                  <option value="">全部余额</option>
                  <option value="low">低于 $1</option>
                  <option value="zero">等于 $0</option>
                  <option value="negative">负余额</option>
                </select>
              </div>

              <div className="table-container customer-balance-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>客户</th>
                      <th>ID</th>
                      <th>状态</th>
                      <th>分组</th>
                      <th>余额</th>
                      <th>已用</th>
                      <th>总额</th>
                      <th>最近活跃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div className="customer-balance-user">
                            <strong>{userLabel(user)}</strong>
                            <span>{user.email || user.username || '-'}</span>
                          </div>
                        </td>
                        <td>{user.upstreamUserId}</td>
                        <td><span className="badge badge-muted">{user.status || '-'}</span></td>
                        <td>{user.groupName || '-'}</td>
                        <td style={{ color: user.balance < 1 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 700 }}>
                          {formatMoney(user.balance)}
                        </td>
                        <td>{formatMoney(user.used)}</td>
                        <td>{formatMoney(user.quota)}</td>
                        <td>{formatTime(user.lastActiveAt)}</td>
                      </tr>
                    ))}
                    {selectedSnapshot && users.length === 0 && (
                      <tr>
                        <td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
                          没有匹配的客户
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="empty-state">先添加一个 New API 或 Sub2API 管理员站点账号</div>
          )}
        </section>
      </div>
    </div>
  );
}
