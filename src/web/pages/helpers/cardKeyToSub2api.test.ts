import { describe, expect, it } from 'vitest';
import { convertCardKeyExport, extractJwtClientId } from './cardKeyToSub2api.js';

function token(payload: object) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

describe('card key to sub2api conversion', () => {
  it('extracts client id and converts account fields', () => {
    const accessToken = token({ client_id: 'app_test' });
    const raw = `\uFEFF卡密导出\n${JSON.stringify({ exported_at: '2026-07-10T00:00:00Z', accounts: [{ name: 'Test', expires_at: 1784530952, credentials: { access_token: accessToken, email: 'a@example.com' }, extra: { batch_code: 'B1' } }] })}`;
    const result = convertCardKeyExport(raw);
    expect(extractJwtClientId(accessToken)).toBe('app_test');
    expect(result.outputAccounts).toBe(1);
    expect((result.output.accounts as any[])[0]).toMatchObject({
      name: 'Test', rate_multiplier: 1,
      credentials: { client_id: 'app_test', expires_at: 1784530952, refresh_token: '' },
      extra: { batch_code: 'B1', email: 'a@example.com', name: 'Test' },
    });
  });

  it('keeps the last duplicate and skips invalid lines in lenient mode', () => {
    const row = (name: string) => JSON.stringify({ accounts: [{ name, credentials: { chatgpt_user_id: 'same' } }] });
    const result = convertCardKeyExport(`${row('first')}\nnot-json\n${row('last')}`);
    expect(result.outputAccounts).toBe(1);
    expect((result.output.accounts as any[])[0].name).toBe('last');
    expect(result.issues).toHaveLength(2);
  });
});
