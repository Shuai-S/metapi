import { z } from 'zod';

const configPayloadSchema = z.object({
  baseUrl: z.string().max(2048).optional(),
  adminApiKey: z.string().max(4096).optional(),
  clearAdminApiKey: z.boolean().optional(),
  groupIds: z.array(z.number().int().positive()).max(100).optional(),
  maxParallel: z.number().int().min(1).max(10).optional(),
}).strict();

const pushPayloadSchema = z.object({
  accounts: z.array(z.object({}).passthrough()).min(1).max(500),
}).strict();

export type Sub2ApiPoolConfigPayload = z.output<typeof configPayloadSchema>;
export type Sub2ApiPoolPushPayload = z.output<typeof pushPayloadSchema>;

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function formatError(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = String(issue?.path[0] || 'body');
  const messages: Record<string, string> = {
    baseUrl: 'Sub2API 地址格式无效',
    adminApiKey: '管理员 API Key 格式无效',
    clearAdminApiKey: '清除密钥标记格式无效',
    groupIds: '分组 ID 必须是正整数数组，且最多 100 个',
    maxParallel: '推送并行数必须是 1 到 10 的整数',
    accounts: '账号列表不能为空，且单次最多推送 500 个账号',
    body: '请求体必须是对象',
  };
  return messages[field] || '请求参数格式无效';
}

function parse<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (!result.success) return { success: false, error: formatError(result.error) };
  return { success: true, data: result.data };
}

export function parseSub2ApiPoolConfigPayload(input: unknown): ParseResult<Sub2ApiPoolConfigPayload> {
  return parse(configPayloadSchema, input);
}

export function parseSub2ApiPoolPushPayload(input: unknown): ParseResult<Sub2ApiPoolPushPayload> {
  return parse(pushPayloadSchema, input);
}
