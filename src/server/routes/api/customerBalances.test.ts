import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const upstreamFetchMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => upstreamFetchMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonResponseWithHeaders(payload: unknown, headers: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('customer balance routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'] | undefined;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-customer-balances-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./customerBalances.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    app = Fastify();
    await app.register(routesModule.customerBalanceRoutes);
  });

  beforeEach(async () => {
    upstreamFetchMock.mockReset();
    await db.delete(schema.customerBalanceSnapshotUsers).run();
    await db.delete(schema.customerBalanceSnapshots).run();
    await db.delete(schema.customerBalanceSiteAccounts).run();
    await db.delete(schema.events).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (typeof closeDbConnections === 'function') {
      await closeDbConnections();
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    delete process.env.DATA_DIR;
  });

  it('lists supported customer balance sites through platform aliases', async () => {
    await db.insert(schema.sites).values([
      { name: 'NewAPI Alias', url: 'https://alias.example.com', platform: 'newapi' },
      { name: 'Sub2API', url: 'https://sub2api.example.com', platform: 'sub2api' },
      { name: 'One API', url: 'https://oneapi.example.com', platform: 'one-api' },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/customer-balances/sites',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sites).toEqual([
      expect.objectContaining({ name: 'NewAPI Alias', platform: 'new-api' }),
      expect.objectContaining({ name: 'Sub2API', platform: 'sub2api' }),
    ]);
  });

  it('syncs New API customer balances through an admin site account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'New API',
      url: 'https://newapi.example.com',
      platform: 'new-api',
    }).returning().get();

    upstreamFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/user/login')) {
        return jsonResponse({
          success: true,
          data: 'admin-access-token',
        });
      }
      if (url.endsWith('/api/user/self')) {
        return jsonResponse({
          success: true,
          data: { id: 10, username: 'admin', role: 10 },
        });
      }
      if (url.includes('/api/user/?')) {
        return jsonResponse({
          success: true,
          data: {
            total: 2,
            items: [
              { id: 1, username: 'alice', quota: 1_000_000, used_quota: 500_000, status: 1, group: 'default' },
              { id: 2, username: 'bob', quota: 0, used_quota: 250_000, status: 2, group: 'trial' },
            ],
          },
        });
      }
      return jsonResponse({ success: false, message: `unexpected ${url}` }, 404);
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/customer-balances/accounts',
      payload: {
        siteId: site.id,
        username: 'admin',
        password: 'secret',
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const accountId = createResponse.json().account.id;

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/customer-balances/accounts/${accountId}/sync`,
    });

    expect(syncResponse.statusCode).toBe(200);
    expect(syncResponse.json().snapshot).toMatchObject({
      totalUsers: 2,
      activeUsers: 1,
      totalBalance: 2,
      lowBalanceUsers: 1,
      zeroBalanceUsers: 1,
    });
    expect(syncResponse.json().users.map((user: { username: string; balance: number; used: number }) => user))
      .toEqual([
        expect.objectContaining({ username: 'bob', balance: 0, used: 0.5 }),
        expect.objectContaining({ username: 'alice', balance: 2, used: 1 }),
      ]);
  });

  it('uses the New API login user id as the required New-Api-User admin header', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'QuantumNous New API',
      url: 'https://newapi.example.com',
      platform: 'newapi',
    }).returning().get();
    const userRequests: Array<{ url: string; newApiUser: string | null; authorization: string | null; cookie: string | null }> = [];

    upstreamFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url.endsWith('/api/user/login')) {
        return jsonResponseWithHeaders({
          success: true,
          data: { id: 10, username: 'admin', role: 10, status: 1, group: 'default' },
        }, {
          'set-cookie': 'session=session-cookie-value; Path=/; HttpOnly',
        });
      }
      if (url.endsWith('/api/user/self')) {
        return jsonResponse({ success: false, message: 'Unauthorized, New-Api-User header not provided' }, 401);
      }
      if (url.includes('/api/user/?')) {
        userRequests.push({
          url,
          newApiUser: headers.get('New-Api-User'),
          authorization: headers.get('Authorization'),
          cookie: headers.get('Cookie'),
        });
        if (headers.get('New-Api-User') !== '10') {
          return jsonResponse({ success: false, message: 'Unauthorized, New-Api-User header not provided' }, 401);
        }
        return jsonResponse({
          success: true,
          data: {
            total: 1,
            items: [
              { id: 3, username: 'carol', quota: 3_000_000, used_quota: 0, status: 1, group: 'default' },
            ],
          },
        });
      }
      return jsonResponse({ success: false, message: `unexpected ${url}` }, 404);
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/customer-balances/accounts',
      payload: {
        siteId: site.id,
        username: 'admin',
        password: 'secret',
      },
    });
    expect(createResponse.statusCode).toBe(200);

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/customer-balances/accounts/${createResponse.json().account.id}/sync`,
    });

    const account = await db.select()
      .from(schema.customerBalanceSiteAccounts)
      .where(eq(schema.customerBalanceSiteAccounts.id, createResponse.json().account.id))
      .get();
    expect(syncResponse.statusCode, JSON.stringify({
      response: syncResponse.json(),
      userRequests,
      platformUserId: account?.platformUserId,
    })).toBe(200);
    expect(syncResponse.json().snapshot).toMatchObject({
      totalUsers: 1,
      activeUsers: 1,
      totalBalance: 6,
    });
    expect(userRequests).toEqual([
      expect.objectContaining({
        newApiUser: '10',
        cookie: expect.stringContaining('session=session-cookie-value'),
      }),
    ]);
    expect(account?.platformUserId).toBe('10');
  });

  it('syncs Sub2API customer balances', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub2API',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();

    upstreamFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          code: 0,
          data: {
            access_token: 'sub-admin-token',
            user: { username: 'admin', email: 'admin@example.com' },
          },
        });
      }
      if (url.includes('/api/v1/admin/users?')) {
        return jsonResponse({
          code: 0,
          data: {
            total: 1,
            items: [
              { id: 7, email: 'carol@example.com', username: 'carol', role: 'user', status: 'active', balance: 12.5 },
            ],
          },
        });
      }
      return jsonResponse({ code: 1, message: `unexpected ${url}` }, 404);
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/customer-balances/accounts',
      payload: {
        siteId: site.id,
        username: 'admin@example.com',
        password: 'secret',
      },
    });
    expect(createResponse.statusCode).toBe(200);

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/customer-balances/accounts/${createResponse.json().account.id}/sync`,
    });

    expect(syncResponse.statusCode).toBe(200);
    expect(syncResponse.json().snapshot).toMatchObject({
      totalUsers: 1,
      activeUsers: 1,
      totalBalance: 12.5,
      lowBalanceUsers: 0,
    });
    expect(syncResponse.json().users).toEqual([
      expect.objectContaining({ email: 'carol@example.com', balance: 12.5 }),
    ]);
  });
});
