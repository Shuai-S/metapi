import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {},
  schema: { settings: { key: 'key', value: 'value' } },
}));

vi.mock('../db/upsertSetting.js', () => ({
  upsertSetting: vi.fn(),
}));

import {
  buildSub2ApiPushReference,
  createSub2ApiPoolService,
} from './sub2apiPoolService.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function account(name: string, email: string) {
  return {
    name,
    platform: 'openai',
    type: 'oauth',
    group: 'must-not-be-forwarded',
    notes: 'must-not-be-forwarded',
    concurrency: 8,
    priority: 2,
    rate_multiplier: 0.5,
    credentials: {
      access_token: `access-${email}`,
      refresh_token: `refresh-${email}`,
      email,
      model_mapping: { 'gpt-5': 'gpt-5' },
      untrusted_field: 'must-not-be-forwarded',
    },
    extra: {
      email,
      codex_fingerprint_mode: 'session',
      codex_fingerprint_seed: 'must-not-be-forwarded',
      untrusted_field: 'must-not-be-forwarded',
    },
  };
}

function scopedAccount(name: string, email: string, userId: string) {
  const value = account(name, email);
  return {
    ...value,
    credentials: {
      ...value.credentials,
      chatgpt_account_id: 'shared-workspace',
      chatgpt_user_id: userId,
    },
  };
}

function legacyReference(value: ReturnType<typeof scopedAccount>): string {
  const identity = {
    platform: 'openai',
    type: 'oauth',
    accountId: value.credentials.chatgpt_account_id,
  };
  return `metapi:v1:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

describe('sub2apiPoolService', () => {
  it('uses the workspace and user together for stable push references', () => {
    const first = scopedAccount('first@example.com', 'first@example.com', 'user-1');
    const second = scopedAccount('second@example.com', 'second@example.com', 'user-2');
    const refreshed = {
      ...first,
      credentials: {
        ...first.credentials,
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      },
    };

    expect(buildSub2ApiPushReference(first)).toMatch(/^metapi:v2:[a-f0-9]{64}$/);
    expect(buildSub2ApiPushReference(first)).not.toBe(buildSub2ApiPushReference(second));
    expect(buildSub2ApiPushReference(first)).toBe(buildSub2ApiPushReference(refreshed));
  });

  it('encrypts the admin key and returns only a masked value', async () => {
    let stored: unknown = null;
    const service = createSub2ApiPoolService({
      readSetting: async () => stored,
      writeSetting: async (value) => {
        stored = value;
      },
    });

    const config = await service.saveConfig({
      baseUrl: 'https://pool.example.com/api/v1/',
      adminApiKey: 'admin-secret-123456',
      groupIds: [9, 9, 12],
      maxParallel: 4,
    });

    expect(config).toEqual({
      baseUrl: 'https://pool.example.com',
      adminApiKeyConfigured: true,
      adminApiKeyMasked: 'admi****3456',
      groupIds: [9, 12],
      maxParallel: 4,
    });
    expect(JSON.stringify(stored)).not.toContain('admin-secret-123456');
    expect(stored).toMatchObject({
      version: 1,
      encryptedAdminApiKey: expect.stringMatching(/^v1:/),
    });
  });

  it('uses the admin key for group discovery', async () => {
    let stored: unknown = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('admin-key-value');
      return jsonResponse({
        code: 0,
        data: [
          { id: 7, name: 'Codex 主池', platform: 'openai', status: 'active' },
        ],
      });
    });
    const service = createSub2ApiPoolService({
      fetchImpl: fetchImpl as never,
      readSetting: async () => stored,
      writeSetting: async (value) => {
        stored = value;
      },
    });
    await service.saveConfig({
      baseUrl: 'https://pool.example.com',
      adminApiKey: 'admin-key-value',
    });

    await expect(service.listGroups()).resolves.toEqual([
      { id: 7, name: 'Codex 主池', platform: 'openai', status: 'active' },
    ]);
  });

  it('skips remote and in-batch duplicates and allowlists create fields', async () => {
    let stored: unknown = null;
    let ledger: unknown = null;
    const existing = account('existing@example.com', 'existing@example.com');
    const fresh = account('fresh@example.com', 'fresh@example.com');
    const existingRef = buildSub2ApiPushReference(existing);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/api/v1/admin/accounts?')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{ id: 4, extra: { metapi_push_ref: existingRef } }],
            total: 1,
          },
        });
      }
      if (url.endsWith('/api/v1/admin/accounts') && init?.method === 'POST') {
        return jsonResponse({ code: 0, data: { id: 99 } });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
    const service = createSub2ApiPoolService({
      fetchImpl: fetchImpl as never,
      readSetting: async () => stored,
      writeSetting: async (value) => {
        stored = value;
      },
      readPushLedger: async () => ledger,
      writePushLedger: async (value) => {
        ledger = value;
      },
    });
    await service.saveConfig({
      baseUrl: 'https://pool.example.com',
      adminApiKey: 'admin-key-value',
      groupIds: [7],
      maxParallel: 2,
    });

    const result = await service.pushAccounts([
      existing,
      fresh,
      { ...fresh },
      { name: 'broken', credentials: {} },
    ]);

    expect(result).toMatchObject({ total: 4, created: 1, skipped: 2, failed: 1 });
    expect(result.items.map((item) => item.status)).toEqual([
      'skipped',
      'created',
      'skipped',
      'failed',
    ]);

    const createCall = calls.find((call) => (
      call.url.endsWith('/api/v1/admin/accounts') && call.init?.method === 'POST'
    ));
    expect(createCall).toBeTruthy();
    const headers = new Headers(createCall?.init?.headers);
    expect(headers.get('x-api-key')).toBe('admin-key-value');
    expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9]{64}$/);

    const payload = JSON.parse(String(createCall?.init?.body));
    expect(payload).toMatchObject({
      name: 'fresh@example.com',
      platform: 'openai',
      type: 'oauth',
      group_ids: [7],
      concurrency: 8,
      priority: 2,
      rate_multiplier: 0.5,
      extra: {
        metapi_push_ref: buildSub2ApiPushReference(fresh),
        codex_fingerprint_mode: 'session',
      },
    });
    expect(payload).not.toHaveProperty('group');
    expect(payload).not.toHaveProperty('notes');
    expect(payload.credentials).not.toHaveProperty('untrusted_field');
    expect(payload.extra).not.toHaveProperty('codex_fingerprint_seed');
    expect(payload.extra).not.toHaveProperty('untrusted_field');

    const repeated = await service.pushAccounts([fresh]);
    expect(repeated).toMatchObject({ total: 1, created: 0, skipped: 1, failed: 0 });
    expect(calls.filter((call) => (
      call.url.endsWith('/api/v1/admin/accounts') && call.init?.method === 'POST'
    ))).toHaveLength(1);
  });

  it('migrates a matching legacy reference without collapsing users in one workspace', async () => {
    let stored: unknown = null;
    let ledger: unknown = null;
    const first = scopedAccount('first@example.com', 'first@example.com', 'user-1');
    const second = scopedAccount('second@example.com', 'second@example.com', 'user-2');
    const third = scopedAccount('third@example.com', 'third@example.com', 'user-3');
    const createBodies: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/admin/accounts?')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{
              id: 4,
              name: first.name,
              extra: {
                email: first.credentials.email,
                metapi_push_ref: legacyReference(first),
              },
            }],
            total: 1,
          },
        });
      }
      if (url.endsWith('/api/v1/admin/accounts') && init?.method === 'POST') {
        createBodies.push(JSON.parse(String(init.body)));
        return jsonResponse({ code: 0, data: { id: 100 + createBodies.length } });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
    const service = createSub2ApiPoolService({
      fetchImpl: fetchImpl as never,
      readSetting: async () => stored,
      writeSetting: async (value) => {
        stored = value;
      },
      readPushLedger: async () => ledger,
      writePushLedger: async (value) => {
        ledger = value;
      },
    });
    await service.saveConfig({
      baseUrl: 'https://pool.example.com',
      adminApiKey: 'admin-key-value',
      groupIds: [7],
      maxParallel: 2,
    });

    const result = await service.pushAccounts([first, second, third]);

    expect(result).toMatchObject({ total: 3, created: 2, skipped: 1, failed: 0 });
    expect(result.items.map((item) => item.status)).toEqual(['skipped', 'created', 'created']);
    expect(createBodies.map((body) => body.name)).toEqual([second.name, third.name]);
    const targetRefs = Object.values((ledger as any).targets)[0] as string[];
    expect(targetRefs).toEqual(expect.arrayContaining([
      buildSub2ApiPushReference(first),
      buildSub2ApiPushReference(second),
      buildSub2ApiPushReference(third),
    ]));

    await expect(service.pushAccounts([first, second, third])).resolves.toMatchObject({
      total: 3,
      created: 0,
      skipped: 3,
      failed: 0,
    });
    expect(createBodies).toHaveLength(2);
  });
});
