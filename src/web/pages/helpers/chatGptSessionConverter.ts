export const SESSION_OUTPUT_FORMATS = [
  'sub2api',
  'cpa',
  'cockpit',
  '9router',
  'axonhub',
  'codexmanager',
] as const;

export type SessionOutputFormat = typeof SESSION_OUTPUT_FORMATS[number];

export const SUB2API_CODEX_FINGERPRINT_MODES = [
  'off',
  'device',
  'session',
  'full',
] as const;

export type Sub2ApiCodexFingerprintMode = typeof SUB2API_CODEX_FINGERPRINT_MODES[number];

export const SESSION_OUTPUT_LABELS: Record<SessionOutputFormat, string> = {
  sub2api: 'sub2api',
  cpa: 'CPA',
  cockpit: 'Cockpit',
  '9router': '9router',
  axonhub: 'AxonHub',
  codexmanager: 'Codex-Manager',
};

export type SessionSourceDocument = {
  text: string;
  sourceName: string;
};

export type SessionConversionIssue = {
  sourceName: string;
  path: string;
  reason: string;
};

export type ConvertedSession = {
  sourceName: string;
  sourcePath: string;
  email?: string;
  name: string;
  expiresAt?: string;
  effectiveExpiresAt?: string;
  priority: number;
  sub2apiPriority: number;
  accountOutputPriority: number;
  cpa: Record<string, unknown>;
  cockpit: Record<string, unknown>;
  nineRouter: Record<string, unknown>;
  axonHub: Record<string, unknown>;
  codexManager: Record<string, unknown>;
  sub2apiAccount: Record<string, unknown>;
};

export type Sub2ApiAccountOutputSettings = {
  models?: string[];
  concurrency?: number;
  priority?: number;
  rateMultiplier?: number;
  importGroup?: string;
  codexFingerprintMode?: Sub2ApiCodexFingerprintMode;
};

export type SessionConversionResult = {
  format: SessionOutputFormat;
  output: unknown;
  outputText: string;
  inputAccounts: number;
  outputAccounts: number;
  converted: ConvertedSession[];
  issues: SessionConversionIssue[];
};

export type SessionConversionOptions = {
  format?: SessionOutputFormat;
  forceRefreshAfterImport?: boolean;
  sub2apiAccountSettings?: Sub2ApiAccountOutputSettings;
  now?: Date;
};

type SessionCandidate = {
  value: Record<string, any>;
  sourceName: string;
  path: string;
};

const AXONHUB_PLACEHOLDER_REFRESH_TOKEN = '__missing_refresh_token__';

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeBase64UrlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function parseJwtPayload(token: unknown): Record<string, any> | undefined {
  if (typeof token !== 'string' || token.trim() === '') return undefined;
  const segments = token.split('.');
  if (segments.length < 2) return undefined;
  try {
    const parsed = JSON.parse(decodeBase64Url(segments[1]));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getOpenAISection(payload: unknown, key: string): Record<string, any> {
  if (!isPlainObject(payload)) return {};
  return isPlainObject(payload[key]) ? payload[key] : {};
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e11 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function timestampFromUnixSeconds(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function epochSecondsFromValue(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
}

function buildSyntheticCodexIdToken(
  email: string | undefined,
  accountId: string | undefined,
  planType: string | undefined,
  userId: string | undefined,
  expiresAt: string | undefined,
): string | undefined {
  if (!accountId) return undefined;
  const now = Math.trunc(Date.now() / 1000);
  const authInfo: Record<string, unknown> = { chatgpt_account_id: accountId };
  const expires = epochSecondsFromValue(expiresAt) || now + 90 * 24 * 60 * 60;
  if (planType) authInfo.chatgpt_plan_type = planType;
  if (userId) {
    authInfo.chatgpt_user_id = userId;
    authInfo.user_id = userId;
  }
  const payload: Record<string, unknown> = {
    iat: now,
    exp: expires,
    'https://api.openai.com/auth': authInfo,
  };
  if (email) payload.email = email;
  return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.synthetic`;
}

function getExpiresIn(expiresAt: string | undefined, now: Date): number | undefined {
  if (!expiresAt) return undefined;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return undefined;
  return Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000));
}

function normalizeDateOnly(value: unknown): string | undefined {
  return normalizeTimestamp(value)?.slice(0, 10);
}

function getPriorityDayOffset(date: Date): number {
  const baseDay = Date.UTC(2026, 5, 14);
  const currentDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((currentDay - baseDay) / (24 * 60 * 60 * 1000));
}

function getDynamicPriority(date: Date): number {
  return 10000 - getPriorityDayOffset(date);
}

function getSub2apiPriority(date: Date): number {
  return 10000 + getPriorityDayOffset(date);
}

function stripUnavailable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUnavailable).filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripUnavailable(item)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === undefined || value === null || value === '' ? undefined : value;
}

function toEmailKey(email: string | undefined): string | undefined {
  if (!email) return undefined;
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function collectSessionLikeObjects(value: unknown, sourceName: string): SessionCandidate[] {
  const found: SessionCandidate[] = [];
  const visited = new WeakSet<object>();

  const visit = (item: unknown, path: string) => {
    if (!isPlainObject(item) && !Array.isArray(item)) return;
    if (visited.has(item)) return;
    visited.add(item);

    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }

    const token = firstNonEmpty(
      item.accessToken,
      item.access_token,
      item.tokens?.accessToken,
      item.tokens?.access_token,
      item.token?.accessToken,
      item.token?.access_token,
      item.credentials?.accessToken,
      item.credentials?.access_token,
    );
    const identity = isPlainObject(item.user) || firstNonEmpty(
      item.email,
      item.name,
      item.label,
      item.meta?.label,
      item.tokens?.accountId,
      item.tokens?.account_id,
      item.tokens?.chatgptAccountId,
      item.tokens?.chatgpt_account_id,
      item.providerSpecificData?.chatgptAccountId,
      item.providerSpecificData?.chatgpt_account_id,
      item.id,
    );
    if (token && identity) {
      found.push({ value: item, sourceName, path });
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (key === 'accessToken' || key === 'access_token' || key === 'sessionToken') continue;
      visit(child, `${path}.${key}`);
    }
  };

  visit(value, '$');
  return found;
}

export function extractJsonSlices(text: string): string[] {
  const value = text.trim();
  if (!value) return [];
  const slices: string[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (stack.length) inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (!stack.length) start = index;
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') continue;
    if (!stack.length) continue;
    const open = stack.pop();
    if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) {
      stack.length = 0;
      start = -1;
      continue;
    }
    if (!stack.length && start >= 0) {
      slices.push(value.slice(start, index + 1));
      start = -1;
    }
  }
  return slices;
}

function parseSourceDocument(source: SessionSourceDocument): {
  candidates: SessionCandidate[];
  issues: SessionConversionIssue[];
} {
  const text = source.text.replace(/^\uFEFF/, '').trim();
  if (!text) return { candidates: [], issues: [] };
  try {
    return { candidates: collectSessionLikeObjects(JSON.parse(text), source.sourceName), issues: [] };
  } catch (documentError) {
    const slices = extractJsonSlices(text);
    if (slices.length) {
      const candidates: SessionCandidate[] = [];
      const issues: SessionConversionIssue[] = [];
      slices.forEach((slice, index) => {
        try {
          candidates.push(...collectSessionLikeObjects(JSON.parse(slice), source.sourceName));
        } catch (error) {
          issues.push({
            sourceName: source.sourceName,
            path: `$[${index}]`,
            reason: error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败',
          });
        }
      });
      return { candidates, issues };
    }
    return {
      candidates: [],
      issues: [{
        sourceName: source.sourceName,
        path: '$',
        reason: documentError instanceof Error ? `JSON 解析失败：${documentError.message}` : 'JSON 解析失败',
      }],
    };
  }
}

function asOutputRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function normalizeNonNegativeNumber(value: unknown, fallback: number, integer = false): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return integer ? Math.trunc(numeric) : numeric;
}

function buildModelMapping(models: string[] | undefined): Record<string, string> | undefined {
  const normalized = Array.from(new Set(
    (models || []).map((model) => model.trim()).filter(Boolean),
  ));
  return normalized.length
    ? Object.fromEntries(normalized.map((model) => [model, model]))
    : undefined;
}

function normalizeCodexFingerprintMode(
  value: unknown,
): Exclude<Sub2ApiCodexFingerprintMode, 'off'> | undefined {
  if (
    typeof value !== 'string'
    || value === 'off'
    || !(SUB2API_CODEX_FINGERPRINT_MODES as readonly string[]).includes(value)
  ) {
    return undefined;
  }
  return value as Exclude<Sub2ApiCodexFingerprintMode, 'off'>;
}

function convertSession(
  record: Record<string, any>,
  sourceName: string,
  sourcePath: string,
  now: Date,
  forceRefreshAfterImport: boolean,
  sub2apiAccountSettings?: Sub2ApiAccountOutputSettings,
): ConvertedSession {
  const accessToken = firstNonEmpty(
    record.accessToken,
    record.access_token,
    record.tokens?.accessToken,
    record.tokens?.access_token,
    record.token?.accessToken,
    record.token?.access_token,
    record.credentials?.accessToken,
    record.credentials?.access_token,
  );
  if (!accessToken) throw new Error('缺少 accessToken');

  const sessionToken = firstNonEmpty(
    record.sessionToken,
    record.session_token,
    record.tokens?.sessionToken,
    record.tokens?.session_token,
    record.token?.sessionToken,
    record.token?.session_token,
    record.credentials?.session_token,
  );
  const refreshToken = firstNonEmpty(
    record.refreshToken,
    record.refresh_token,
    record.tokens?.refreshToken,
    record.tokens?.refresh_token,
    record.token?.refreshToken,
    record.token?.refresh_token,
    record.credentials?.refresh_token,
  );
  const inputIdToken = firstNonEmpty(
    record.idToken,
    record.id_token,
    record.tokens?.idToken,
    record.tokens?.id_token,
    record.token?.idToken,
    record.token?.id_token,
    record.credentials?.id_token,
  );
  const payload = parseJwtPayload(accessToken);
  const idPayload = parseJwtPayload(inputIdToken);
  const auth = getOpenAISection(payload, 'https://api.openai.com/auth');
  const idAuth = getOpenAISection(idPayload, 'https://api.openai.com/auth');
  const profile = getOpenAISection(payload, 'https://api.openai.com/profile');
  const expiresAt = firstNonEmpty(
    payload ? timestampFromUnixSeconds(payload.exp) : undefined,
    normalizeTimestamp(record.expires),
    normalizeTimestamp(record.expiresAt),
    normalizeTimestamp(record.expired),
    normalizeTimestamp(record.expires_at),
    record.credentials?.expires_at,
  );
  const email = firstNonEmpty(
    record.user?.email,
    record.email,
    record.meta?.label,
    record.label,
    record.credentials?.email,
    record.providerSpecificData?.email,
    profile.email,
    idPayload?.email,
    payload?.email,
  );
  const accountId = firstNonEmpty(
    record.account?.id,
    record.account_id,
    record.tokens?.accountId,
    record.tokens?.account_id,
    record.chatgptAccountId,
    record.chatgpt_account_id,
    record.meta?.chatgptAccountId,
    record.meta?.chatgpt_account_id,
    record.tokens?.chatgptAccountId,
    record.tokens?.chatgpt_account_id,
    record.providerSpecificData?.chatgptAccountId,
    record.providerSpecificData?.chatgpt_account_id,
    record.credentials?.account_id,
    record.credentials?.chatgpt_account_id,
    auth.chatgpt_account_id,
    idAuth.chatgpt_account_id,
    record.provider === 'codex' ? record.id : undefined,
  );
  const chatgptAccountId = firstNonEmpty(
    record.chatgptAccountId,
    record.chatgpt_account_id,
    record.meta?.chatgptAccountId,
    record.meta?.chatgpt_account_id,
    record.tokens?.chatgptAccountId,
    record.tokens?.chatgpt_account_id,
    record.providerSpecificData?.chatgptAccountId,
    record.providerSpecificData?.chatgpt_account_id,
    record.credentials?.chatgpt_account_id,
    auth.chatgpt_account_id,
    idAuth.chatgpt_account_id,
  );
  const workspaceId = firstNonEmpty(
    record.account?.workspaceId,
    record.account?.workspace_id,
    record.workspaceId,
    record.workspace_id,
    record.meta?.workspaceId,
    record.meta?.workspace_id,
    record.providerSpecificData?.workspaceId,
    record.providerSpecificData?.workspace_id,
    record.credentials?.workspace_id,
    payload?.workspace_id,
    idPayload?.workspace_id,
  );
  const userId = firstNonEmpty(
    record.user?.id,
    record.user_id,
    record.chatgptUserId,
    record.providerSpecificData?.chatgptUserId,
    record.providerSpecificData?.chatgpt_user_id,
    record.credentials?.chatgpt_user_id,
    auth.chatgpt_user_id,
    auth.user_id,
    idAuth.chatgpt_user_id,
    idAuth.user_id,
  );
  const planType = firstNonEmpty(
    record.account?.planType,
    record.account?.plan_type,
    record.planType,
    record.plan_type,
    record.providerSpecificData?.chatgptPlanType,
    record.providerSpecificData?.chatgpt_plan_type,
    record.credentials?.plan_type,
    auth.chatgpt_plan_type,
    idAuth.chatgpt_plan_type,
  );
  const exportedAt = now.toISOString();
  const effectiveExpiresAt = forceRefreshAfterImport
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    : expiresAt;
  const expiresIn = getExpiresIn(effectiveExpiresAt, now);
  const sourceType = record.provider === 'codex' && record.authType === 'oauth'
    ? '9router'
    : 'chatgpt_web_session';
  const name = firstNonEmpty(email, sourceName, 'ChatGPT Account') || 'ChatGPT Account';
  const syntheticIdToken = inputIdToken
    ? undefined
    : buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt);
  const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);
  const dynamicPriority = getDynamicPriority(now);
  const sub2apiPriority = getSub2apiPriority(now);
  const accountOutputPriority = sub2apiAccountSettings?.priority === undefined
    ? sub2apiPriority
    : normalizeNonNegativeNumber(sub2apiAccountSettings.priority, sub2apiPriority, true);
  const accountOutputConcurrency = sub2apiAccountSettings?.concurrency === undefined
    ? 10
    : normalizeNonNegativeNumber(sub2apiAccountSettings.concurrency, 10, true);
  const accountRateMultiplier = sub2apiAccountSettings?.rateMultiplier === undefined
    ? undefined
    : normalizeNonNegativeNumber(sub2apiAccountSettings.rateMultiplier, 1);
  const modelMapping = buildModelMapping(sub2apiAccountSettings?.models);
  const importGroup = firstNonEmpty(sub2apiAccountSettings?.importGroup);
  const codexFingerprintMode = normalizeCodexFingerprintMode(
    sub2apiAccountSettings?.codexFingerprintMode,
  );

  const cpa = asOutputRecord(stripUnavailable({
    type: 'codex',
    email,
    name,
    priority: dynamicPriority,
    id_token: idToken,
    id_token_synthetic: Boolean(syntheticIdToken) || undefined,
    access_token: accessToken,
    refresh_token: refreshToken || '',
    session_token: sessionToken,
    last_refresh: exportedAt,
    expired: effectiveExpiresAt,
    note: normalizeDateOnly(now),
    disabled: Boolean(record.disabled) || undefined,
  }));

  const cockpit = asOutputRecord(stripUnavailable({
    type: 'codex',
    priority: dynamicPriority,
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken || '',
    account_id: accountId,
    last_refresh: exportedAt,
    email,
    expired: expiresAt,
    account_note: firstNonEmpty(record.account_note, record.accountInfo, record.account_info, record.note, record.notes, record.remark),
  }));

  const sub2apiAccount = asOutputRecord(stripUnavailable({
    name,
    platform: 'openai',
    type: 'oauth',
    group: importGroup,
    concurrency: accountOutputConcurrency,
    priority: accountOutputPriority,
    rate_multiplier: accountRateMultiplier,
    notes: normalizeDateOnly(now),
    credentials: {
      access_token: accessToken,
      account_id: accountId,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      email,
      expires_at: effectiveExpiresAt,
      expires_in: expiresIn,
      id_token: idToken,
      refresh_token: refreshToken,
      model_mapping: modelMapping,
    },
    extra: {
      email,
      email_key: toEmailKey(email),
      name,
      source: sourceType,
      last_refresh: exportedAt,
      codex_fingerprint_mode: codexFingerprintMode,
    },
  }));

  const createdAt = normalizeTimestamp(record.createdAt) || exportedAt;
  const updatedAt = normalizeTimestamp(record.updatedAt) || exportedAt;
  const nineRouter = asOutputRecord(stripUnavailable({
    accessToken,
    refreshToken,
    expiresAt,
    testStatus: firstNonEmpty(record.testStatus, record.test_status, 'active'),
    expiresIn,
    providerSpecificData: { chatgptAccountId: accountId, chatgptPlanType: planType },
    id: accountId,
    provider: 'codex',
    authType: 'oauth',
    name,
    email,
    priority: sub2apiPriority,
    isActive: typeof record.isActive === 'boolean' ? record.isActive : !Boolean(record.disabled),
    createdAt,
    updatedAt,
  }));

  const axonHubRefreshToken = refreshToken || AXONHUB_PLACEHOLDER_REFRESH_TOKEN;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const axonHub = asOutputRecord(stripUnavailable({
    auth_mode: 'chatgpt',
    priority: sub2apiPriority,
    last_refresh: Number.isNaN(expiresMs)
      ? exportedAt
      : new Date(expiresMs - 60 * 60 * 1000).toISOString(),
    tokens: {
      access_token: accessToken,
      refresh_token: axonHubRefreshToken,
      id_token: idToken,
    },
    axonhub_refresh_token_placeholder: refreshToken ? undefined : true,
    axonhub_note: refreshToken
      ? undefined
      : 'refresh_token is a placeholder; access_token works only until it expires.',
  }));

  const codexManager = asOutputRecord({
    sort: sub2apiPriority,
    priority: sub2apiPriority,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken || '',
      id_token: inputIdToken || '',
      ...(accountId ? { account_id: accountId } : {}),
      ...(chatgptAccountId ? { chatgpt_account_id: chatgptAccountId } : {}),
    },
    meta: asOutputRecord(stripUnavailable({
      label: name,
      workspace_id: workspaceId,
      chatgpt_account_id: chatgptAccountId,
      note: 'Imported from ChatGPT session',
    })),
  });

  return {
    sourceName,
    sourcePath,
    email,
    name,
    expiresAt,
    effectiveExpiresAt,
    priority: dynamicPriority,
    sub2apiPriority,
    accountOutputPriority,
    cpa,
    cockpit,
    nineRouter,
    axonHub,
    codexManager,
    sub2apiAccount,
  };
}

function buildOutputDocument(
  converted: ConvertedSession[],
  format: SessionOutputFormat,
  now: Date,
): unknown {
  if (format === 'sub2api') {
    return {
      exported_at: now.toISOString(),
      proxies: [],
      accounts: converted.map((item) => item.sub2apiAccount),
    };
  }
  const documents = converted.map((item) => {
    if (format === 'cpa') return item.cpa;
    if (format === 'cockpit') return item.cockpit;
    if (format === '9router') return item.nineRouter;
    if (format === 'axonhub') return item.axonHub;
    return item.codexManager;
  });
  return documents.length === 1 ? documents[0] : documents;
}

export function convertChatGptSessionSources(
  sources: SessionSourceDocument[],
  options: SessionConversionOptions = {},
): SessionConversionResult {
  const format = options.format || 'sub2api';
  const now = options.now || new Date();
  const issues: SessionConversionIssue[] = [];
  const candidates: SessionCandidate[] = [];

  for (const source of sources) {
    const parsed = parseSourceDocument(source);
    candidates.push(...parsed.candidates);
    issues.push(...parsed.issues);
    if (source.text.trim() && parsed.candidates.length === 0 && parsed.issues.length === 0) {
      issues.push({
        sourceName: source.sourceName,
        path: '$',
        reason: '未找到包含 accessToken 和账号标识的 Session 对象',
      });
    }
  }

  const converted: ConvertedSession[] = [];
  for (const candidate of candidates) {
    try {
      converted.push(convertSession(
        candidate.value,
        candidate.sourceName,
        candidate.path,
        now,
        Boolean(options.forceRefreshAfterImport),
        options.sub2apiAccountSettings,
      ));
    } catch (error) {
      issues.push({
        sourceName: candidate.sourceName,
        path: candidate.path,
        reason: error instanceof Error ? error.message : '无法转换',
      });
    }
  }

  const output = buildOutputDocument(converted, format, now);
  return {
    format,
    output,
    outputText: converted.length ? JSON.stringify(output, null, 2) : '',
    inputAccounts: candidates.length,
    outputAccounts: converted.length,
    converted,
    issues,
  };
}
