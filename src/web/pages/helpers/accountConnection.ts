export type AccountCredentialMode = 'session' | 'apikey';
export type AccountConnectionDisplayType = AccountCredentialMode | 'password';

export type AccountConnectionDisplay = {
  type: AccountConnectionDisplayType;
  label: string;
  badgeClass: string;
  searchText: string;
};

function parseAccountExtraConfig(account: any): Record<string, any> {
  const extraConfig = account?.extraConfig;
  if (!extraConfig) return {};
  if (typeof extraConfig === 'object' && !Array.isArray(extraConfig)) {
    return extraConfig;
  }
  if (typeof extraConfig !== 'string') return {};
  try {
    const parsed = JSON.parse(extraConfig);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function hasPasswordReloginConfig(account: any): boolean {
  const relogin = parseAccountExtraConfig(account)?.autoRelogin;
  if (!relogin || typeof relogin !== 'object' || Array.isArray(relogin)) {
    return false;
  }
  const username = typeof relogin.username === 'string' ? relogin.username.trim() : '';
  const passwordCipher = typeof relogin.passwordCipher === 'string'
    ? relogin.passwordCipher.trim()
    : '';
  return !!username && !!passwordCipher;
}

export function resolveAccountCredentialMode(account: any): AccountCredentialMode {
  const rawMode = String(account?.credentialMode || '').trim().toLowerCase();
  if (rawMode === 'apikey') return 'apikey';
  if (rawMode === 'session') return 'session';
  if (typeof account?.capabilities?.proxyOnly === 'boolean') {
    return account.capabilities.proxyOnly ? 'apikey' : 'session';
  }
  return typeof account?.accessToken === 'string' && account.accessToken.trim()
    ? 'session'
    : 'apikey';
}

export function resolveAccountConnectionDisplay(account: any): AccountConnectionDisplay {
  const credentialMode = resolveAccountCredentialMode(account);
  if (credentialMode === 'apikey') {
    return {
      type: 'apikey',
      label: 'API Token',
      badgeClass: 'badge-warning',
      searchText: 'apitoken api token API Token api key API Key 模型调用凭证 API Token连接',
    };
  }
  if (hasPasswordReloginConfig(account)) {
    return {
      type: 'password',
      label: 'Password',
      badgeClass: 'badge-success',
      searchText: 'password Password 密码 账号密码 登录添加 Password连接',
    };
  }
  return {
    type: 'session',
    label: 'Session Token',
    badgeClass: 'badge-info',
    searchText: 'session Session Session Token Session连接 access token Access Token 系统访问令牌 cookie',
  };
}

export function parsePositiveInt(input: string | null): number {
  const normalized = String(input || '').trim();
  if (!/^\d+$/.test(normalized)) return 0;
  const value = Number.parseInt(normalized, 10);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

export function isTruthyFlag(input: string | null): boolean {
  if (!input) return false;
  const normalized = input.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
