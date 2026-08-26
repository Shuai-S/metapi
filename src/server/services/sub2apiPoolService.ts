import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fetch as undiciFetch } from 'undici';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { decryptSecret, encryptSecret } from './accountCredentialService.js';

const SETTING_KEY = 'sub2api_pool_config_v1';
const PUSH_LEDGER_SETTING_KEY = 'sub2api_pool_push_ledger_v1';
const DEFAULT_MAX_PARALLEL = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 100;

type JsonRecord = Record<string, unknown>;

type StoredConfig = {
  version: 1;
  baseUrl: string;
  encryptedAdminApiKey: string;
  groupIds: number[];
  maxParallel: number;
};

type PushLedger = {
  version: 1;
  targets: Record<string, string[]>;
};

type FetchLike = (
  url: string,
  init?: Parameters<typeof undiciFetch>[1],
) => Promise<Awaited<ReturnType<typeof undiciFetch>>>;

type ServiceDependencies = {
  fetchImpl?: FetchLike;
  readSetting?: () => Promise<unknown>;
  writeSetting?: (value: StoredConfig) => Promise<void>;
  readPushLedger?: () => Promise<unknown>;
  writePushLedger?: (value: PushLedger) => Promise<void>;
};

export type Sub2ApiPoolConfigInput = {
  baseUrl?: string;
  adminApiKey?: string;
  clearAdminApiKey?: boolean;
  groupIds?: number[];
  maxParallel?: number;
};

export type Sub2ApiPoolPublicConfig = {
  baseUrl: string;
  adminApiKeyConfigured: boolean;
  adminApiKeyMasked: string;
  groupIds: number[];
  maxParallel: number;
};

export type Sub2ApiPoolGroup = {
  id: number;
  name: string;
  platform?: string;
  status?: string;
};

export type Sub2ApiPoolPushItem = {
  index: number;
  name: string;
  status: 'created' | 'skipped' | 'failed';
  accountId?: number | string;
  message: string;
};

export type Sub2ApiPoolPushResult = {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  items: Sub2ApiPoolPushItem[];
};

export class Sub2ApiPoolError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 500,
    readonly code = 'SUB2API_POOL_ERROR',
  ) {
    super(message);
    this.name = 'Sub2ApiPoolError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeGroupIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)))
    .slice(0, 100);
}

function normalizeBaseUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Sub2ApiPoolError('Sub2API 地址无效', 400, 'INVALID_BASE_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Sub2ApiPoolError('Sub2API 地址必须是 HTTP 或 HTTPS 地址，且不能包含账号密码', 400, 'INVALID_BASE_URL');
  }
  parsed.search = '';
  parsed.hash = '';
  let path = parsed.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api\/v1\/admin$/i, '').replace(/\/api\/v1$/i, '');
  parsed.pathname = path || '/';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeStoredConfig(value: unknown): StoredConfig {
  const record = isRecord(value) ? value : {};
  let baseUrl = '';
  try {
    baseUrl = normalizeBaseUrl(record.baseUrl);
  } catch {
    baseUrl = '';
  }
  return {
    version: 1,
    baseUrl,
    encryptedAdminApiKey: typeof record.encryptedAdminApiKey === 'string'
      ? record.encryptedAdminApiKey
      : '',
    groupIds: normalizeGroupIds(record.groupIds),
    maxParallel: toInteger(record.maxParallel, DEFAULT_MAX_PARALLEL, 1, 10),
  };
}

function normalizePushLedger(value: unknown): PushLedger {
  const record = isRecord(value) && isRecord(value.targets) ? value.targets : {};
  const targets: Record<string, string[]> = {};
  for (const [target, refs] of Object.entries(record)) {
    if (!/^[a-f0-9]{32}$/.test(target) || !Array.isArray(refs)) continue;
    targets[target] = Array.from(new Set(refs
      .filter((ref): ref is string => typeof ref === 'string' && /^metapi:v1:[a-f0-9]{64}$/.test(ref))))
      .slice(-5000);
  }
  return { version: 1, targets };
}

function maskAdminApiKey(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function parseSettingValue(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJsonSetting(key: string): Promise<unknown> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return parseSettingValue(row?.value);
}

async function defaultReadSetting(): Promise<unknown> {
  return readJsonSetting(SETTING_KEY);
}

async function defaultWriteSetting(value: StoredConfig): Promise<void> {
  await upsertSetting(SETTING_KEY, value);
}

async function defaultReadPushLedger(): Promise<unknown> {
  return readJsonSetting(PUSH_LEDGER_SETTING_KEY);
}

async function defaultWritePushLedger(value: PushLedger): Promise<void> {
  await upsertSetting(PUSH_LEDGER_SETTING_KEY, value);
}

function readRemoteMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const direct = typeof value.message === 'string' ? value.message.trim() : '';
  if (direct) return direct.slice(0, 300);
  if (typeof value.error === 'string' && value.error.trim()) return value.error.trim().slice(0, 300);
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message.trim().slice(0, 300) || fallback;
  }
  return fallback;
}

function unwrapEnvelope(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Sub2ApiPoolError('Sub2API 返回了无效响应', 502, 'INVALID_REMOTE_RESPONSE');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'code')) {
    const code = value.code;
    if (code !== 0 && code !== '0') {
      throw new Sub2ApiPoolError(
        readRemoteMessage(value, `Sub2API 返回错误码 ${String(code)}`),
        502,
        'REMOTE_API_ERROR',
      );
    }
  }
  if (value.success === false) {
    throw new Sub2ApiPoolError(
      readRemoteMessage(value, 'Sub2API 请求失败'),
      502,
      'REMOTE_API_ERROR',
    );
  }
  return Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value;
}

function extractCollection(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRetryAfterMs(value: string | null): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, seconds * 1000);
  return 250;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickStringFields(source: JsonRecord, fields: string[]): JsonRecord {
  const result: JsonRecord = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value.trim()) result[field] = value.trim();
  }
  return result;
}

function normalizeStringMap(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .flatMap(([key, item]) => (
      key.trim() && typeof item === 'string' && item.trim()
        ? [[key.trim(), item.trim()] as const]
        : []
    ))
    .slice(0, 200);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildSub2ApiPushReference(account: unknown): string {
  const record = isRecord(account) ? account : {};
  const credentials = isRecord(record.credentials) ? record.credentials : {};
  const extra = isRecord(record.extra) ? record.extra : {};
  const accountId = firstString(
    credentials.account_id,
    credentials.chatgpt_account_id,
    credentials.chatgpt_user_id,
  );
  const email = firstString(credentials.email, extra.email, extra.email_key).toLowerCase();
  const fallbackToken = firstString(credentials.refresh_token, credentials.access_token);
  const identity = accountId
    ? { accountId }
    : email
      ? { email }
      : fallbackToken
        ? { tokenHash: hash(fallbackToken) }
        : { name: firstString(record.name).toLowerCase() };
  return `metapi:v1:${hash(JSON.stringify({ platform: 'openai', type: 'oauth', ...identity }))}`;
}

function normalizeFiniteNumber(value: unknown, fallback: number, integer = false): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return integer ? Math.trunc(numeric) : numeric;
}

function normalizeAccount(account: unknown, groupIds: number[]): { name: string; ref: string; payload: JsonRecord } {
  if (!isRecord(account)) {
    throw new Sub2ApiPoolError('账号数据必须是对象', 400, 'INVALID_ACCOUNT');
  }
  const name = firstString(account.name);
  const credentials = isRecord(account.credentials) ? account.credentials : {};
  const accessToken = firstString(credentials.access_token);
  if (!name || !accessToken) {
    throw new Sub2ApiPoolError('账号缺少名称或 access_token', 400, 'INVALID_ACCOUNT');
  }

  const allowedCredentials = pickStringFields(credentials, [
    'refresh_token',
    'id_token',
    'account_id',
    'chatgpt_account_id',
    'chatgpt_user_id',
    'email',
    'expires_at',
  ]);
  allowedCredentials.access_token = accessToken;
  const expiresIn = Number(credentials.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn >= 0) allowedCredentials.expires_in = expiresIn;
  const modelMapping = normalizeStringMap(credentials.model_mapping);
  if (modelMapping) allowedCredentials.model_mapping = modelMapping;
  const rawExtra = isRecord(account.extra) ? account.extra : {};
  const allowedExtra = pickStringFields(rawExtra, [
    'email',
    'email_key',
    'name',
    'source',
    'last_refresh',
  ]);
  const fingerprintMode = firstString(rawExtra.codex_fingerprint_mode);
  if (['off', 'device', 'session', 'full'].includes(fingerprintMode)) {
    allowedExtra.codex_fingerprint_mode = fingerprintMode;
  }
  if (typeof rawExtra.enable_tls_fingerprint === 'boolean') {
    allowedExtra.enable_tls_fingerprint = rawExtra.enable_tls_fingerprint;
  }
  const tlsProfileId = Number(rawExtra.tls_fingerprint_profile_id);
  if (Number.isInteger(tlsProfileId) && tlsProfileId > 0) {
    allowedExtra.tls_fingerprint_profile_id = tlsProfileId;
  }
  const ref = buildSub2ApiPushReference(account);
  allowedExtra.metapi_push_ref = ref;
  allowedExtra.metapi_source = 'metapi';

  const payload: JsonRecord = {
    name,
    platform: 'openai',
    type: 'oauth',
    credentials: allowedCredentials,
    extra: allowedExtra,
    concurrency: normalizeFiniteNumber(account.concurrency, 10, true),
    priority: normalizeFiniteNumber(account.priority, 1, true),
    rate_multiplier: normalizeFiniteNumber(account.rate_multiplier, 1),
    group_ids: groupIds,
    auto_pause_on_expired: account.auto_pause_on_expired !== false,
  };

  if (account.proxy_id === null || (Number.isInteger(account.proxy_id) && Number(account.proxy_id) > 0)) {
    payload.proxy_id = account.proxy_id;
  }
  if (account.load_factor === null || (Number.isFinite(Number(account.load_factor)) && Number(account.load_factor) >= 0)) {
    payload.load_factor = account.load_factor === null ? null : Number(account.load_factor);
  }
  if (account.expires_at === null || (typeof account.expires_at === 'string' && account.expires_at.trim())) {
    payload.expires_at = account.expires_at === null ? null : account.expires_at.trim();
  }
  return { name, ref, payload };
}

function readPushRef(item: unknown): string {
  if (!isRecord(item)) return '';
  let extra: unknown = item.extra;
  if (typeof extra === 'string') {
    try {
      extra = JSON.parse(extra);
    } catch {
      extra = null;
    }
  }
  return isRecord(extra) && typeof extra.metapi_push_ref === 'string'
    ? extra.metapi_push_ref.trim()
    : '';
}

export function createSub2ApiPoolService(dependencies: ServiceDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || undiciFetch;
  const readSetting = dependencies.readSetting || defaultReadSetting;
  const writeSetting = dependencies.writeSetting || defaultWriteSetting;
  const readPushLedger = dependencies.readPushLedger || defaultReadPushLedger;
  const writePushLedger = dependencies.writePushLedger || defaultWritePushLedger;

  async function readStoredConfig(): Promise<StoredConfig> {
    return normalizeStoredConfig(await readSetting());
  }

  async function resolveConfiguredTarget(requireGroups = false): Promise<{
    baseUrl: string;
    adminApiKey: string;
    groupIds: number[];
    maxParallel: number;
  }> {
    const stored = await readStoredConfig();
    const adminApiKey = stored.encryptedAdminApiKey
      ? decryptSecret(stored.encryptedAdminApiKey)?.trim() || ''
      : '';
    if (!stored.baseUrl || !adminApiKey) {
      throw new Sub2ApiPoolError('请先保存 Sub2API 地址和管理员 API Key', 409, 'NOT_CONFIGURED');
    }
    if (requireGroups && stored.groupIds.length === 0) {
      throw new Sub2ApiPoolError('请先选择并保存至少一个远端分组', 409, 'GROUP_NOT_CONFIGURED');
    }
    return { ...stored, adminApiKey };
  }

  async function requestJson(
    target: { baseUrl: string; adminApiKey: string },
    path: string,
    init: Parameters<typeof undiciFetch>[1] = {},
  ): Promise<unknown> {
    const url = `${target.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': 'metapi-sub2api-pool/1.0',
            'x-api-key': target.adminApiKey,
            ...(init.headers || {}),
          },
        });
        const text = await response.text();
        let body: unknown = {};
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = { message: text.slice(0, 300) };
          }
        }
        if (response.ok) return unwrapEnvelope(body);

        const fallback = response.status === 401 || response.status === 403
          ? '管理员 API Key 无效或权限不足'
          : `Sub2API 请求失败（HTTP ${response.status}）`;
        const error = new Sub2ApiPoolError(
          readRemoteMessage(body, fallback),
          response.status === 401 || response.status === 403 ? 400 : 502,
          shouldRetryStatus(response.status) ? 'REMOTE_RETRYABLE' : 'REMOTE_REQUEST_FAILED',
        );
        if (!shouldRetryStatus(response.status) || attempt === 2) throw error;
        lastError = error;
        await wait(parseRetryAfterMs(response.headers.get('retry-after')) || 250 * (attempt + 1));
      } catch (error) {
        if (error instanceof Sub2ApiPoolError && error.code !== 'REMOTE_RETRYABLE') throw error;
        lastError = error;
        if (attempt === 2) {
          if (error instanceof Sub2ApiPoolError) throw error;
          const timeoutMessage = error instanceof Error && error.name === 'AbortError'
            ? 'Sub2API 请求超时'
            : '无法连接 Sub2API';
          throw new Sub2ApiPoolError(timeoutMessage, 502, 'REMOTE_NETWORK_AMBIGUOUS');
        }
        await wait(250 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Sub2ApiPoolError('Sub2API 请求失败', 502, 'REMOTE_REQUEST_FAILED');
  }

  async function listGroups(): Promise<Sub2ApiPoolGroup[]> {
    const target = await resolveConfiguredTarget();
    const data = await requestJson(target, '/api/v1/admin/groups/all');
    const rows = extractCollection(data, ['items', 'groups', 'list']);
    return rows.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = Number(item.id);
      if (!Number.isInteger(id) || id <= 0) return [];
      return [{
        id,
        name: firstString(item.name, item.display_name, `分组 ${id}`),
        ...(typeof item.platform === 'string' && item.platform.trim()
          ? { platform: item.platform.trim() }
          : {}),
        ...(typeof item.status === 'string' && item.status.trim()
          ? { status: item.status.trim() }
          : {}),
      }];
    });
  }

  async function listRemoteAccountRefs(target: { baseUrl: string; adminApiKey: string }): Promise<Set<string>> {
    const refs = new Set<string>();
    for (let page = 1; page <= MAX_ACCOUNT_PAGES; page += 1) {
      const data = await requestJson(
        target,
        `/api/v1/admin/accounts?page=${page}&page_size=${PAGE_SIZE}`,
      );
      const rows = extractCollection(data, ['items', 'accounts', 'list', 'records']);
      for (const row of rows) {
        const ref = readPushRef(row);
        if (ref) refs.add(ref);
      }
      const total = isRecord(data) && Number.isFinite(Number(data.total))
        ? Number(data.total)
        : null;
      if (rows.length < PAGE_SIZE || (total !== null && page * PAGE_SIZE >= total)) break;
    }
    return refs;
  }

  async function reconcilePush(target: { baseUrl: string; adminApiKey: string }, ref: string): Promise<boolean> {
    try {
      return (await listRemoteAccountRefs(target)).has(ref);
    } catch {
      return false;
    }
  }

  async function pushAccounts(accounts: unknown[]): Promise<Sub2ApiPoolPushResult> {
    const target = await resolveConfiguredTarget(true);
    const remoteRefs = await listRemoteAccountRefs(target);
    const targetLedgerKey = hash(target.baseUrl).slice(0, 32);
    const ledger = normalizePushLedger(await readPushLedger());
    const knownRefs = new Set([
      ...remoteRefs,
      ...(ledger.targets[targetLedgerKey] || []),
    ]);
    const results: Array<Sub2ApiPoolPushItem | undefined> = new Array(accounts.length);
    const batchRefs = new Set<string>();
    const createdRefs = new Set<string>();
    const jobs: Array<{ index: number; name: string; ref: string; payload: JsonRecord }> = [];

    accounts.forEach((account, index) => {
      try {
        const normalized = normalizeAccount(account, target.groupIds);
        if (batchRefs.has(normalized.ref)) {
          results[index] = {
            index,
            name: normalized.name,
            status: 'skipped',
            message: '本批次中存在相同账号',
          };
          return;
        }
        batchRefs.add(normalized.ref);
        if (knownRefs.has(normalized.ref)) {
          results[index] = {
            index,
            name: normalized.name,
            status: 'skipped',
            message: '远端号池或本地推送记录已存在',
          };
          return;
        }
        jobs.push({ index, ...normalized });
      } catch (error) {
        results[index] = {
          index,
          name: isRecord(account) ? firstString(account.name, `账号 ${index + 1}`) : `账号 ${index + 1}`,
          status: 'failed',
          message: error instanceof Error ? error.message : '账号数据无效',
        };
      }
    });

    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor];
        cursor += 1;
        try {
          const data = await requestJson(target, '/api/v1/admin/accounts', {
            method: 'POST',
            headers: { 'Idempotency-Key': hash(`${target.baseUrl}\n${job.ref}`) },
            body: JSON.stringify(job.payload),
          });
          const record = isRecord(data) && isRecord(data.account) ? data.account : data;
          const accountId = isRecord(record) && (typeof record.id === 'number' || typeof record.id === 'string')
            ? record.id
            : undefined;
          results[job.index] = {
            index: job.index,
            name: job.name,
            status: 'created',
            ...(accountId !== undefined ? { accountId } : {}),
            message: '已推送到远端号池',
          };
          createdRefs.add(job.ref);
        } catch (error) {
          const ambiguous = error instanceof Sub2ApiPoolError
            && ['REMOTE_NETWORK_AMBIGUOUS', 'REMOTE_RETRYABLE'].includes(error.code);
          if (ambiguous && await reconcilePush(target, job.ref)) {
            results[job.index] = {
              index: job.index,
              name: job.name,
              status: 'created',
              message: '远端已创建，已通过幂等标记确认',
            };
            createdRefs.add(job.ref);
          } else {
            results[job.index] = {
              index: job.index,
              name: job.name,
              status: 'failed',
              message: error instanceof Error ? error.message : '推送失败',
            };
          }
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(target.maxParallel, jobs.length) },
      () => worker(),
    ));

    if (createdRefs.size > 0) {
      try {
        const latestLedger = normalizePushLedger(await readPushLedger());
        latestLedger.targets[targetLedgerKey] = Array.from(new Set([
          ...(latestLedger.targets[targetLedgerKey] || []),
          ...createdRefs,
        ])).slice(-5000);
        await writePushLedger(latestLedger);
      } catch {
        // Remote markers and deterministic idempotency keys still protect retries.
      }
    }

    const items = results.filter((item): item is Sub2ApiPoolPushItem => Boolean(item));
    return {
      total: accounts.length,
      created: items.filter((item) => item.status === 'created').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      failed: items.filter((item) => item.status === 'failed').length,
      items,
    };
  }

  return {
    async getConfig(): Promise<Sub2ApiPoolPublicConfig> {
      const stored = await readStoredConfig();
      const adminApiKey = stored.encryptedAdminApiKey
        ? decryptSecret(stored.encryptedAdminApiKey)?.trim() || ''
        : '';
      return {
        baseUrl: stored.baseUrl,
        adminApiKeyConfigured: Boolean(adminApiKey),
        adminApiKeyMasked: maskAdminApiKey(adminApiKey),
        groupIds: stored.groupIds,
        maxParallel: stored.maxParallel,
      };
    },

    async saveConfig(input: Sub2ApiPoolConfigInput): Promise<Sub2ApiPoolPublicConfig> {
      const current = await readStoredConfig();
      const next: StoredConfig = {
        version: 1,
        baseUrl: input.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(input.baseUrl),
        encryptedAdminApiKey: current.encryptedAdminApiKey,
        groupIds: input.groupIds === undefined ? current.groupIds : normalizeGroupIds(input.groupIds),
        maxParallel: input.maxParallel === undefined
          ? current.maxParallel
          : toInteger(input.maxParallel, current.maxParallel, 1, 10),
      };
      if (input.clearAdminApiKey) {
        next.encryptedAdminApiKey = '';
      } else if (typeof input.adminApiKey === 'string' && input.adminApiKey.trim()) {
        next.encryptedAdminApiKey = encryptSecret(input.adminApiKey.trim());
      }
      await writeSetting(next);
      const adminApiKey = next.encryptedAdminApiKey
        ? decryptSecret(next.encryptedAdminApiKey)?.trim() || ''
        : '';
      return {
        baseUrl: next.baseUrl,
        adminApiKeyConfigured: Boolean(adminApiKey),
        adminApiKeyMasked: maskAdminApiKey(adminApiKey),
        groupIds: next.groupIds,
        maxParallel: next.maxParallel,
      };
    },

    listGroups,

    async testConnection(): Promise<{ success: true; message: string; groupCount: number }> {
      const groups = await listGroups();
      return {
        success: true,
        message: `连接成功，读取到 ${groups.length} 个分组`,
        groupCount: groups.length,
      };
    },

    pushAccounts,
  };
}

export const sub2ApiPoolService = createSub2ApiPoolService();
