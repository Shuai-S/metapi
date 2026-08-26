import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  testConnection: vi.fn(),
  listGroups: vi.fn(),
  pushAccounts: vi.fn(),
}));

vi.mock('../../services/sub2apiPoolService.js', () => {
  class Sub2ApiPoolError extends Error {
    constructor(
      message: string,
      readonly httpStatus = 500,
      readonly code = 'SUB2API_POOL_ERROR',
    ) {
      super(message);
    }
  }
  return {
    Sub2ApiPoolError,
    sub2ApiPoolService: serviceMocks,
  };
});

describe('Sub2API pool routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    const { sub2ApiPoolRoutes } = await import('./sub2apiPool.js');
    await app.register(sub2ApiPoolRoutes);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects malformed config before calling the service', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/sub2api-pool/config',
      payload: { maxParallel: 20 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '推送并行数必须是 1 到 10 的整数',
    });
    expect(serviceMocks.saveConfig).not.toHaveBeenCalled();
  });

  it('returns discovered groups through the thin adapter', async () => {
    serviceMocks.listGroups.mockResolvedValue([{ id: 7, name: 'Codex 主池' }]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/sub2api-pool/groups',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ groups: [{ id: 7, name: 'Codex 主池' }] });
  });

  it('rejects an empty push batch before remote work starts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sub2api-pool/push',
      payload: { accounts: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(serviceMocks.pushAccounts).not.toHaveBeenCalled();
  });
});
