import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import {
  clearCustomerBalanceSnapshots,
  deleteCustomerBalanceSiteAccount,
  getCustomerBalanceSnapshotDetail,
  getCustomerBalanceSnapshots,
  listCustomerBalanceSiteAccounts,
  resolveCustomerBalanceSiteOptions,
  syncCustomerBalanceSiteAccount,
  upsertCustomerBalanceSiteAccount,
} from '../../services/customerBalanceService.js';

function parsePositiveId(input: unknown): number | null {
  const parsed = Number.parseInt(String(input ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败';
}

export async function customerBalanceRoutes(app: FastifyInstance) {
  app.get('/api/customer-balances/sites', async () => ({
    sites: await resolveCustomerBalanceSiteOptions(),
  }));

  app.get('/api/customer-balances/accounts', async () => ({
    accounts: await listCustomerBalanceSiteAccounts(),
  }));

  app.post<{
    Body: {
      siteId?: number | string;
      username?: string;
      password?: string;
    };
  }>('/api/customer-balances/accounts', async (request, reply) => {
    const siteId = parsePositiveId(request.body?.siteId);
    if (!siteId) {
      return reply.code(400).send({ success: false, message: '请选择站点' });
    }
    try {
      const account = await upsertCustomerBalanceSiteAccount({
        siteId,
        username: String(request.body?.username || ''),
        password: String(request.body?.password || ''),
      });
      return { success: true, account };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/customer-balances/accounts/:id', async (request, reply) => {
    const id = parsePositiveId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }
    await deleteCustomerBalanceSiteAccount(id);
    return { success: true };
  });

  app.post<{ Params: { id: string } }>('/api/customer-balances/accounts/:id/sync', async (request, reply) => {
    const id = parsePositiveId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }
    try {
      const result = await syncCustomerBalanceSiteAccount(id);
      try {
        await db.insert(schema.events).values({
          type: 'balance',
          title: '客户余额已同步',
          message: `已同步 ${result.snapshot.totalUsers} 个客户，余额合计 $${result.snapshot.totalBalance.toFixed(2)}`,
          level: 'info',
          relatedId: id,
          relatedType: 'customer_balance_site_account',
          createdAt: formatUtcSqlDateTime(new Date()),
        }).run();
      } catch {}
      return { success: true, ...result };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { siteAccountId?: string } }>('/api/customer-balances/snapshots', async (request) => {
    const siteAccountId = parsePositiveId(request.query.siteAccountId);
    return {
      snapshots: await getCustomerBalanceSnapshots(siteAccountId || undefined),
    };
  });

  app.get<{
    Params: { id: string };
    Querystring: {
      search?: string;
      status?: string;
      balance?: string;
    };
  }>('/api/customer-balances/snapshots/:id', async (request, reply) => {
    const id = parsePositiveId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: '快照 ID 无效' });
    }
    const detail = await getCustomerBalanceSnapshotDetail(id, {
      search: request.query.search,
      status: request.query.status,
      balance: request.query.balance,
    });
    if (!detail.snapshot) {
      return reply.code(404).send({ success: false, message: '快照不存在' });
    }
    return detail;
  });

  app.delete<{ Params: { id: string } }>('/api/customer-balances/accounts/:id/snapshots', async (request, reply) => {
    const id = parsePositiveId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }
    await clearCustomerBalanceSnapshots(id);
    return { success: true };
  });
}
