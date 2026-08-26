import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  parseSub2ApiPoolConfigPayload,
  parseSub2ApiPoolPushPayload,
} from '../../contracts/sub2apiPoolPayloads.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import {
  Sub2ApiPoolError,
  sub2ApiPoolService,
} from '../../services/sub2apiPoolService.js';

const limitConfigRead = createRateLimitGuard({
  bucket: 'sub2api-pool-config-read',
  max: 60,
  windowMs: 60_000,
});

const limitConfigWrite = createRateLimitGuard({
  bucket: 'sub2api-pool-config-write',
  max: 20,
  windowMs: 60_000,
});

const limitRemoteRead = createRateLimitGuard({
  bucket: 'sub2api-pool-remote-read',
  max: 30,
  windowMs: 60_000,
});

const limitPush = createRateLimitGuard({
  bucket: 'sub2api-pool-push',
  max: 10,
  windowMs: 60_000,
});

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof Sub2ApiPoolError) {
    return reply.code(error.httpStatus).send({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  return reply.code(500).send({
    success: false,
    code: 'SUB2API_POOL_ERROR',
    message: error instanceof Error ? error.message : 'Sub2API 号池操作失败',
  });
}

export async function sub2ApiPoolRoutes(app: FastifyInstance) {
  app.get('/api/sub2api-pool/config', { preHandler: [limitConfigRead] }, async (_, reply) => {
    try {
      return await sub2ApiPoolService.getConfig();
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.put<{ Body: unknown }>(
    '/api/sub2api-pool/config',
    { preHandler: [limitConfigWrite] },
    async (request, reply) => {
      const parsed = parseSub2ApiPoolConfigPayload(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, message: parsed.error });
      }
      try {
        return await sub2ApiPoolService.saveConfig(parsed.data);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post('/api/sub2api-pool/test', { preHandler: [limitRemoteRead] }, async (_, reply) => {
    try {
      return await sub2ApiPoolService.testConnection();
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get('/api/sub2api-pool/groups', { preHandler: [limitRemoteRead] }, async (_, reply) => {
    try {
      return { groups: await sub2ApiPoolService.listGroups() };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(
    '/api/sub2api-pool/push',
    { preHandler: [limitPush] },
    async (request, reply) => {
      const parsed = parseSub2ApiPoolPushPayload(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, message: parsed.error });
      }
      try {
        return await sub2ApiPoolService.pushAccounts(parsed.data.accounts);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );
}
