import { and, desc, eq, inArray } from 'drizzle-orm';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import {
  decryptAccountPassword,
  encryptAccountPassword,
} from './accountCredentialService.js';
import { getAdapter } from './platforms/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { withSiteRecordProxyRequestInit } from './siteProxy.js';
import { normalizePlatformAlias } from '../../shared/platformIdentity.js';
import { isTokenExpiredError } from './alertRules.js';

const LOW_BALANCE_THRESHOLD = 1;
const MAX_SYNC_PAGES = 200;
const MAX_PAGE_SIZE = 100;

type SiteRow = typeof schema.sites.$inferSelect;
type SiteAccountRow = typeof schema.customerBalanceSiteAccounts.$inferSelect;

class CustomerBalanceUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CustomerBalanceUpstreamError';
  }
}

export type CustomerBalanceSiteAccountSummary = {
  id: number;
  siteId: number;
  siteName: string;
  siteUrl: string;
  platform: string;
  username: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
  latestSnapshot: CustomerBalanceSnapshotSummary | null;
};

export type CustomerBalanceSnapshotSummary = {
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
  createdAt: string | null;
};

export type CustomerBalanceUserRow = {
  id: number;
  snapshotId: number;
  upstreamUserId: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  role: string | null;
  status: string | null;
  balance: number;
  used: number;
  quota: number;
  groupName: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
};

type UpstreamCustomerUser = Omit<CustomerBalanceUserRow, 'id' | 'snapshotId'> & {
  rawPayload: unknown;
};

type PaginatedUsers = {
  users: UpstreamCustomerUser[];
  total: number | null;
  hasMore: boolean;
};

function normalizePlatform(platform: string | null | undefined): string {
  return normalizePlatformAlias(platform || '');
}

function isSupportedCustomerBalancePlatform(platform: string | null | undefined): boolean {
  const normalized = normalizePlatform(platform);
  return normalized === 'new-api' || normalized === 'sub2api';
}

function asTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = asTrimmedString(value);
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return parseTimestamp(numeric);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function normalizeCredentialToken(token: string): string {
  return token.replace(/^Bearer\s+/i, '').trim();
}

function normalizeHeaders(headers?: UndiciRequestInit['headers']): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) return output;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[String(key)] = String(value);
    }
    return output;
  }
  const iterable = headers as { forEach?: (callback: (value: string, key: string) => void) => void };
  if (typeof iterable.forEach === 'function') {
    iterable.forEach((value, key) => {
      output[String(key)] = String(value);
    });
    return output;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    output[key] = String(value);
  }
  return output;
}

async function fetchJsonForSite<T>(
  site: SiteRow,
  url: string,
  options?: UndiciRequestInit,
): Promise<T> {
  const { fetch } = await import('undici');
  const headers = {
    'Content-Type': 'application/json',
    ...normalizeHeaders(options?.headers),
  };
  const response = await fetch(url, withSiteRecordProxyRequestInit(site, {
    ...options,
    body: options?.body ?? undefined,
    headers,
  }));
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload
      ? asTrimmedString((payload as { message?: unknown }).message)
        || asTrimmedString((payload as { error?: unknown }).error)
      : '';
    throw new CustomerBalanceUpstreamError(message || `HTTP ${response.status}`, response.status);
  }
  return payload as T;
}

function unwrapEnvelope(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.success === true && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  if (typeof payload.code === 'number' && payload.code === 0 && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

function extractEnvelopeError(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.success === false) {
    return asTrimmedString(payload.message) || asTrimmedString(payload.error) || '上游返回失败';
  }
  if (typeof payload.code === 'number' && payload.code !== 0) {
    return asTrimmedString(payload.message) || asTrimmedString(payload.error) || `上游返回错误码 ${payload.code}`;
  }
  return null;
}

function extractItemsAndTotal(payload: any): {
  items: unknown[];
  total: number | null;
} {
  const data = unwrapEnvelope(payload);
  const candidates = [
    data?.items,
    data?.data?.items,
    data?.users,
    data?.data?.users,
    data?.list,
    data?.data?.list,
    Array.isArray(data?.data) ? data.data : undefined,
    Array.isArray(data) ? data : undefined,
  ];
  const items = candidates.find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
  const total = parseNumber(data?.total ?? data?.data?.total ?? payload?.total ?? payload?.data?.total);
  return {
    items: items || [],
    total: total != null && total >= 0 ? Math.trunc(total) : null,
  };
}

function convertQuotaUnit(value: unknown): number {
  const parsed = parseNumber(value);
  if (parsed == null) return 0;
  return roundMetric(parsed / 500_000);
}

function extractRole(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 10) return 'admin';
    return 'user';
  }
  return null;
}

function extractStatus(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return 'active';
    if (value === 2) return 'disabled';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'active' : 'disabled';
  return null;
}

function isActiveStatus(status: string | null): boolean {
  if (!status) return true;
  return status === 'active' || status === 'enabled' || status === '1';
}

function parseNewApiUser(raw: unknown): UpstreamCustomerUser | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = asTrimmedString(item.id) || asTrimmedString(item.user_id);
  if (!id) return null;
  const balance = convertQuotaUnit(item.quota ?? item.remain_quota ?? item.balance);
  const used = convertQuotaUnit(item.used_quota);
  const quota = roundMetric(balance + used);
  return {
    upstreamUserId: id,
    username: asTrimmedString(item.username) || null,
    email: asTrimmedString(item.email) || null,
    displayName: asTrimmedString(item.display_name) || null,
    role: extractRole(item.role),
    status: extractStatus(item.status),
    balance,
    used,
    quota,
    groupName: asTrimmedString(item.group) || asTrimmedString(item.group_name) || null,
    createdAt: parseTimestamp(item.created_at),
    lastActiveAt: parseTimestamp(item.last_login_at ?? item.last_active_at ?? item.last_used_at),
    rawPayload: item,
  };
}

function parseSub2ApiUser(raw: unknown): UpstreamCustomerUser | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = asTrimmedString(item.id) || asTrimmedString(item.user_id);
  if (!id) return null;
  const balance = roundMetric(Math.max(0, parseNumber(item.balance) ?? parseNumber(item.quota) ?? 0));
  const used = roundMetric(Math.max(0, parseNumber(item.used) ?? parseNumber(item.used_balance) ?? 0));
  const quota = roundMetric(Math.max(balance + used, parseNumber(item.total_balance) ?? 0));
  return {
    upstreamUserId: id,
    username: asTrimmedString(item.username) || null,
    email: asTrimmedString(item.email) || null,
    displayName: asTrimmedString(item.display_name) || asTrimmedString(item.nickname) || null,
    role: extractRole(item.role),
    status: extractStatus(item.status),
    balance,
    used,
    quota: quota || balance,
    groupName: asTrimmedString(item.group_name) || asTrimmedString(item.group) || null,
    createdAt: parseTimestamp(item.created_at),
    lastActiveAt: parseTimestamp(item.last_active_at ?? item.last_used_at),
    rawPayload: item,
  };
}

function calculateSummary(users: UpstreamCustomerUser[]) {
  let activeUsers = 0;
  let totalBalance = 0;
  let lowBalanceUsers = 0;
  let negativeBalanceUsers = 0;
  let zeroBalanceUsers = 0;

  for (const user of users) {
    if (isActiveStatus(user.status)) activeUsers += 1;
    totalBalance += user.balance;
    if (user.balance < 0) negativeBalanceUsers += 1;
    if (user.balance === 0) zeroBalanceUsers += 1;
    if (user.balance < LOW_BALANCE_THRESHOLD) lowBalanceUsers += 1;
  }

  return {
    totalUsers: users.length,
    activeUsers,
    totalBalance: roundMetric(totalBalance),
    lowBalanceUsers,
    negativeBalanceUsers,
    zeroBalanceUsers,
  };
}

function formatSnapshotSummary(row: typeof schema.customerBalanceSnapshots.$inferSelect): CustomerBalanceSnapshotSummary {
  return {
    id: row.id,
    siteAccountId: row.siteAccountId,
    siteId: row.siteId,
    platform: row.platform,
    totalUsers: row.totalUsers,
    activeUsers: row.activeUsers,
    totalBalance: Number(row.totalBalance || 0),
    lowBalanceUsers: row.lowBalanceUsers,
    negativeBalanceUsers: row.negativeBalanceUsers,
    zeroBalanceUsers: row.zeroBalanceUsers,
    createdAt: row.createdAt ?? null,
  };
}

function formatUserRow(row: typeof schema.customerBalanceSnapshotUsers.$inferSelect): CustomerBalanceUserRow {
  return {
    id: row.id,
    snapshotId: row.snapshotId,
    upstreamUserId: row.upstreamUserId,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    balance: Number(row.balance || 0),
    used: Number(row.used || 0),
    quota: Number(row.quota || 0),
    groupName: row.groupName,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
  };
}

async function getLatestSnapshotByAccountIds(accountIds: number[]) {
  const result = new Map<number, CustomerBalanceSnapshotSummary>();
  if (accountIds.length === 0) return result;
  const snapshots = await db.select()
    .from(schema.customerBalanceSnapshots)
    .where(inArray(schema.customerBalanceSnapshots.siteAccountId, accountIds))
    .orderBy(desc(schema.customerBalanceSnapshots.createdAt))
    .all();
  for (const snapshot of snapshots) {
    if (!result.has(snapshot.siteAccountId)) {
      result.set(snapshot.siteAccountId, formatSnapshotSummary(snapshot));
    }
  }
  return result;
}

async function loadSiteAndAccount(siteAccountId: number): Promise<{
  account: SiteAccountRow;
  site: SiteRow;
}> {
  const rows = await db.select()
    .from(schema.customerBalanceSiteAccounts)
    .innerJoin(schema.sites, eq(schema.customerBalanceSiteAccounts.siteId, schema.sites.id))
    .where(eq(schema.customerBalanceSiteAccounts.id, siteAccountId))
    .all();
  if (!rows.length) throw new Error('客户余额站点账号不存在');
  const account = rows[0].customer_balance_site_accounts;
  const site = rows[0].sites;
  if (!isSupportedCustomerBalancePlatform(site.platform)) {
    throw new Error('仅支持 New API 和 Sub2API 站点');
  }
  return { account, site };
}

async function loginSiteAccount(site: SiteRow, account: SiteAccountRow): Promise<{
  accessToken: string;
  platformUserId: string | null;
  tokenExpiresAt: number | null;
}> {
  const password = decryptAccountPassword(account.passwordCipher);
  if (!password) throw new Error('管理员站点账号密码无法解密，请重新保存账号');
  const adapter = getAdapter(site.platform);
  if (!adapter) throw new Error('站点平台不支持登录');
  const result = await adapter.login(site.url, account.username, password);
  if (!result.success || !result.accessToken) {
    throw new Error(result.message || '管理员站点账号登录失败');
  }
  return {
    accessToken: normalizeCredentialToken(result.accessToken),
    platformUserId: result.platformUserId ? String(result.platformUserId) : null,
    tokenExpiresAt: typeof result.tokenExpiresAt === 'number'
      && Number.isFinite(result.tokenExpiresAt)
      && result.tokenExpiresAt > 0
      ? Math.trunc(result.tokenExpiresAt)
      : null,
  };
}

async function persistSiteAccountLogin(
  account: SiteAccountRow,
  loginResult: Awaited<ReturnType<typeof loginSiteAccount>>,
): Promise<string> {
  const platformUserId = loginResult.platformUserId || account.platformUserId || null;
  await db.update(schema.customerBalanceSiteAccounts)
    .set({
      accessToken: loginResult.accessToken,
      platformUserId,
      tokenExpiresAt: loginResult.tokenExpiresAt,
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.customerBalanceSiteAccounts.id, account.id))
    .run();
  account.accessToken = loginResult.accessToken;
  account.platformUserId = platformUserId;
  account.tokenExpiresAt = loginResult.tokenExpiresAt;
  return loginResult.accessToken;
}

async function ensureAccessToken(site: SiteRow, account: SiteAccountRow): Promise<string> {
  const now = Date.now();
  const existing = normalizeCredentialToken(account.accessToken || '');
  const tokenExpiresAt = Number(account.tokenExpiresAt || 0);
  const needsNewApiUserId = normalizePlatform(site.platform) === 'new-api' && !account.platformUserId;
  if (existing && !needsNewApiUserId && (!tokenExpiresAt || tokenExpiresAt - now > 60_000)) {
    return existing;
  }
  const loginResult = await loginSiteAccount(site, account);
  return persistSiteAccountLogin(account, loginResult);
}

function shouldReloginCustomerBalance(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status || 0);
  const message = error instanceof Error ? error.message : String(error || '');
  if (isTokenExpiredError({ status: status || undefined, message })) return true;

  // New API may return this as a successful JSON envelope instead of HTTP 401.
  const text = message.toLowerCase();
  return (
    text.includes('unauthorized')
    || text.includes('not logged in')
    || text.includes('not logged')
    || text.includes('no access token provided')
    || text.includes('未登录且未提供 access token')
    || text.includes('new-api-user')
  );
}

async function reloginCustomerBalanceSiteAccount(
  site: SiteRow,
  account: SiteAccountRow,
  options?: { resetPlatformUserId?: boolean },
): Promise<string> {
  // Do not keep retrying a known-invalid session when the password was changed upstream.
  await db.update(schema.customerBalanceSiteAccounts)
    .set({
      accessToken: null,
      tokenExpiresAt: null,
      ...(options?.resetPlatformUserId ? { platformUserId: null } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.customerBalanceSiteAccounts.id, account.id))
    .run();
  account.accessToken = null;
  account.tokenExpiresAt = null;
  if (options?.resetPlatformUserId) account.platformUserId = null;
  const loginResult = await loginSiteAccount(site, account);
  return persistSiteAccountLogin(account, loginResult);
}

function isCookieToken(accessToken: string): boolean {
  return accessToken.includes('=') || accessToken.includes(';') || /^session=/i.test(accessToken);
}

function authHeaders(accessToken: string): Record<string, string> {
  const normalized = normalizeCredentialToken(accessToken);
  if (isCookieToken(normalized)) return { Cookie: normalized };
  return { Authorization: `Bearer ${normalized}` };
}

function extractLikelyUserIds(...values: Array<string | null | undefined>): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000_000) return;
    const normalized = String(Math.trunc(parsed));
    if (!ids.includes(normalized)) ids.push(normalized);
  };

  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    for (const match of raw.matchAll(/\b(\d{1,8})\b/g)) {
      push(match[1]);
    }
    for (const sessionMatch of raw.matchAll(/(?:^|;\s*)session=([^;]+)/gi)) {
      try {
        const decoded = Buffer.from(sessionMatch[1], 'base64').toString('utf8');
        for (const match of decoded.matchAll(/\b(\d{1,8})\b/g)) {
          push(match[1]);
        }
      } catch {}
    }
  }
  return ids;
}

function newApiAdminHeaders(accessToken: string, userId?: string | null): Record<string, string> {
  const headers: Record<string, string> = authHeaders(accessToken);
  if (userId) {
    headers['New-Api-User'] = userId;
    headers['Veloera-User'] = userId;
    headers['voapi-user'] = userId;
    headers['User-id'] = userId;
    headers['Rix-Api-User'] = userId;
    headers['neo-api-user'] = userId;
  }
  return headers;
}

function sub2ApiAdminHeaders(accessToken: string): Record<string, string> {
  return authHeaders(accessToken);
}

async function resolveNewApiAdminUserId(
  site: SiteRow,
  accessToken: string,
  candidateUserIds: string[] = [],
): Promise<string | null> {
  let lastFailure: string | null = null;
  const candidates = [null, ...candidateUserIds];
  for (const candidateUserId of candidates) {
    const payload = await fetchJsonForSite<any>(site, `${site.url}/api/user/self`, {
      headers: candidateUserId
        ? newApiAdminHeaders(accessToken, candidateUserId)
        : authHeaders(accessToken),
    });
    const failure = extractEnvelopeError(payload);
    if (failure) {
      lastFailure = failure;
      continue;
    }
    const data = unwrapEnvelope(payload);
    const id = asTrimmedString(data?.id);
    const role = parseNumber(data?.role);
    if (role != null && role < 10) {
      throw new Error('该 New API 账号不是管理员');
    }
    return id || candidateUserId || null;
  }
  if (lastFailure) throw new Error(lastFailure);
  return null;
}

async function fetchNewApiUsersPage(input: {
  site: SiteRow;
  accessToken: string;
  adminUserId: string | null;
  page: number;
  pageSize: number;
}): Promise<PaginatedUsers> {
  const query = new URLSearchParams({
    p: String(input.page),
    page_size: String(input.pageSize),
  });
  const payload = await fetchJsonForSite<any>(
    input.site,
    `${input.site.url}/api/user/?${query.toString()}`,
    { headers: newApiAdminHeaders(input.accessToken, input.adminUserId) },
  );
  const failure = extractEnvelopeError(payload);
  if (failure) throw new Error(failure);
  const { items, total } = extractItemsAndTotal(payload);
  const users = items.map(parseNewApiUser).filter((item): item is UpstreamCustomerUser => !!item);
  return {
    users,
    total,
    hasMore: total != null ? input.page * input.pageSize < total : items.length >= input.pageSize,
  };
}

async function fetchSub2ApiUsersPage(input: {
  site: SiteRow;
  accessToken: string;
  page: number;
  pageSize: number;
}): Promise<PaginatedUsers> {
  const query = new URLSearchParams({
    page: String(input.page),
    page_size: String(input.pageSize),
    include_subscriptions: 'false',
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  const payload = await fetchJsonForSite<any>(
    input.site,
    `${input.site.url}/api/v1/admin/users?${query.toString()}`,
    { headers: sub2ApiAdminHeaders(input.accessToken) },
  );
  const failure = extractEnvelopeError(payload);
  if (failure) throw new Error(failure);
  const { items, total } = extractItemsAndTotal(payload);
  const users = items.map(parseSub2ApiUser).filter((item): item is UpstreamCustomerUser => !!item);
  return {
    users,
    total,
    hasMore: total != null ? input.page * input.pageSize < total : items.length >= input.pageSize,
  };
}

async function fetchAllUsers(
  site: SiteRow,
  account: SiteAccountRow,
  accessToken: string,
): Promise<UpstreamCustomerUser[]> {
  const platform = normalizePlatform(site.platform);
  const users: UpstreamCustomerUser[] = [];
  const pageSize = MAX_PAGE_SIZE;
  const adminUserId = platform === 'new-api'
    ? (account.platformUserId || await resolveNewApiAdminUserId(
      site,
      accessToken,
      extractLikelyUserIds(account.platformUserId, account.username, accessToken),
    ))
    : null;
  if (platform === 'new-api' && adminUserId && adminUserId !== account.platformUserId) {
    account.platformUserId = adminUserId;
    await db.update(schema.customerBalanceSiteAccounts)
      .set({ platformUserId: adminUserId, updatedAt: new Date().toISOString() })
      .where(eq(schema.customerBalanceSiteAccounts.id, account.id))
      .run();
  }

  for (let page = 1; page <= MAX_SYNC_PAGES; page += 1) {
    const pageResult = platform === 'new-api'
      ? await fetchNewApiUsersPage({ site, accessToken, adminUserId, page, pageSize })
      : await fetchSub2ApiUsersPage({ site, accessToken, page, pageSize });
    users.push(...pageResult.users);
    if (!pageResult.hasMore) break;
  }

  return users;
}

export async function listCustomerBalanceSiteAccounts(): Promise<CustomerBalanceSiteAccountSummary[]> {
  const rows = await db.select()
    .from(schema.customerBalanceSiteAccounts)
    .innerJoin(schema.sites, eq(schema.customerBalanceSiteAccounts.siteId, schema.sites.id))
    .all();
  const latestSnapshots = await getLatestSnapshotByAccountIds(
    rows.map((row) => row.customer_balance_site_accounts.id),
  );
  return rows.map((row) => {
    const account = row.customer_balance_site_accounts;
    const site = row.sites;
    return {
      id: account.id,
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      platform: site.platform,
      username: account.username,
      lastSyncedAt: account.lastSyncedAt,
      lastError: account.lastError,
      updatedAt: account.updatedAt,
      latestSnapshot: latestSnapshots.get(account.id) || null,
    };
  });
}

export async function upsertCustomerBalanceSiteAccount(input: {
  siteId: number;
  username: string;
  password: string;
}): Promise<CustomerBalanceSiteAccountSummary> {
  const site = await db.select()
    .from(schema.sites)
    .where(eq(schema.sites.id, input.siteId))
    .get();
  if (!site) throw new Error('站点不存在');
  if (!isSupportedCustomerBalancePlatform(site.platform)) {
    throw new Error('仅支持 New API 和 Sub2API 站点');
  }
  const username = input.username.trim();
  const password = input.password.trim();
  if (!username || !password) {
    throw new Error('管理员站点账号和密码不能为空');
  }
  const now = new Date().toISOString();
  const existing = await db.select()
    .from(schema.customerBalanceSiteAccounts)
    .where(eq(schema.customerBalanceSiteAccounts.siteId, site.id))
    .get();

  if (existing) {
    await db.update(schema.customerBalanceSiteAccounts)
      .set({
        username,
        passwordCipher: encryptAccountPassword(password),
        accessToken: null,
        tokenExpiresAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(schema.customerBalanceSiteAccounts.id, existing.id))
      .run();
    const updated = (await listCustomerBalanceSiteAccounts()).find((row) => row.id === existing.id);
    if (!updated) throw new Error('保存客户余额站点账号失败');
    return updated;
  }

  const inserted = await db.insert(schema.customerBalanceSiteAccounts)
    .values({
      siteId: site.id,
      username,
      passwordCipher: encryptAccountPassword(password),
      updatedAt: now,
    })
    .run();
  const insertedId = requireInsertedRowId(inserted, '保存客户余额站点账号失败');
  const created = (await listCustomerBalanceSiteAccounts()).find((row) => row.id === insertedId);
  if (!created) throw new Error('保存客户余额站点账号失败');
  return created;
}

export async function deleteCustomerBalanceSiteAccount(siteAccountId: number): Promise<void> {
  await db.delete(schema.customerBalanceSiteAccounts)
    .where(eq(schema.customerBalanceSiteAccounts.id, siteAccountId))
    .run();
}

export async function syncCustomerBalanceSiteAccount(siteAccountId: number): Promise<{
  snapshot: CustomerBalanceSnapshotSummary;
  users: CustomerBalanceUserRow[];
}> {
  const { account, site } = await loadSiteAndAccount(siteAccountId);
  try {
    let accessToken = await ensureAccessToken(site, account);
    let users: UpstreamCustomerUser[];
    try {
      users = await fetchAllUsers(site, account, accessToken);
    } catch (error) {
      if (!shouldReloginCustomerBalance(error)) throw error;
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      accessToken = await reloginCustomerBalanceSiteAccount(site, account, {
        resetPlatformUserId: message.includes('new-api-user'),
      });
      users = await fetchAllUsers(site, account, accessToken);
    }
    const summary = calculateSummary(users);
    const now = formatUtcSqlDateTime(new Date());
    const insertedSnapshot = await db.insert(schema.customerBalanceSnapshots)
      .values({
        siteAccountId: account.id,
        siteId: site.id,
        platform: normalizePlatform(site.platform),
        ...summary,
        rawPayload: JSON.stringify({ totalUsers: users.length }),
        createdAt: now,
      })
      .run();
    const snapshotId = requireInsertedRowId(insertedSnapshot, '保存客户余额快照失败');

    for (const user of users) {
      await db.insert(schema.customerBalanceSnapshotUsers)
        .values({
          snapshotId,
          upstreamUserId: user.upstreamUserId,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          status: user.status,
          balance: user.balance,
          used: user.used,
          quota: user.quota,
          groupName: user.groupName,
          createdAt: user.createdAt,
          lastActiveAt: user.lastActiveAt,
          rawPayload: JSON.stringify(user.rawPayload),
        })
        .run();
    }

    await db.update(schema.customerBalanceSiteAccounts)
      .set({
        lastSyncedAt: now,
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.customerBalanceSiteAccounts.id, account.id))
      .run();

    const snapshot = await db.select()
      .from(schema.customerBalanceSnapshots)
      .where(eq(schema.customerBalanceSnapshots.id, snapshotId))
      .get();
    const snapshotUsers = await getCustomerBalanceSnapshotUsers(snapshotId);
    return {
      snapshot: formatSnapshotSummary(snapshot!),
      users: snapshotUsers,
    };
  } catch (error: any) {
    const message = error?.message || '同步客户余额失败';
    await db.update(schema.customerBalanceSiteAccounts)
      .set({
        lastError: message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.customerBalanceSiteAccounts.id, account.id))
      .run();
    throw new Error(message);
  }
}

export async function getCustomerBalanceSnapshots(siteAccountId?: number): Promise<CustomerBalanceSnapshotSummary[]> {
  const query = db.select().from(schema.customerBalanceSnapshots);
  const rows = siteAccountId
    ? await query
      .where(eq(schema.customerBalanceSnapshots.siteAccountId, siteAccountId))
      .orderBy(desc(schema.customerBalanceSnapshots.createdAt))
      .all()
    : await query.orderBy(desc(schema.customerBalanceSnapshots.createdAt)).all();
  return rows.map(formatSnapshotSummary);
}

export async function getCustomerBalanceSnapshotUsers(snapshotId: number, filters?: {
  search?: string;
  status?: string;
  balance?: string;
}): Promise<CustomerBalanceUserRow[]> {
  const baseRows = await db.select()
    .from(schema.customerBalanceSnapshotUsers)
    .where(eq(schema.customerBalanceSnapshotUsers.snapshotId, snapshotId))
    .all();

  const search = String(filters?.search || '').trim().toLowerCase();
  const status = String(filters?.status || '').trim().toLowerCase();
  const balance = String(filters?.balance || '').trim().toLowerCase();

  return baseRows
    .map(formatUserRow)
    .filter((row) => {
      if (search) {
        const haystack = [
          row.upstreamUserId,
          row.username,
          row.email,
          row.displayName,
          row.groupName,
        ].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      if (status && row.status !== status) return false;
      if (balance === 'low' && row.balance >= LOW_BALANCE_THRESHOLD) return false;
      if (balance === 'zero' && row.balance !== 0) return false;
      if (balance === 'negative' && row.balance >= 0) return false;
      return true;
    })
    .sort((left, right) => left.balance - right.balance);
}

export async function getCustomerBalanceSnapshotDetail(snapshotId: number, filters?: {
  search?: string;
  status?: string;
  balance?: string;
}): Promise<{
  snapshot: CustomerBalanceSnapshotSummary | null;
  users: CustomerBalanceUserRow[];
}> {
  const snapshot = await db.select()
    .from(schema.customerBalanceSnapshots)
    .where(eq(schema.customerBalanceSnapshots.id, snapshotId))
    .get();
  if (!snapshot) return { snapshot: null, users: [] };
  const users = await getCustomerBalanceSnapshotUsers(snapshotId, filters);
  return {
    snapshot: formatSnapshotSummary(snapshot),
    users,
  };
}

export async function resolveCustomerBalanceSiteOptions() {
  const sites = await db.select()
    .from(schema.sites)
    .all();
  const configuredRows = await db.select({
    siteId: schema.customerBalanceSiteAccounts.siteId,
  })
    .from(schema.customerBalanceSiteAccounts)
    .all();
  const configured = new Set(configuredRows.map((row) => row.siteId));
  return sites
    .filter((site) => isSupportedCustomerBalancePlatform(site.platform))
    .map((site) => ({
      id: site.id,
      name: site.name,
      url: site.url,
      platform: normalizePlatform(site.platform),
      status: site.status,
      configured: configured.has(site.id),
    }));
}

export async function findCustomerBalanceSnapshotForSiteAccount(siteAccountId: number) {
  const row = await db.select()
    .from(schema.customerBalanceSnapshots)
    .where(eq(schema.customerBalanceSnapshots.siteAccountId, siteAccountId))
    .orderBy(desc(schema.customerBalanceSnapshots.createdAt))
    .get();
  return row ? formatSnapshotSummary(row) : null;
}

export async function clearCustomerBalanceSnapshots(siteAccountId: number): Promise<void> {
  const snapshots = await db.select({ id: schema.customerBalanceSnapshots.id })
    .from(schema.customerBalanceSnapshots)
    .where(eq(schema.customerBalanceSnapshots.siteAccountId, siteAccountId))
    .all();
  if (snapshots.length > 0) {
    await db.delete(schema.customerBalanceSnapshotUsers)
      .where(inArray(schema.customerBalanceSnapshotUsers.snapshotId, snapshots.map((snapshot) => snapshot.id)))
      .run();
  }
  await db.delete(schema.customerBalanceSnapshots)
    .where(and(eq(schema.customerBalanceSnapshots.siteAccountId, siteAccountId)))
    .run();
}
