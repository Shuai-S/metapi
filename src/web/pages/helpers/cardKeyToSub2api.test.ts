import { describe, expect, it } from 'vitest';
import { convertCardKeyExport, extractJwtClientId } from './cardKeyToSub2api.js';

function token(payload: object) {
  const encode = (value: object) => btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

describe('legacy card key converter entry point', () => {
  it('delegates old card-key envelopes to the shared Session converter', () => {
    const accessToken = token({ client_id: 'app_test' });
    const raw = `\uFEFF卡密导出\n${JSON.stringify({
      accounts: [{
        name: 'Test',
        expires_at: 1784530952,
        credentials: { access_token: accessToken, email: 'a@example.com' },
      }],
    })}`;
    const result = convertCardKeyExport(raw);
    expect(extractJwtClientId(accessToken)).toBe('app_test');
    expect(result.outputAccounts).toBe(1);
    expect((result.output.accounts as any[])[0]).toMatchObject({
      name: 'a@example.com',
      platform: 'openai',
      credentials: { access_token: accessToken, email: 'a@example.com' },
    });
  });
});
