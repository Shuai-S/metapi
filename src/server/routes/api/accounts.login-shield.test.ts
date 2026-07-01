import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: 'sub2api',
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts login shield detection', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-shield-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    loginMock.mockReset();
    getApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    convergeAccountMutationMock.mockReset();
    getApiTokenMock.mockResolvedValue(null);
    getApiTokensMock.mockResolvedValue([]);
    convergeAccountMutationMock.mockResolvedValue(undefined);
    resetRequestRateLimitStore();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns shieldBlocked when login fails with html-json parse syntax error', async () => {
    loginMock.mockResolvedValueOnce({
      success: false,
      message: "Unexpected token '<', \"<html><scr\"... is not valid JSON",
    });

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteId: site.id,
        username: 'demo-user',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success?: boolean; shieldBlocked?: boolean; message?: string };
    expect(body.success).toBe(false);
    expect(body.shieldBlocked).toBe(true);
    expect((body.message || '').toLowerCase()).toContain('shield');
    expect(body.message || '').not.toContain('Unexpected token');
  });

  it('rate limits repeated login attempts from the same client ip', async () => {
    loginMock.mockResolvedValue({
      success: false,
      message: 'invalid credentials',
    });

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/accounts/login',
        remoteAddress: '198.51.100.10',
        payload: {
          siteId: site.id,
          username: 'demo-user',
          password: 'demo-password',
        },
      });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      remoteAddress: '198.51.100.10',
      payload: {
        siteId: site.id,
        username: 'demo-user',
        password: 'demo-password',
      },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      success: false,
      message: '请求过于频繁，请稍后再试',
    });
  });

  it('rejects malformed login payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteId: '1',
        username: 'demo-user',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid siteId. Expected positive number.',
    });
  });

  it('stores managed sub2api refresh metadata returned by password login', async () => {
    loginMock.mockResolvedValueOnce({
      success: true,
      accessToken: 'sub2-access-token',
      refreshToken: 'sub2-refresh-token',
      tokenExpiresAt: 1760000000000,
      username: 'sub2@example.com',
    });
    getApiTokenMock.mockResolvedValueOnce('sk-sub2-managed');
    getApiTokensMock.mockResolvedValueOnce([
      { name: 'default', key: 'sk-sub2-managed', enabled: true },
    ]);

    const site = await db.insert(schema.sites).values({
      name: 'Sub2API',
      url: 'https://sub2.example.com',
      platform: 'sub2api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: {
        siteId: site.id,
        username: 'sub2@example.com',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      apiTokenFound: true,
      tokenCount: 1,
    });

    const account = await db.select().from(schema.accounts).get();
    expect(account?.accessToken).toBe('sub2-access-token');
    expect(account?.apiToken).toBe('sk-sub2-managed');
    const parsedExtra = JSON.parse(account?.extraConfig || '{}') as {
      credentialMode?: string;
      autoRelogin?: { username?: string; passwordCipher?: string };
      sub2apiAuth?: { refreshToken?: string; tokenExpiresAt?: number };
    };
    expect(parsedExtra.credentialMode).toBe('session');
    expect(parsedExtra.autoRelogin?.username).toBe('sub2@example.com');
    expect(parsedExtra.autoRelogin?.passwordCipher).toBeTruthy();
    expect(parsedExtra.sub2apiAuth).toEqual({
      refreshToken: 'sub2-refresh-token',
      tokenExpiresAt: 1760000000000,
    });
    expect(convergeAccountMutationMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: account?.id,
      preferredApiToken: 'sk-sub2-managed',
      upstreamTokens: [{ name: 'default', key: 'sk-sub2-managed', enabled: true }],
    }));
  });
});
