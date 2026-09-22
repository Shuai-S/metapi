import type { ProtocolLoginOAuthResult } from './types.js';

export type Sub2ApiV027ExportOptions = {
  name?: string;
  group?: string;
  concurrency?: number;
  priority?: number;
  rateMultiplier?: number;
  models?: string[];
  exportedAt?: Date;
};

export type Sub2ApiV027Account = {
  name: string;
  platform: 'openai';
  type: 'oauth';
  group?: string;
  concurrency: number;
  priority: number;
  rate_multiplier?: number;
  credentials: {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
    chatgpt_account_id?: string;
    email?: string;
    workspace_id?: string;
    expires_at?: string;
    model_mapping?: Record<string, string>;
  };
  extra: {
    email?: string;
    source: 'protocol_login';
    last_refresh: string;
    plan_type?: string;
  };
};

export type Sub2ApiV027ImportDocument = {
  exported_at: string;
  proxies: [];
  accounts: Sub2ApiV027Account[];
};

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function modelMapping(models: string[] | undefined): Record<string, string> | undefined {
  const normalized = Array.from(new Set((models || []).map((item) => item.trim()).filter(Boolean)));
  return normalized.length ? Object.fromEntries(normalized.map((model) => [model, model])) : undefined;
}

export function buildSub2ApiV027ImportDocument(
  result: ProtocolLoginOAuthResult,
  options: Sub2ApiV027ExportOptions = {},
): Sub2ApiV027ImportDocument {
  const accessToken = nonEmpty(result.accessToken);
  if (!accessToken) throw new Error('OAuth 结果缺少 access_token');

  const exportedAt = (options.exportedAt || new Date()).toISOString();
  const email = nonEmpty(result.email);
  const accountId = nonEmpty(result.accountId);
  const workspaceId = nonEmpty(result.workspaceId);
  const refreshToken = nonEmpty(result.refreshToken);
  const idToken = nonEmpty(result.idToken);
  const group = nonEmpty(options.group);
  const name = nonEmpty(options.name) || email || accountId || 'ChatGPT Account';
  const models = modelMapping(options.models);

  const credentials: Sub2ApiV027Account['credentials'] = {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(idToken ? { id_token: idToken } : {}),
    ...(accountId ? { account_id: accountId, chatgpt_account_id: accountId } : {}),
    ...(email ? { email } : {}),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(nonEmpty(result.expiresAt) ? { expires_at: nonEmpty(result.expiresAt) } : {}),
    ...(models ? { model_mapping: models } : {}),
  };

  const account: Sub2ApiV027Account = {
    name,
    platform: 'openai',
    type: 'oauth',
    ...(group ? { group } : {}),
    concurrency: positiveInteger(options.concurrency, 10),
    priority: positiveInteger(options.priority, 1),
    ...(nonNegativeNumber(options.rateMultiplier) !== undefined
      ? { rate_multiplier: nonNegativeNumber(options.rateMultiplier) }
      : {}),
    credentials,
    extra: {
      ...(email ? { email } : {}),
      source: 'protocol_login',
      last_refresh: exportedAt,
      ...(nonEmpty(result.planType) ? { plan_type: nonEmpty(result.planType) } : {}),
    },
  };

  return { exported_at: exportedAt, proxies: [], accounts: [account] };
}

export function renderSub2ApiV027ImportJson(
  result: ProtocolLoginOAuthResult,
  options: Sub2ApiV027ExportOptions = {},
): string {
  return JSON.stringify(buildSub2ApiV027ImportDocument(result, options), null, 2);
}

