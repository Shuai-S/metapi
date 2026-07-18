import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getAutoReloginConfig,
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
  resolvePlatformUserId,
  resolveProxyUrlFromExtraConfig,
} from './accountExtraConfig.js';
import {
  decryptAccountPassword,
  encryptAccountPassword,
} from './accountCredentialService.js';
import {
  ensureDefaultTokenForAccount,
  syncTokensFromUpstream,
} from './accountTokenService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { getAdapter } from './platforms/index.js';
import type { ApiTokenInfo } from './platforms/base.js';
import { withAccountProxyOverride } from './siteProxy.js';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;

type PasswordReloginFailureReason =
  | 'account_not_found'
  | 'credentials_unavailable'
  | 'password_decrypt_failed'
  | 'platform_unsupported'
  | 'login_failed';

export type AccountPasswordReloginResult =
  | {
      success: true;
      accountId: number;
      username: string;
      accessToken: string;
      preferredApiToken: string | null;
      apiTokens: ApiTokenInfo[];
      extraConfig: string | null;
      account: AccountRow | null;
    }
  | {
      success: false;
      accountId: number;
      reason: PasswordReloginFailureReason;
      message: string;
      shieldBlocked?: boolean;
    };

const reloginInFlight = new Map<number, Promise<AccountPasswordReloginResult>>();

function normalizeLoginFailure(message?: string | null): {
  message: string;
  shieldBlocked: boolean;
} {
  const raw = String(message || '').trim();
  const lowered = raw.toLowerCase();
  const shieldBlocked = (
    (lowered.includes('unexpected token')
      && lowered.includes('not valid json')
      && (lowered.includes('<html') || lowered.includes('<script')))
    || lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );

  if (shieldBlocked) {
    return {
      shieldBlocked: true,
      message: '站点登录被验证码或反爬验证拦截，请在目标站点手动登录后重新绑定 Session Token。',
    };
  }

  return {
    shieldBlocked: false,
    message: raw || '账号密码登录失败',
  };
}

async function loadAccountWithSite(accountId: number): Promise<{
  account: AccountRow;
  site: SiteRow;
} | null> {
  const row = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!row) return null;
  return { account: row.accounts, site: row.sites };
}

async function invalidateRoutingCache(): Promise<void> {
  try {
    const { invalidateTokenRouterCache } = await import('./tokenRouter.js');
    invalidateTokenRouterCache();
  } catch {}
}

async function executePasswordRelogin(input: {
  account: AccountRow;
  site: SiteRow;
  username: string;
  password: string;
  passwordCipher?: string | null;
}): Promise<AccountPasswordReloginResult> {
  const { account, site } = input;
  const adapter = getAdapter(site.platform);
  if (!adapter) {
    return {
      success: false,
      accountId: account.id,
      reason: 'platform_unsupported',
      message: `平台不支持账号密码登录: ${site.platform}`,
    };
  }

  let loginResult: Awaited<ReturnType<typeof adapter.login>>;
  try {
    loginResult = await withAccountProxyOverride(
      resolveProxyUrlFromExtraConfig(account.extraConfig),
      () => adapter.login(site.url, input.username, input.password),
    );
  } catch (error) {
    const normalized = normalizeLoginFailure(
      error instanceof Error ? error.message : String(error || ''),
    );
    return {
      success: false,
      accountId: account.id,
      reason: 'login_failed',
      message: normalized.message,
      shieldBlocked: normalized.shieldBlocked,
    };
  }

  const accessToken = String(loginResult.accessToken || '').trim();
  if (!loginResult.success || !accessToken) {
    const normalized = normalizeLoginFailure(loginResult.message);
    return {
      success: false,
      accountId: account.id,
      reason: 'login_failed',
      message: normalized.message,
      shieldBlocked: normalized.shieldBlocked,
    };
  }

  const username = String(loginResult.username || input.username).trim() || input.username;
  const platformUserId = (
    loginResult.platformUserId
    || resolvePlatformUserId(account.extraConfig, username)
    || guessPlatformUserIdFromUsername(username)
  );
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);
  let directApiToken: string | null = null;
  let apiTokens: ApiTokenInfo[] = [];

  try {
    directApiToken = await withAccountProxyOverride(
      accountProxyUrl,
      () => adapter.getApiToken(site.url, accessToken, platformUserId),
    );
  } catch {}
  try {
    const resolved = await withAccountProxyOverride(
      accountProxyUrl,
      () => adapter.getApiTokens(site.url, accessToken, platformUserId),
    );
    apiTokens = Array.isArray(resolved)
      ? resolved.filter((item) => typeof item?.key === 'string' && item.key.trim())
      : [];
  } catch {}

  const preferredApiToken = (
    apiTokens.find((item) => item.enabled !== false && item.key?.trim())?.key?.trim()
    || directApiToken?.trim()
    || null
  );
  const extraConfigPatch: Record<string, unknown> = {
    credentialMode: 'session',
    autoRelogin: {
      username,
      passwordCipher: input.passwordCipher || encryptAccountPassword(input.password),
      updatedAt: new Date().toISOString(),
    },
  };
  if (platformUserId) {
    extraConfigPatch.platformUserId = platformUserId;
  }
  if ((site.platform || '').toLowerCase() === 'sub2api') {
    extraConfigPatch.sub2apiAuth = loginResult.refreshToken
      ? {
          refreshToken: loginResult.refreshToken,
          ...(loginResult.tokenExpiresAt
            ? { tokenExpiresAt: Math.trunc(loginResult.tokenExpiresAt) }
            : {}),
        }
      : undefined;
  }

  const extraConfig = mergeAccountExtraConfig(account.extraConfig, extraConfigPatch);
  await db.update(schema.accounts)
    .set({
      accessToken,
      username,
      ...(preferredApiToken ? { apiToken: preferredApiToken } : {}),
      status: account.status === 'disabled' ? 'disabled' : 'active',
      extraConfig,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, account.id))
    .run();

  try {
    if (apiTokens.length > 0) {
      await syncTokensFromUpstream(account.id, apiTokens);
    } else if (preferredApiToken) {
      await ensureDefaultTokenForAccount(account.id, preferredApiToken, {
        name: 'default',
        source: 'password-relogin',
      });
    }
  } catch {}

  await invalidateRoutingCache();
  if (account.status !== 'disabled') {
    try {
      await setAccountRuntimeHealth(account.id, {
        state: 'healthy',
        reason: '账号密码自动重登录成功',
        source: 'password-relogin',
      });
    } catch {}
  }

  let latest: AccountRow | null = null;
  try {
    latest = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get() || null;
  } catch {}

  return {
    success: true,
    accountId: account.id,
    username,
    accessToken,
    preferredApiToken,
    apiTokens,
    extraConfig: latest?.extraConfig ?? extraConfig,
    account: latest ?? null,
  };
}

export async function reauthorizeAccountWithPassword(input: {
  accountId: number;
  username?: string | null;
  password?: string | null;
}): Promise<AccountPasswordReloginResult> {
  const loaded = await loadAccountWithSite(input.accountId);
  if (!loaded) {
    return {
      success: false,
      accountId: input.accountId,
      reason: 'account_not_found',
      message: '账号不存在',
    };
  }

  const stored = getAutoReloginConfig(loaded.account.extraConfig);
  const explicitPassword = typeof input.password === 'string' ? input.password : '';
  const hasExplicitPassword = explicitPassword.length > 0;
  const username = String(
    input.username || stored?.username || loaded.account.username || '',
  ).trim();
  if (!username) {
    return {
      success: false,
      accountId: loaded.account.id,
      reason: 'credentials_unavailable',
      message: '缺少登录账号',
    };
  }

  if (!hasExplicitPassword && stored?.username && username !== stored.username) {
    return {
      success: false,
      accountId: loaded.account.id,
      reason: 'credentials_unavailable',
      message: '登录账号已变更，请重新输入密码',
    };
  }

  const password = hasExplicitPassword
    ? explicitPassword
    : (stored ? decryptAccountPassword(stored.passwordCipher) : null);
  if (!password) {
    return {
      success: false,
      accountId: loaded.account.id,
      reason: stored ? 'password_decrypt_failed' : 'credentials_unavailable',
      message: stored
        ? '已保存密码无法解密，请重新输入密码并保存'
        : '没有可用的已保存密码，请输入账号密码',
    };
  }

  return executePasswordRelogin({
    ...loaded,
    username,
    password,
    passwordCipher: hasExplicitPassword ? null : stored?.passwordCipher,
  });
}

export async function autoReloginAccountWithStoredPasswordSingleflight(
  accountId: number,
): Promise<AccountPasswordReloginResult> {
  const existing = reloginInFlight.get(accountId);
  if (existing) return existing;

  const promise: Promise<AccountPasswordReloginResult> = reauthorizeAccountWithPassword({
    accountId,
  })
    .catch((error): AccountPasswordReloginResult => ({
      success: false,
      accountId,
      reason: 'login_failed',
      message: `账号密码自动重登录失败: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
    }))
    .finally(() => {
      reloginInFlight.delete(accountId);
    });
  reloginInFlight.set(accountId, promise);
  return promise;
}

export function __resetAccountPasswordReloginSingleflightForTests(): void {
  reloginInFlight.clear();
}
