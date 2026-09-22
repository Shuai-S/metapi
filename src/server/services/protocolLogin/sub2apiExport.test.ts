import { describe, expect, it } from 'vitest';
import { buildSub2ApiV027ImportDocument, renderSub2ApiV027ImportJson } from './sub2apiExport.js';

describe('Sub2API v0.2.7 protocol-login export', () => {
  it('renders the native account document and preserves OAuth renewal fields', () => {
    const document = buildSub2ApiV027ImportDocument({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: 'id-token',
      accountId: 'account-id',
      email: 'user@example.com',
      workspaceId: 'workspace-id',
      planType: 'plus',
      expiresAt: '2026-12-31T00:00:00.000Z',
    }, {
      group: 'codex',
      concurrency: 3,
      priority: 2,
      rateMultiplier: 1.2,
      models: ['gpt-5', 'gpt-5', ''],
      exportedAt: new Date('2026-09-21T00:00:00.000Z'),
    });

    expect(document).toEqual({
      exported_at: '2026-09-21T00:00:00.000Z',
      proxies: [],
      accounts: [{
        name: 'user@example.com',
        platform: 'openai',
        type: 'oauth',
        group: 'codex',
        concurrency: 3,
        priority: 2,
        rate_multiplier: 1.2,
        credentials: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          id_token: 'id-token',
          account_id: 'account-id',
          chatgpt_account_id: 'account-id',
          email: 'user@example.com',
          workspace_id: 'workspace-id',
          expires_at: '2026-12-31T00:00:00.000Z',
          model_mapping: { 'gpt-5': 'gpt-5' },
        },
        extra: {
          email: 'user@example.com',
          source: 'protocol_login',
          last_refresh: '2026-09-21T00:00:00.000Z',
          plan_type: 'plus',
        },
      }],
    });
  });

  it('does not export a browser session token as refresh_token', () => {
    const json = renderSub2ApiV027ImportJson({ accessToken: 'access-token', email: 'user@example.com' });
    expect(json).not.toContain('session_token');
    expect(json).not.toContain('browser session');
  });

  it('rejects an empty access token', () => {
    expect(() => buildSub2ApiV027ImportDocument({ accessToken: '  ' })).toThrow('access_token');
  });
});

