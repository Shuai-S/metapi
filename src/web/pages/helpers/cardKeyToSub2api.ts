export type ConversionIssue = {
  line: number;
  message: string;
};

export type CardKeyConversionResult = {
  output: Record<string, unknown>;
  inputAccounts: number;
  outputAccounts: number;
  duplicateAccounts: number;
  issues: ConversionIssue[];
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export function extractJwtClientId(accessToken: unknown): string {
  if (typeof accessToken !== 'string') return '';
  const parts = accessToken.split('.');
  if (parts.length !== 3) return '';
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return typeof payload?.client_id === 'string' ? payload.client_id : '';
  } catch {
    return '';
  }
}

function resolveExpiresAt(account: Record<string, any>, credentials: Record<string, any>): number {
  if (typeof account.expires_at === 'number' && Number.isFinite(account.expires_at)) {
    return Math.trunc(account.expires_at);
  }
  if (typeof credentials.expires_at === 'number' && Number.isFinite(credentials.expires_at)) {
    return Math.trunc(credentials.expires_at);
  }
  if (typeof credentials.expires_at === 'string') {
    const timestamp = Date.parse(credentials.expires_at);
    if (Number.isFinite(timestamp)) return Math.floor(timestamp / 1000);
  }
  return 0;
}

function convertAccount(rawAccount: unknown, line: number, issues: ConversionIssue[]) {
  const account = asRecord(rawAccount);
  const credentials = asRecord(account.credentials);
  const extra = asRecord(account.extra);
  const accessToken = typeof credentials.access_token === 'string' ? credentials.access_token : '';
  const clientId = extractJwtClientId(accessToken);
  if (accessToken && !clientId) issues.push({ line, message: 'access_token 无法解析 client_id，已留空' });
  const email = typeof credentials.email === 'string' && credentials.email
    ? credentials.email
    : (typeof extra.email === 'string' ? extra.email : '');
  const name = typeof account.name === 'string' ? account.name : '';

  return {
    auto_pause_on_expired: typeof account.auto_pause_on_expired === 'boolean' ? account.auto_pause_on_expired : true,
    concurrency: typeof account.concurrency === 'number' ? account.concurrency : 10,
    credentials: {
      access_token: accessToken,
      chatgpt_account_id: typeof credentials.chatgpt_account_id === 'string' ? credentials.chatgpt_account_id : '',
      chatgpt_user_id: typeof credentials.chatgpt_user_id === 'string' ? credentials.chatgpt_user_id : '',
      client_id: clientId,
      email,
      expires_at: resolveExpiresAt(account, credentials),
      expires_in: typeof credentials.expires_in === 'number' ? credentials.expires_in : 0,
      id_token: '',
      organization_id: '',
      plan_type: typeof credentials.plan_type === 'string' ? credentials.plan_type : '',
      refresh_token: '',
    },
    extra: {
      ...extra,
      email,
      last_refresh: typeof extra.last_refresh === 'string' ? extra.last_refresh : '',
      name,
      auth_provider: typeof extra.auth_provider === 'string' ? extra.auth_provider : 'openai',
      source: typeof extra.source === 'string' ? extra.source : 'chatgpt_web_session',
      email_key: typeof extra.email_key === 'string' ? extra.email_key : '',
    },
    name,
    platform: typeof account.platform === 'string' ? account.platform : 'openai',
    priority: typeof account.priority === 'number' ? account.priority : 1,
    rate_multiplier: 1,
    type: typeof account.type === 'string' ? account.type : 'oauth',
  };
}

export function convertCardKeyExport(raw: string, strict = false): CardKeyConversionResult {
  const issues: ConversionIssue[] = [];
  const converted: Array<{ account: ReturnType<typeof convertAccount>; line: number }> = [];
  let latestExportedAt = '';
  let proxies: unknown[] = [];

  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((sourceLine, index) => {
    const line = index + 1;
    const text = sourceLine.trim();
    if (!text || text === '卡密导出') return;
    try {
      const row = asRecord(JSON.parse(text));
      if (typeof row.exported_at === 'string' && row.exported_at > latestExportedAt) latestExportedAt = row.exported_at;
      if (Array.isArray(row.proxies) && row.proxies.length > 0) proxies = row.proxies;
      if (!Array.isArray(row.accounts)) throw new Error('缺少 accounts 数组');
      row.accounts.forEach((account: unknown) => converted.push({ account: convertAccount(account, line, issues), line }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'JSON 解析失败';
      issues.push({ line, message });
      if (strict) throw new Error(`第 ${line} 行：${message}`);
    }
  });

  const lastIndexByKey = new Map<string, number>();
  converted.forEach(({ account }, index) => {
    const credentials = account.credentials;
    const key = credentials.chatgpt_user_id || credentials.email || account.credentials.access_token;
    if (key) lastIndexByKey.set(key, index);
  });
  const accounts = converted.filter(({ account, line }, index) => {
    const credentials = account.credentials;
    const key = credentials.chatgpt_user_id || credentials.email || credentials.access_token;
    const keep = !key || lastIndexByKey.get(key) === index;
    if (!keep) issues.push({ line, message: '检测到重复账号，已保留最后出现的一条' });
    return keep;
  }).map(({ account }) => account);

  return {
    output: {
      accounts,
      exported_at: latestExportedAt || new Date().toISOString(),
      format: 'sub2api',
      proxies,
      token_kind: 'workspace',
      workspace_id: '',
    },
    inputAccounts: converted.length,
    outputAccounts: accounts.length,
    duplicateAccounts: converted.length - accounts.length,
    issues,
  };
}
